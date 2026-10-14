import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
import { assert } from '../src/config.mjs';

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }
function has(name) { return process.argv.includes(name); }
function sha8(value) { return createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 8); }
function fmt(ts) { return ts ? new Date(ts * 1000).toISOString() : 'none/unknown'; }

async function masked(label) {
  assert(process.stdin.isTTY, 'Run in an interactive terminal or pass --user-token-file; never send tokens in chat');
  process.stderr.write(`${label}: `);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    function done(error) {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write('\n');
      error ? reject(error) : resolve(value.trim());
    }
    function onData(chunk) {
      for (const char of chunk.toString()) {
        if (char === '\u0003') { done(new Error('Cancelled')); return; }
        if (char === '\r' || char === '\n') { done(); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    }
    process.stdin.on('data', onData);
  });
}

async function graph(path, params) {
  const qs = new URLSearchParams(params);
  const r = await fetch(`https://graph.facebook.com/v25.0${path}?${qs.toString()}`, {signal: AbortSignal.timeout(20000)});
  const j = await r.json();
  if (!r.ok || j.error) {
    const e = j.error ?? {};
    throw new Error(`${path} failed: ${e.message ?? r.statusText} ${e.code ? `code=${e.code}` : ''}`.trim());
  }
  return j;
}

async function debugToken(inputToken, appToken) {
  const j = await graph('/debug_token', {input_token: inputToken, access_token: appToken});
  return j.data ?? {};
}

function setEnvValue(text, key, value) {
  assert(value && !/[\r\n]/.test(value), `Invalid ${key}`);
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(text)) return text.replace(re, line);
  return `${text.replace(/\s*$/, '\n')}${line}\n`;
}

function writeEnvAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  mkdirSync(dirname(file), {recursive: true, mode: 0o700});
  writeFileSync(tmp, text, {mode: 0o600});
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

try {
  const envFile = resolve(arg('--env') ?? '');
  assert(envFile && process.argv.includes('--env'), 'Usage: node scripts/exchange-meta-page-token.mjs --env /absolute/runtime/.env [--apply] [--user-token-file /private/token.txt] [--page-id 100505959659399]');
  const st = statSync(envFile);
  assert(st.isFile() && st.size < 32768, 'Invalid env file');
  if (process.platform !== 'win32') assert((st.mode & 0o077) === 0, 'env file must have mode 600');
  const original = readFileSync(envFile, 'utf8');
  const env = parseEnv(original);
  const appId = String(arg('--app-id') ?? env.META_APP_ID ?? env.PAGE_CSKH_APP_ID ?? '1760683462731771');
  const appSecret = String(arg('--app-secret') ?? env.META_APP_SECRET ?? '');
  const pageId = String(arg('--page-id') ?? env.PAGE_CSKH_PAGE_ID ?? '100505959659399');
  const pageName = String(arg('--page-name') ?? env.PAGE_CSKH_PAGE_NAME ?? 'TM Food');
  assert(appId && appSecret && pageId, 'Missing app id, app secret, or page id');

  let userToken = '';
  const tokenFile = arg('--user-token-file');
  if (tokenFile) userToken = readFileSync(resolve(tokenFile), 'utf8').trim();
  else userToken = await masked('Paste SHORT-LIVED USER token (input hidden)');
  assert(userToken.length >= 50, 'User token is missing/too short');
  const appToken = `${appId}|${appSecret}`;

  const before = await debugToken(userToken, appToken);
  assert(before.is_valid === true, 'Input token is not valid');
  assert(before.type === 'USER', `Input token must be USER; got ${before.type ?? 'unknown'}. Do not paste a Page token here.`);
  console.log(JSON.stringify({step: 'input_user_token', sha8: sha8(userToken), type: before.type, app_id: before.app_id, expires_at: fmt(before.expires_at)}, null, 2));

  const exchanged = await graph('/oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: userToken
  });
  const longUserToken = exchanged.access_token;
  assert(longUserToken && longUserToken.length >= 50, 'Meta did not return a long-lived user token');
  const longDebug = await debugToken(longUserToken, appToken);
  assert(longDebug.is_valid === true && longDebug.type === 'USER', 'Long-lived token is not a valid USER token');
  console.log(JSON.stringify({step: 'long_lived_user_token', sha8: sha8(longUserToken), type: longDebug.type, expires_at: fmt(longDebug.expires_at), data_access_expires_at: fmt(longDebug.data_access_expires_at)}, null, 2));

  const accounts = await graph('/me/accounts', {fields: 'id,name,access_token', access_token: longUserToken});
  const pages = Array.isArray(accounts.data) ? accounts.data : [];
  const page = pages.find(p => String(p.id) === pageId) ?? pages.find(p => String(p.name).toLowerCase() === pageName.toLowerCase());
  assert(page?.access_token, `Page ${pageId} / ${pageName} not found in /me/accounts. Found: ${pages.map(p => `${p.name}(${p.id})`).join(', ') || '(none)'}`);
  const pageToken = page.access_token;
  const pageDebug = await debugToken(pageToken, appToken);
  const scopes = pageDebug.scopes ?? [];
  const missing = ['pages_manage_posts', 'pages_read_engagement', 'pages_show_list'].filter(s => !scopes.includes(s));
  assert(pageDebug.is_valid === true, 'Page token is not valid');
  assert(pageDebug.type === 'PAGE', `Expected PAGE token; got ${pageDebug.type ?? 'unknown'}`);
  assert(String(pageDebug.profile_id) === pageId, `Page token profile_id ${pageDebug.profile_id ?? '(missing)'} does not match ${pageId}`);
  assert(missing.length === 0, `Page token missing permissions: ${missing.join(', ')}`);

  console.log(JSON.stringify({
    step: 'page_token',
    page_id: page.id,
    page_name: page.name,
    sha8: sha8(pageToken),
    type: pageDebug.type,
    profile_id: pageDebug.profile_id,
    expires_at: fmt(pageDebug.expires_at),
    data_access_expires_at: fmt(pageDebug.data_access_expires_at),
    required_missing: missing
  }, null, 2));

  if (!has('--apply')) {
    console.log(JSON.stringify({status: 'dry_run', message: 'Verified Page token. Re-run with --apply to write META_PAGE_PUBLISH_ACCESS_TOKEN.'}, null, 2));
    process.exit(0);
  }
  const updated = setEnvValue(original, 'META_PAGE_PUBLISH_ACCESS_TOKEN', pageToken);
  writeEnvAtomic(envFile, updated);
  console.log(JSON.stringify({status: 'updated', envFile, key: 'META_PAGE_PUBLISH_ACCESS_TOKEN', token_sha8: sha8(pageToken), mode: '600'}, null, 2));
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}

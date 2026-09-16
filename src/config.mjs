import { readFileSync, statSync, realpathSync } from 'node:fs';
import { resolve, dirname, isAbsolute, relative } from 'node:path';
import { parseEnv } from 'node:util';

export function assert(ok, message) { if (!ok) throw new Error(message); }
export function within(parent, child) {
  const r = relative(parent, child); return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}
export function loadConfig(file) {
  const c = JSON.parse(readFileSync(file, 'utf8'));
  assert(c.schemaVersion === 1, 'Unsupported config schema');
  assert(typeof c.pageId==='string' && typeof c.appId==='string' && /^\d+$/.test(c.pageId) && /^\d+$/.test(c.appId), 'Set pageId and appId as numeric strings');
  assert(/^[a-z][a-z0-9-]{0,47}$/.test(c.agentId) && c.agentId !== 'main', 'Use a dedicated agentId, not main');
  assert(typeof c.model === 'string' && c.model.includes('/') && !c.model.includes('REPLACE'), 'Select a configured provider/model');
  assert(/^v\d+\.\d+$/.test(c.graphVersion), 'Invalid graphVersion');
  assert(['draft','live'].includes(c.mode), 'mode must be draft or live');
  c.waitingResetSeconds ??= 0;
  c.enableHumanHandoff ??= true;
  assert(/^\/webhooks\/[a-z0-9/-]+$/.test(c.webhookPath), 'Invalid webhookPath');
  const u = new URL(c.publicWebhookUrl);
  assert(u.protocol === 'https:' && u.pathname === c.webhookPath && !u.search && !u.username && !u.password, 'Set HTTPS publicWebhookUrl matching webhookPath');
  assert(Number.isInteger(c.adminPort) && c.adminPort > 1024 && c.adminPort < 65536, 'Invalid adminPort');
  c.edgePort ??= 18892;
  assert(Number.isInteger(c.edgePort) && c.edgePort > 1024 && c.edgePort < 65536, 'Invalid edgePort');
  assert(c.edgePort !== c.adminPort, 'edgePort must differ from adminPort');
  for (const k of ['maxDailyAgentCalls','maxCustomerCallsPerHour','agentTimeoutMs']) assert(Number.isInteger(c[k]) && c[k] > 0, `Invalid ${k}`);
  assert(Number.isInteger(c.waitingResetSeconds) && c.waitingResetSeconds >= 0, 'Invalid waitingResetSeconds');
  assert(typeof c.enableHumanHandoff === 'boolean', 'Invalid enableHumanHandoff');
  assert(c.agentTimeoutMs <= 120000, 'agentTimeoutMs must be <= 120000');
  assert(Array.isArray(c.scopeKeywords) && c.scopeKeywords.length && c.scopeKeywords.every(x => typeof x === 'string' && x.trim()), 'scopeKeywords required');
  for (const k of ['pageName','scopeDescription','handoffText','outOfScopeText','clarifyText']) assert(typeof c[k] === 'string' && c[k].trim().length > 0 && c[k].length <= 3000, `Invalid ${k}`);
  for (const k of ['envFile','database','workspace','knowledgeFile']) {
    assert(typeof c[k] === 'string' && c[k], `${k} required`);
    c[k] = resolve(dirname(resolve(file)), c[k]);
  }
  assert(!within(c.workspace, c.envFile) && !within(c.workspace, c.database), 'Secrets/database must be outside agent workspace');
  return c;
}

function parseBool(value, name) {
  if (['true','1','yes','on'].includes(value)) return true;
  if (['false','0','no','off'].includes(value)) return false;
  throw new Error(`${name} must be true/false`);
}

function envText(env, name, fallback) {
  const value = env[name] ?? fallback;
  assert(typeof value === 'string' && value.trim(), `${name} required`);
  return value.trim();
}
function envOptionalText(env, name, fallback) {
  const value = env[name] ?? fallback;
  return typeof value === 'string' ? value.trim() : value;
}
function envInt(env, name, fallback) {
  const raw = env[name] ?? String(fallback);
  const value = Number(raw);
  assert(Number.isInteger(value), `${name} must be an integer`);
  return value;
}
function envCsv(env, name, fallback) {
  const raw = env[name] ?? fallback;
  const values = String(raw).split(',').map(x => x.trim()).filter(Boolean);
  assert(values.length > 0, `${name} must contain at least one value`);
  return values;
}

export function runtimeConfigFromEnv(env) {
  const pageId = envText(env, 'PAGE_CSKH_PAGE_ID');
  const webhookPath = envText(env, 'PAGE_CSKH_WEBHOOK_PATH', '/webhooks/page-cskh');
  const mode = envText(env, 'PAGE_CSKH_MODE', 'draft');
  assert(['draft','live'].includes(mode), 'PAGE_CSKH_MODE must be draft or live');
  const graphVersion = envText(env, 'PAGE_CSKH_GRAPH_VERSION', 'v25.0');
  const enableHumanHandoff = parseBool(envText(env, 'PAGE_CSKH_ENABLE_HUMAN_HANDOFF', 'true').toLowerCase(), 'PAGE_CSKH_ENABLE_HUMAN_HANDOFF');
  const database = envOptionalText(env, 'PAGE_CSKH_DATABASE', `./data/page-${pageId}.sqlite`);
  return {
    schemaVersion: 1,
    pageId,
    appId: envText(env, 'PAGE_CSKH_APP_ID'),
    pageName: envText(env, 'PAGE_CSKH_PAGE_NAME'),
    agentId: envText(env, 'PAGE_CSKH_AGENT_ID', 'page-cskh'),
    model: envText(env, 'PAGE_CSKH_MODEL'),
    graphVersion,
    envFile: envOptionalText(env, 'PAGE_CSKH_ENV_FILE', './.env'),
    database,
    workspace: envOptionalText(env, 'PAGE_CSKH_WORKSPACE', './agent'),
    knowledgeFile: envOptionalText(env, 'PAGE_CSKH_KNOWLEDGE_FILE', './knowledge.json'),
    webhookPath,
    publicWebhookUrl: envText(env, 'PAGE_CSKH_PUBLIC_WEBHOOK_URL'),
    adminPort: envInt(env, 'PAGE_CSKH_ADMIN_PORT', 18891),
    edgePort: envInt(env, 'PAGE_CSKH_EDGE_PORT', 18892),
    mode,
    waitingResetSeconds: envInt(env, 'PAGE_CSKH_WAITING_RESET_SECONDS', 0),
    enableHumanHandoff,
    scopeDescription: envText(env, 'PAGE_CSKH_SCOPE_DESCRIPTION', 'Chỉ tư vấn dịch vụ, sản phẩm và chính sách của Page này.'),
    scopeKeywords: envCsv(env, 'PAGE_CSKH_SCOPE_KEYWORDS', 'đặt hàng,giá,sản phẩm,chính sách'),
    handoffText: envText(env, 'PAGE_CSKH_HANDOFF_TEXT', 'Em chuyển nhân viên hỗ trợ tiếp nhé.'),
    outOfScopeText: envText(env, 'PAGE_CSKH_OUT_OF_SCOPE_TEXT', 'Em chỉ hỗ trợ thông tin dịch vụ và sản phẩm của Page này ạ.'),
    clarifyText: envText(env, 'PAGE_CSKH_CLARIFY_TEXT', 'Anh/chị muốn tìm hiểu sản phẩm hoặc dịch vụ nào của bên em ạ?'),
    maxDailyAgentCalls: envInt(env, 'PAGE_CSKH_MAX_DAILY_AGENT_CALLS', 200),
    maxCustomerCallsPerHour: envInt(env, 'PAGE_CSKH_MAX_CUSTOMER_CALLS_PER_HOUR', 20),
    agentTimeoutMs: envInt(env, 'PAGE_CSKH_AGENT_TIMEOUT_MS', 45000)
  };
}

export function applyEnvOverrides(config, env) {
  const c = {...config};
  if (env.PAGE_CSKH_MODE) {
    assert(['draft','live'].includes(env.PAGE_CSKH_MODE), 'PAGE_CSKH_MODE must be draft or live');
    c.mode = env.PAGE_CSKH_MODE;
  }
  if (env.PAGE_CSKH_WAITING_RESET_SECONDS) {
    const n = Number(env.PAGE_CSKH_WAITING_RESET_SECONDS);
    assert(Number.isInteger(n) && n >= 0, 'PAGE_CSKH_WAITING_RESET_SECONDS must be an integer >= 0');
    c.waitingResetSeconds = n;
  }
  if (env.PAGE_CSKH_ENABLE_HUMAN_HANDOFF) {
    c.enableHumanHandoff = parseBool(env.PAGE_CSKH_ENABLE_HUMAN_HANDOFF.toLowerCase(), 'PAGE_CSKH_ENABLE_HUMAN_HANDOFF');
  }
  return c;
}

export function loadSecrets(file, workspace) {
  const st = statSync(file);
  assert(st.isFile() && st.size < 32768, 'Invalid env file');
  if (process.platform !== 'win32') assert((st.mode & 0o077) === 0, 'env file must have mode 600');
  if (workspace) assert(!within(realpathSync(workspace), realpathSync(file)), 'env must not resolve inside agent workspace');
  const env = parseEnv(readFileSync(file,'utf8'));
  for (const k of ['META_APP_SECRET','META_WEBHOOK_VERIFY_TOKEN','META_PAGE_ACCESS_TOKEN','CSKH_ADMIN_TOKEN']) assert(typeof env[k] === 'string' && env[k].length >= 16, `Missing/short ${k}`);
  assert(env.CSKH_ADMIN_TOKEN.length >= 32, 'CSKH_ADMIN_TOKEN needs >=32 characters');
  return Object.freeze(env);
}

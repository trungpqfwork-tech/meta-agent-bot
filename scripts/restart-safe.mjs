#!/usr/bin/env node
// Restart the Page CSKH service only when it is idle.
//
// A restart kills the worker mid-job: the job is marked `cancelled` with
// `ownership_changed` and the customer never gets a reply, and there is no
// replay path. On 2026-10-01 a restart dropped a live customer question
// ("Cắt khúc thì thế nào em?") exactly this way. So this script refuses to
// restart while a job is in flight and waits for it to drain first.
//
// Usage:
//   node scripts/restart-safe.mjs --config /path/runtime/config.json
//   node scripts/restart-safe.mjs --config ... --wait 180
//   node scripts/restart-safe.mjs --config ... --force     # skip the idle gate
//   node scripts/restart-safe.mjs --config ... --dry-run    # check only
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
};
const has = name => process.argv.includes(name);

// A job is finished once it reaches one of these states.
const TERMINAL_JOB = new Set(['sent', 'cancelled', 'failed', 'blocked', 'draft']);
const TERMINAL_OUTBOX = new Set(['sent', 'cancelled', 'failed', 'blocked_window', 'blocked', 'draft', 'ready']);
// No legitimate job runs longer than the agent timeout plus a couple of model
// calls; anything older than this is a leftover row, not live work.
const STALE_MS = 10 * 60 * 1000;

const configPath = resolve(arg('--config', ''));
if(!arg('--config')) {
  console.error('Usage: node scripts/restart-safe.mjs --config /path/runtime/config.json [--wait 120] [--force] [--dry-run]');
  process.exit(2);
}
const waitMs = Number(arg('--wait', '120')) * 1000;
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const runtimeDir = dirname(configPath);
const dbPath = resolve(runtimeDir, config.database ?? './data/page-cskh.sqlite');
const pm2Name = config.agentId ?? 'page-cskh';

function inFlight() {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const cutoff = Date.now() - STALE_MS;
    const jobs = db.prepare('SELECT id,psid,text,status,created FROM jobs').all()
      .filter(j => !TERMINAL_JOB.has(j.status) && Number(j.created) > cutoff);
    const outbox = db.prepare('SELECT o.job_id,o.status,j.created FROM outbox o LEFT JOIN jobs j ON j.id=o.job_id').all()
      .filter(o => !TERMINAL_OUTBOX.has(o.status) && Number(o.created ?? 0) > cutoff);
    const conversations = db.prepare('SELECT psid,state FROM conversations WHERE state<>?').all('BOT');
    return { jobs, outbox, conversations };
  } finally {
    db.close();
  }
}

function describe({ jobs, outbox, conversations }) {
  const parts = [];
  if(jobs.length) parts.push(`${jobs.length} job đang xử lý (${jobs.map(j => j.status).join(', ')})`);
  if(outbox.length) parts.push(`${outbox.length} outbox chưa gửi xong`);
  if(conversations.length) parts.push(`${conversations.length} hội thoại không ở BOT (${conversations.map(c => c.state).join(', ')})`);
  return parts.join(' | ');
}

const deadline = Date.now() + waitMs;
let state = inFlight();
const busy = () => state.jobs.length > 0 || state.outbox.length > 0;

if(busy()) {
  console.log(`Bận: ${describe(state)} -> chờ tối đa ${waitMs / 1000}s cho job xong`);
  while(busy() && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));
    state = inFlight();
  }
}

if(busy()) {
  console.error(`\nVẪN BẬN sau khi chờ: ${describe(state)}`);
  if(!has('--force')) {
    console.error('KHÔNG restart. Job đang chạy mà restart sẽ làm rơi tin của khách và không replay được.');
    console.error('Chạy lại sau, hoặc dùng --force nếu bạn chấp nhận mất job đó.');
    process.exit(1);
  }
  console.error('--force: vẫn restart theo yêu cầu, job đang chạy SẼ MẤT.');
} else {
  console.log('Rảnh: không có job nào đang xử lý.');
}
if(state.conversations.length) {
  console.log(`Lưu ý: ${state.conversations.length} hội thoại không ở BOT (${state.conversations.map(c => c.psid + '=' + c.state).join(', ')}) — restart không ảnh hưởng, nhưng bot sẽ không trả lời các hội thoại đó.`);
}
if(has('--dry-run')) {
  console.log('--dry-run: chỉ kiểm tra, không restart.');
  process.exit(0);
}

console.log(`\nRestart ${pm2Name} ...`);
const r = spawnSync('pm2', ['restart', pm2Name, '--update-env'], { encoding: 'utf8' });
if(r.error || r.status !== 0) {
  console.error('Restart thất bại. Kiểm tra pm2 có trên PATH (trên host dạng volume: $HOME/.hermes/tools/bin).');
  console.error(String(r.stderr || r.error?.message || '').slice(0, 400));
  process.exit(1);
}

// Wait for the service to answer its own admin endpoint again.
const env = Object.fromEntries(readFileSync(resolve(runtimeDir, config.envFile ?? '.env'), 'utf8')
  .split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#'))
  .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const deadlineBoot = Date.now() + 40000;
let status = null;
while(Date.now() < deadlineBoot) {
  try {
    const res = await fetch(`http://127.0.0.1:${config.adminPort}/status`, {
      headers: { Authorization: `Bearer ${env.CSKH_ADMIN_TOKEN}` }, signal: AbortSignal.timeout(4000),
    });
    if(res.ok) { status = await res.json(); break; }
  } catch {}
  await new Promise(r => setTimeout(r, 2000));
}
if(!status) {
  console.error('Restart đã chạy nhưng service chưa trả lời /status sau 40s. Kiểm tra: pm2 logs ' + pm2Name);
  process.exit(1);
}
const pending = status.conversations?.filter(c => c.state !== 'BOT') ?? [];
console.log(`Service đã lên: mode=${status.mode} pageId=${status.pageId} hội thoại=${status.conversations?.length ?? 0} (không ở BOT: ${pending.length})`);
console.log('Restart an toàn xong.');

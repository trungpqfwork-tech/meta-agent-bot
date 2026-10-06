#!/usr/bin/env node
// Bật lại bot cho mọi hội thoại đang ở trạng thái HUMAN.
//
// Khi nhân viên trả lời trực tiếp trên Page, hệ thống chuyển hội thoại sang HUMAN
// và bot im lặng cho tới khi có người `resume`. Lệnh này làm việc đó cho TẤT CẢ
// hội thoại đang HUMAN (dùng cho lịch chạy mỗi sáng, khi không còn ai trực).
//
// Mặc định IM LẶNG khi không có hội thoại nào (để lịch chạy không nhắn gì);
// dùng --verbose để luôn in kết quả.
import { DatabaseSync } from 'node:sqlite';
import { loadConfig, loadSecrets } from '../src/config.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const configFile = arg('--config', '');
const verbose = args.includes('--verbose');
if (!configFile) {
  console.error('Dùng: node scripts/resume-human.mjs --config /đường/dẫn/config.json [--verbose]');
  process.exit(2);
}

const c = loadConfig(configFile);
const s = loadSecrets(c.envFile, c.workspace);
const db = new DatabaseSync(c.database, { readOnly: true });
const rows = db.prepare("SELECT psid,reason FROM conversations WHERE state='HUMAN' ORDER BY last_customer DESC").all();
db.close();

if (!rows.length) {
  if (verbose) console.log('Không có hội thoại nào đang ở trạng thái HUMAN.');
  process.exit(0);
}

const done = [], skipped = [];
for (const row of rows) {
  try {
    const r = await fetch(`http://127.0.0.1:${c.adminPort}/resume`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.CSKH_ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ psid: row.psid }),
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) done.push(row.psid);
    else skipped.push(`${row.psid} (${r.status})`);
  } catch (e) {
    skipped.push(`${row.psid} (${e.message})`);
  }
}

const lines = [];
if (done.length) lines.push(`Đã bật lại bot cho ${done.length} hội thoại: ${done.join(', ')}`);
if (skipped.length) lines.push(`Không bật được ${skipped.length} hội thoại: ${skipped.join(', ')}`);
if (lines.length) console.log(lines.join('\n'));
else if (verbose) console.log('Không bật được hội thoại nào.');
// Thoát khác 0 nếu có hội thoại không bật được: lịch chạy sẽ báo lỗi để không hỏng im lặng.
process.exit(skipped.length ? 1 : 0);

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';

function store(t) {
  const dir = mkdtempSync(join(tmpdir(), 'page-cskh-human-'));
  const s = new Store(join(dir, 'state.sqlite'), '100');
  t.after(() => { s.close(); rmSync(dir, { recursive: true, force: true }); });
  return s;
}
const inbound = (psid, id, text) => ({ psid, id, kind: 'customer', text, at: Date.now() });
const echo = (psid, id, text) => ({ psid, id, kind: 'echo', mid: `m_${id}`, text, at: Date.now() });

// Đẩy mốc thời gian của lần nhân viên nhắn về quá khứ, để mô phỏng "đã im lặng N giây".
function backdateHuman(s, psid, seconds) {
  s.db.prepare("UPDATE audit SET at=? WHERE psid=? AND action='HUMAN'").run(Date.now() - seconds * 1000, psid);
}

test('nhân viên im lặng 5 phút thì bot tự trả lời lại', t => {
  const s = store(t);
  s.ingest([echo('111', 'e1', 'Dạ em kiểm tra giúp anh')], {});
  assert.equal(s.conversation('111').state, 'HUMAN', 'nhân viên nhắn -> HUMAN');

  assert.equal(s.autoResumeIdleHuman(300), 0, 'chưa đủ 5 phút thì chưa bật lại');
  backdateHuman(s, '111', 301);
  assert.equal(s.autoResumeIdleHuman(300), 1, 'quá 5 phút thì bật lại');
  assert.equal(s.conversation('111').state, 'BOT');
  assert.equal(s.conversation('111').reason, 'auto_human_idle_reset');
});

test('khách nhắn trong lúc HUMAN thì không tạo job, sau khi bật lại mới trả lời', t => {
  const s = store(t);
  s.ingest([echo('111', 'e1', 'Dạ em kiểm tra giúp anh')], {});
  s.ingest([inbound('111', 'c1', 'Cho anh hỏi giá')], {});
  assert.equal(s.next(), null, 'HUMAN thì bot không nhận việc');
  backdateHuman(s, '111', 301);
  s.autoResumeIdleHuman(300);
  s.ingest([inbound('111', 'c2', 'Cho anh hỏi giá')], {});
  assert.ok(s.next(), 'về BOT thì bot nhận việc trở lại');
});

test('KHÔNG tự bật lại hội thoại do người vận hành cố ý takeover', t => {
  const s = store(t);
  s.ingest([inbound('111', 'c1', 'chào em')], {});
  s.takeover('111');
  backdateHuman(s, '111', 3600);
  assert.equal(s.autoResumeIdleHuman(300), 0, 'takeover là quyết định của người vận hành');
  assert.equal(s.conversation('111').state, 'HUMAN');
});

test('đang vướng gửi tin mơ hồ thì chưa bật lại', t => {
  const s = store(t);
  s.ingest([echo('111', 'e1', 'Dạ em kiểm tra giúp anh')], {});
  backdateHuman(s, '111', 301);
  s.db.prepare("INSERT INTO outbox(job_id,psid,text,status,source_ids) VALUES ('j1','111','x','unknown','[]')").run();
  assert.equal(s.autoResumeIdleHuman(300), 0, 'phải đối soát xong mới bật lại');
  s.db.prepare("UPDATE outbox SET status='confirmed_sent' WHERE job_id='j1'").run();
  assert.equal(s.autoResumeIdleHuman(300), 1);
});

test('tắt bằng 0 thì không bao giờ tự bật lại', t => {
  const s = store(t);
  s.ingest([echo('111', 'e1', 'Dạ em kiểm tra giúp anh')], {});
  backdateHuman(s, '111', 86400);
  assert.equal(s.autoResumeIdleHuman(0), 0);
  assert.equal(s.conversation('111').state, 'HUMAN');
});

test('hội thoại WAITING vẫn theo luật 300s riêng, không lẫn với HUMAN', t => {
  const s = store(t);
  s.ingest([inbound('111', 'c1', 'chào em')], {});
  s.hold('111', 'WAITING', 'handoff_test');
  // Luật WAITING đếm theo mốc audit 'WAITING', không phải 'HUMAN'.
  s.db.prepare("UPDATE audit SET at=? WHERE psid=? AND action='WAITING'").run(Date.now() - 301 * 1000, '111');
  assert.equal(s.autoResumeIdleHuman(300), 0, 'WAITING không thuộc luật HUMAN');
  assert.equal(s.autoResumeExpiredWaiting(300), 1, 'WAITING tự về BOT theo luật của nó');
  assert.equal(s.conversation('111').state, 'BOT');
});

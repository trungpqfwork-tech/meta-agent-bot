import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Worker } from '../src/worker.mjs';
import { agentPolicy } from '../src/knowledge.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'page-cskh-infra-'));
  const c = {
    ...JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url))),
    pageId: '100', appId: '200', model: 'provider/model', mode: 'live',
    workspace: join(dir, 'agent'), envFile: join(dir, '.env'),
    database: join(dir, 'data/state.sqlite'), knowledgeFile: join(dir, 'knowledge.json'),
    imageCatalogFile: join(dir, 'images/catalog.json'), messageDebounceSeconds: 0,
  };
  mkdirSync(c.workspace); mkdirSync(join(dir, 'images'));
  writeFileSync(c.envFile, 'META_PAGE_ACCESS_TOKEN=' + 'p'.repeat(32) + '\n', { mode: 0o600 });
  writeFileSync(c.knowledgeFile, JSON.stringify({
    schemaVersion: 1,
    documents: [{ id: 'product-ba-chi-bo', title: 'Ba chỉ bò', keywords: ['ba chỉ bò', 'bò'], content: 'Ba chỉ bò 140.000đ/kg', approved: true, validUntil: null }],
  }));
  writeFileSync(c.imageCatalogFile, JSON.stringify({ schemaVersion: 1, images: [] }));
  const s = new Store(c.database, c.pageId);
  t.after(() => { s.close(); rmSync(dir, { recursive: true, force: true }); });
  return { c, s };
}
const inbound = (psid, id, text) => ({ psid, id, kind: 'customer', text, at: Date.now() });

test('model treo/timeout thì thử lại, KHÔNG chuyển nhân viên', async t => {
  const { c, s } = fixture(t);
  let calls = 0;
  const w = new Worker(c, s, async () => { calls++; throw new Error('Hermes completion timed out'); },
    { send: async () => 'mid', senderAction: async () => true });

  s.ingest([inbound('111', 'm1', 'Ba chỉ bò giá bao nhiêu?')], c);
  const j = s.next();
  await w.process(j);

  const job = s.snapshot().jobs[0];
  assert.equal(job.status, 'pending', `lỗi hạ tầng phải đưa job về hàng đợi, nhận ${job.status}`);
  assert.equal(job.reason, 'infra_retry_after_answer');
  assert.equal(s.conversation('111').state, 'BOT', 'không được chuyển hội thoại sang WAITING/HUMAN');
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM outbox').get().n, 0, 'chưa được gửi gì cho khách');
  assert.ok(calls >= 1, `mỗi lượt thử đều gọi model, nhận ${calls}`);
});

test('thử lại quá trần (2 lần) mới chuyển nhân viên', async t => {
  const { c, s } = fixture(t);
  let calls = 0;
  const w = new Worker(c, s, async () => { calls++; throw new Error('Hermes completion timed out'); },
    { send: async () => 'mid', senderAction: async () => true });

  s.ingest([inbound('111', 'm1', 'Ba chỉ bò giá bao nhiêu?')], c);
  for (let i = 0; i < 3; i++) {
    const j = s.db.prepare("SELECT * FROM jobs WHERE psid=? AND status='pending' ORDER BY created LIMIT 1").get('111');
    if (!j) break;
    s.db.prepare("UPDATE jobs SET status='processing' WHERE id=?").run(j.id);
    await w.process({ ...j, status: 'processing' });
  }
  const job = s.snapshot().jobs[0];
  const requeues = s.db.prepare("SELECT COUNT(*) n FROM audit WHERE action='job_requeue'").get().n;
  assert.equal(requeues, 2, `phải thử lại đúng 2 lần trước khi bỏ, nhận ${requeues}`);
  assert.equal(job.status, 'sent', 'hết lượt thử thì handoff và gửi tin xin lỗi');
  assert.equal(s.conversation('111').state, 'WAITING');
  assert.ok(calls >= 3, `mỗi lượt thử đều gọi model, nhận ${calls}`);
});

test('trả lời bình thường vẫn đi thẳng, không bị ảnh hưởng', async t => {
  const { c, s } = fixture(t);
  const w = new Worker(c, s, async p => {
    if (p.system === agentPolicy) return JSON.stringify({ action: 'reply', text: 'Ba chỉ bò 140.000đ/kg ạ.', sourceIds: ['product-ba-chi-bo'] });
    if (/bộ kiểm tra/.test(p.system)) return '{"inScope":true,"supported":true}';
    return JSON.stringify({ inScope: true, supported: true, wantsOrder: false, san_pham: ['ba chỉ bò'], nhom: ['bò'], y_dinh: 'hỏi giá', nhom_khach: 'personal', chinh_sach: ['giá'] });
  }, { send: async () => 'mid', senderAction: async () => true });
  s.ingest([inbound('111', 'm1', 'Ba chỉ bò giá bao nhiêu?')], c);
  await w.process(s.next());
  assert.equal(s.snapshot().jobs[0].status, 'sent');
});

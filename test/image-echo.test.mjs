import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Worker } from '../src/worker.mjs';
import { agentPolicy } from '../src/knowledge.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'page-cskh-echo-'));
  const c = {
    ...JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url))),
    pageId: '100', appId: '200', model: 'provider/model', mode: 'live',
    workspace: join(dir, 'agent'), envFile: join(dir, '.env'),
    database: join(dir, 'data/state.sqlite'), knowledgeFile: join(dir, 'knowledge.json'),
    imageCatalogFile: join(dir, 'images/catalog.json'), messageDebounceSeconds: 0,
    publicWebhookUrl: '',
  };
  mkdirSync(c.workspace); mkdirSync(join(dir, 'images'));
  writeFileSync(c.envFile, 'META_PAGE_ACCESS_TOKEN=' + 'p'.repeat(32) + '\n', { mode: 0o600 });
  writeFileSync(c.knowledgeFile, JSON.stringify({
    schemaVersion: 1,
    documents: [{ id: 'product-duoi-heo', title: 'Đuôi heo', keywords: ['đuôi heo', 'đuôi'], content: 'Đuôi heo', approved: true, validUntil: null }],
  }));
  writeFileSync(c.imageCatalogFile, JSON.stringify({
    schemaVersion: 1,
    images: [{ id: 'duoi-heo-1', title: 'Đuôi heo', keywords: ['đuôi heo'], caption: 'Đuôi heo', file: 'duoi-heo-1.jpg', approved: true }],
  }));
  writeFileSync(join(dir, 'images/duoi-heo-1.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const s = new Store(c.database, c.pageId);
  t.after(() => { s.close(); rmSync(dir, { recursive: true, force: true }); });
  return { c, s };
}

const inbound = (psid, id, text) => ({ psid, id, kind: 'customer', text, at: Date.now() });
// Echo là tin do Page gửi ra; phân biệt bằng mid.
const echo = (psid, id, mid) => ({ psid, id, kind: 'echo', mid, text: '', at: Date.now() });

test('echo của ẢNH bot tự gửi được nhận diện là của bot, không chuyển HUMAN', t => {
  const s = fixture(t).s;
  s.ingest([inbound('111', 'c1', 'cho xin ảnh đuôi heo')], {});
  assert.equal(s.conversation('111').state, 'BOT');

  // Bot gửi ảnh -> ghi dấu vết mid
  s.sentImage('111', 'm_img_1');
  s.ingest([echo('111', 'e1', 'm_img_1')], {});
  assert.equal(s.conversation('111').state, 'BOT', 'echo ảnh của bot KHÔNG được chuyển hội thoại sang HUMAN');
  assert.equal(s.history('111').filter(x => x.kind === 'bot_echo').length, 0, 'dấu vết ảnh không lọt vào history');
});

test('echo của người thật gửi từ Page vẫn chuyển HUMAN (giữ nguyên hành vi cũ)', t => {
  const s = fixture(t).s;
  s.ingest([inbound('111', 'c1', 'cho xin ảnh đuôi heo')], {});
  s.ingest([echo('111', 'e1', 'm_nguoi_that')], {});
  assert.equal(s.conversation('111').state, 'HUMAN', 'người lạ nhắn từ Page thì bot phải nhường');
  assert.equal(s.conversation('111').reason, 'external_page_message');
});

test('echo của tin CHỮ bot gửi vẫn nhận diện đúng như trước', t => {
  const s = fixture(t).s;
  s.ingest([inbound('111', 'c1', 'chào em')], {});
  const j = s.next();
  s.prepare(j, 'Dạ em chào anh ạ.', []);
  s.sent(j, 'm_text_1', 'Dạ em chào anh ạ.');
  s.ingest([echo('111', 'e1', 'm_text_1')], {});
  assert.equal(s.conversation('111').state, 'BOT');
});

test('gửi ảnh xong, khách nhắn tiếp thì bot vẫn trả lời (không bị câm 5 phút)', async t => {
  const { c, s } = fixture(t);
  const w = new Worker(c, s, async p => {
    const m = JSON.parse(p.message);
    if (p.system === agentPolicy) return JSON.stringify({ action: 'reply', text: 'Em gửi ảnh Đuôi heo ạ.', sourceIds: ['product-duoi-heo'], imageIds: (m.images ?? []).map(i => i.id) });
    if (/bộ kiểm tra/.test(p.system)) return '{"inScope":true,"supported":true}';
    return JSON.stringify({ inScope: true, supported: true, wantsOrder: false, san_pham: [], nhom: [], y_dinh: 'khác', nhom_khach: null, chinh_sach: [] });
  }, {
    send: async () => 'm_text_1', senderAction: async () => true,
    uploadAttachment: async () => 'att-1', sendImage: async () => 'm_img_1',
  });

  s.ingest([inbound('111', 'c1', 'cho xin ảnh đuôi heo')], c);
  await w.process(s.next());

  // Meta gửi echo của tin chữ + của ảnh về webhook
  s.ingest([echo('111', 'e1', 'm_text_1')], c);
  s.ingest([echo('111', 'e2', 'm_img_1')], c);
  assert.equal(s.conversation('111').state, 'BOT', 'sau khi gửi ảnh, bot phải vẫn ở trạng thái BOT');

  s.ingest([inbound('111', 'c2', 'cho anh xin ảnh cá hồi cắt khúc')], c);
  assert.ok(s.next(), 'khách nhắn tiếp phải có job — trước đây bị câm vì HUMAN oan');
});

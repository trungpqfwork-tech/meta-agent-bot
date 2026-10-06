import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Worker } from '../src/worker.mjs';
import { agentPolicy, validateAnswer } from '../src/knowledge.mjs';
import { imageFilePath, loadAttachmentCache } from '../src/images.mjs';

function fixture(t, mode = 'live') {
  const dir = mkdtempSync(join(tmpdir(), 'page-cskh-images-'));
  const c = {
    ...JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url))),
    pageId: '100', appId: '200', model: 'provider/model', mode,
    workspace: join(dir, 'agent'), envFile: join(dir, '.env'),
    database: join(dir, 'data/state.sqlite'), knowledgeFile: join(dir, 'knowledge.json'),
    imageCatalogFile: join(dir, 'images/catalog.json'), messageDebounceSeconds: 0,
  };
  mkdirSync(c.workspace);
  mkdirSync(join(dir, 'images'));
  writeFileSync(c.envFile, 'META_PAGE_ACCESS_TOKEN=' + 'p'.repeat(32) + '\n', { mode: 0o600 });
  writeFileSync(c.knowledgeFile, JSON.stringify({
    schemaVersion: 1,
    documents: [{ id: 'product-duoi-heo', title: 'Đuôi heo', keywords: ['đuôi heo', 'đuôi'], content: 'Đuôi heo: chỉ bán buôn', approved: true, validUntil: null }],
  }));
  writeFileSync(c.imageCatalogFile, JSON.stringify({
    schemaVersion: 1,
    images: [
      { id: 'duoi-heo-1', title: 'Đuôi heo', keywords: ['đuôi heo', 'đuôi'], caption: 'Đuôi heo', file: 'duoi-heo-1.jpg', approved: true },
      { id: 'duoi-heo-2', title: 'Đuôi heo', keywords: ['đuôi heo', 'đuôi'], caption: 'Đuôi heo', file: 'duoi-heo-2.jpg', approved: true },
      { id: 'duoi-heo-3', title: 'Đuôi heo', keywords: ['đuôi heo', 'đuôi'], caption: 'Đuôi heo', file: 'thieu-file.jpg', approved: true },
      { id: 'chua-duyet', title: 'Đuôi heo nháp', keywords: ['đuôi heo', 'đuôi'], caption: 'Đuôi heo', file: 'x.jpg', approved: false },
    ],
  }));
  writeFileSync(join(dir, 'images/duoi-heo-1.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  writeFileSync(join(dir, 'images/duoi-heo-2.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const s = new Store(c.database, c.pageId);
  t.after(() => { s.close(); rmSync(dir, { recursive: true, force: true }); });
  return { c, s, dir };
}
const inbound = (psid, id, text) => ({ psid, id, kind: 'customer', text, at: Date.now() });

test('validateAnswer chỉ nhận id ảnh có trong lượt này', () => {
  const docs = [{ id: 'product-duoi-heo' }];
  const images = [{ id: 'duoi-heo-1' }, { id: 'duoi-heo-2' }];
  const raw = JSON.stringify({ action: 'reply', text: 'Em gửi ảnh đuôi heo ạ.', sourceIds: ['product-duoi-heo'], imageIds: ['duoi-heo-1', 'bịa-id', 'chua-duyet', 'duoi-heo-2'] });
  const a = validateAnswer(raw, docs, images);
  assert.deepEqual(a.imageIds, ['duoi-heo-1', 'duoi-heo-2'], 'id bịa hoặc chưa duyệt phải bị loại');
});

test('validateAnswer không có imageIds thì trả rỗng, không lỗi', () => {
  const a = validateAnswer(JSON.stringify({ action: 'reply', text: 'Dạ.', sourceIds: ['product-duoi-heo'] }), [{ id: 'product-duoi-heo' }], []);
  assert.deepEqual(a.imageIds, []);
});

test('imageFilePath chỉ dùng tên file, chặn đi ra ngoài thư mục ảnh', () => {
  assert.equal(imageFilePath('/rt', { file: 'a.jpg' }), '/rt/images/a.jpg');
  // basename() gọt mọi đường dẫn: không thể trỏ ra ngoài runtime/images.
  assert.equal(imageFilePath('/rt', { file: '/etc/passwd' }), '/rt/images/passwd');
  assert.equal(imageFilePath('/rt', { file: '../../.env' }), null, 'tên file ẩn bị từ chối');
  assert.equal(imageFilePath('/rt', { file: '' }), null);
  assert.equal(imageFilePath('/rt', {}), null);
  assert.equal(imageFilePath('/rt', { file: '..' }), null);
});

test('khách xin ảnh thì gửi tin nhắn trước, rồi gửi ảnh đã duyệt', async t => {
  const { c, s } = fixture(t);
  const sentText = [], sentImages = [], uploaded = [];
  const w = new Worker(c, s, async p => {
    const m = JSON.parse(p.message);
    if (p.system === agentPolicy) {
      return JSON.stringify({ action: 'reply', text: 'Em gửi anh/chị ảnh Đuôi heo ạ.', sourceIds: ['product-duoi-heo'], imageIds: (m.images ?? []).map(i => i.id) });
    }
    if (/bộ kiểm tra/.test(p.system)) return '{"inScope":true,"supported":true}';
    return JSON.stringify({ inScope: true, supported: true, wantsOrder: false, san_pham: [], nhom: [], y_dinh: 'khác', nhom_khach: null, chinh_sach: [] });
  }, {
    send: async (psid, text) => { sentText.push([psid, text]); return 'mid-text'; },
    senderAction: async () => true,
    uploadAttachment: async f => { uploaded.push(f); return 'att-1'; },
    sendImage: async (psid, payload) => { sentImages.push([psid, payload]); return 'mid-img'; },
  });

  s.ingest([inbound('111', 'm1', 'Cho anh xin ảnh đuôi heo')], c);
  const j = s.next();
  assert.ok(j, 'phải có job');
  await w.process(j);

  assert.equal(sentText.length, 1, 'gửi đúng 1 tin nhắn chữ');
  assert.equal(sentImages.length, 2, '2 ảnh có file được gửi; ảnh thiếu file bị bỏ qua');
  assert.ok(sentImages.every(([psid]) => psid === '111'), 'người nhận lấy từ job đã lưu');
  assert.deepEqual(sentImages.map(([, p]) => p), [{ attachment_id: 'att-1' }, { attachment_id: 'att-1' }]);
  assert.equal(uploaded.length, 2, 'mỗi file tải lên Meta đúng 1 lần');
  assert.equal(s.snapshot().jobs[0].status, 'sent', 'job vẫn sent dù 1 ảnh lỗi');
  const cache = loadAttachmentCache(c.knowledgeFile.replace('knowledge.json', ''));
  assert.equal(cache['duoi-heo-1.jpg'], 'att-1', 'attachment_id được nhớ lại');
  assert.equal(cache['duoi-heo-2.jpg'], 'att-1', 'ảnh thứ hai cũng được nhớ');
  assert.ok(!('thieu-file.jpg' in cache), 'ảnh lỗi không được ghi cache');
});

test('gửi ảnh lỗi không làm job thành mơ hồ', async t => {
  const { c, s } = fixture(t);
  const w = new Worker(c, s, async p => {
    const m = JSON.parse(p.message);
    if (p.system === agentPolicy) return JSON.stringify({ action: 'reply', text: 'Em gửi ảnh ạ.', sourceIds: ['product-duoi-heo'], imageIds: (m.images ?? []).map(i => i.id) });
    if (/bộ kiểm tra/.test(p.system)) return '{"inScope":true,"supported":true}';
    return JSON.stringify({ inScope: true, supported: true, wantsOrder: false, san_pham: [], nhom: [], y_dinh: 'khác', nhom_khach: null, chinh_sach: [] });
  }, {
    send: async () => 'mid-text',
    senderAction: async () => true,
    uploadAttachment: async () => 'att-1',
    sendImage: async () => { throw new Error('Meta image send failed'); },
  });
  s.ingest([inbound('111', 'm1', 'gửi ảnh đuôi heo')], c);
  await w.process(s.next());
  assert.equal(s.snapshot().jobs[0].status, 'sent', 'chữ đã gửi thì job phải sent');
  assert.equal(s.conversation('111').state, 'BOT', 'không bị đẩy sang WAITING vì ảnh lỗi');
});

test('mode=draft không gửi ảnh', async t => {
  const { c, s } = fixture(t, 'draft');
  let images = 0;
  const w = new Worker(c, s, async p => {
    const m = JSON.parse(p.message);
    if (p.system === agentPolicy) return JSON.stringify({ action: 'reply', text: 'Em gửi ảnh ạ.', sourceIds: ['product-duoi-heo'], imageIds: (m.images ?? []).map(i => i.id) });
    if (/bộ kiểm tra/.test(p.system)) return '{"inScope":true,"supported":true}';
    return JSON.stringify({ inScope: true, supported: true, wantsOrder: false, san_pham: [], nhom: [], y_dinh: 'khác', nhom_khach: null, chinh_sach: [] });
  }, { send: async () => 'mid', senderAction: async () => true, uploadAttachment: async () => 'att', sendImage: async () => { images++; return 'mid'; } });
  s.ingest([inbound('111', 'm1', 'gửi ảnh đuôi heo')], c);
  await w.process(s.next());
  assert.equal(images, 0, 'draft không được gửi gì');
  assert.equal(s.snapshot().jobs[0].status, 'draft');
});

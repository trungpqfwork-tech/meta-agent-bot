import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Worker, needsOrderExtraction, UNDERSTAND_PROMPT } from '../src/worker.mjs';
import { EXTRACT_ORDER_PROMPT } from '../src/worker.mjs';
import { agentPolicy } from '../src/knowledge.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'page-cskh-latency-'));
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
    documents: [{ id: 'product-ba-chi-bo', title: 'Ba chỉ bò', keywords: ['ba chỉ bò', 'bò', 'giá'], content: 'Ba chỉ bò: 140.000đ/kg', approved: true, validUntil: null }],
  }));
  writeFileSync(c.imageCatalogFile, JSON.stringify({ schemaVersion: 1, images: [] }));
  const s = new Store(c.database, c.pageId);
  t.after(() => { s.close(); rmSync(dir, { recursive: true, force: true }); });
  return { c, s };
}
const inbound = (psid, id, text) => ({ psid, id, kind: 'customer', text, at: Date.now() });

test('cổng trích đơn: chỉ chạy khi tin có khả năng mang thông tin đơn', () => {
  const collecting = { status: 'collecting', missing: ['phone'] };
  assert.equal(needsOrderExtraction('Anh đặt 5kg ba chỉ bò', null, []), true, 'có từ khoá mua');
  assert.equal(needsOrderExtraction('Lấy 1 con em ạ', null, []), true, '"lấy" là ý định mua');
  assert.equal(needsOrderExtraction('Số anh là 0912345678', null, []), true, 'số điện thoại');
  assert.equal(needsOrderExtraction('Anh ở Thái Bình, giao hàng giúp', null, []), true, 'địa chỉ/giao hàng');
  assert.equal(needsOrderExtraction('Cho anh xin ảnh đuôi heo', collecting, [{ kind: 'bot', text: 'Anh cho em xin tên ạ' }]), false, 'xin ảnh thì luôn bỏ qua');
  assert.equal(needsOrderExtraction('Cắt khúc xô là thế nào em?', null, []), false, 'chưa có đơn thì bỏ qua');
  assert.equal(needsOrderExtraction('Cắt khúc xô là thế nào em?', collecting, []), false, 'đang thu thập đơn nhưng câu hỏi dài vẫn bỏ qua');
  assert.equal(needsOrderExtraction('Hi em', null, []), false, 'xã giao thì bỏ qua');
  assert.equal(needsOrderExtraction('Ok em', collecting, [{ kind: 'bot', text: 'Anh cho em xin tên ạ' }]), false, 'câu xác nhận cụt không chở thông tin đơn');
  assert.equal(needsOrderExtraction('Anh tên Trung nhé', collecting, []), true, 'trả lời cụt lúc thu thập đơn vẫn trích (không mất tên khách)');
  assert.equal(needsOrderExtraction('Trung', collecting, []), true, 'tên trần vẫn trích');
  assert.equal(needsOrderExtraction('Ok em', collecting, [{ kind: 'bot', text: 'Dạ anh cần gì thêm không ạ' }]), false, 'không có gì để trích');
});

test('xin ảnh thì KHÔNG gọi lượt trích đơn', async t => {
  const { c, s } = fixture(t);
  const systems = [];
  const w = new Worker(c, s, async p => {
    systems.push(p.system);
    if (p.system === agentPolicy) return JSON.stringify({ action: 'reply', text: 'Dạ em gửi ảnh ạ.', sourceIds: ['product-ba-chi-bo'] });
    if (/bộ kiểm tra/.test(p.system)) return '{"inScope":true,"supported":true}';
    return JSON.stringify({ inScope: true, supported: true, wantsOrder: false, san_pham: ['ba chỉ bò'], nhom: ['bò'], y_dinh: 'xin ảnh', nhom_khach: null, chinh_sach: [] });
  }, { send: async () => 'mid', senderAction: async () => true });
  s.ingest([inbound('111', 'm1', 'Cho anh xin ảnh ba chỉ bò')], c);
  await w.process(s.next());
  assert.ok(!systems.includes(EXTRACT_ORDER_PROMPT), 'không được gọi bộ trích đơn cho tin xin ảnh');
});

test('tin đặt hàng thì trích đơn chạy SONG SONG với lượt hiểu câu hỏi', async t => {
  const { c, s } = fixture(t);
  const events = [];
  const w = new Worker(c, s, async p => {
    if (p.system === UNDERSTAND_PROMPT) { events.push('understand:start'); await sleep(60); events.push('understand:end'); return JSON.stringify({ cau_hoi_da_hieu: 'hỏi giá', san_pham: ['ba chỉ bò'], nhom: ['bò'], y_dinh: 'hỏi giá', nhom_khach: 'personal', chinh_sach: ['giá'], tin_nhan_tiep_theo: 'giá ba chỉ bò' }); }
    if (p.system === EXTRACT_ORDER_PROMPT) { events.push('extract:start'); await sleep(60); events.push('extract:end'); return JSON.stringify({ wantsOrder: true, customerType: 'personal', customerName: null, phone: null, address: null, products: ['ba chỉ bò'], notes: null, ready: false }); }
    if (p.system === agentPolicy) { events.push('answer:start'); return JSON.stringify({ action: 'reply', text: 'Ba chỉ bò 140.000đ/kg ạ.', sourceIds: ['product-ba-chi-bo'] }); }
    if (/bộ kiểm tra/.test(p.system)) return '{"inScope":true,"supported":true}';
    return '{}';
  }, { send: async () => 'mid', senderAction: async () => true });

  s.ingest([inbound('111', 'm1', 'Anh đặt 5kg ba chỉ bò')], c);
  await w.process(s.next());

  const iUnderstandEnd = events.indexOf('understand:end');
  const iExtractStart = events.indexOf('extract:start');
  assert.ok(iExtractStart >= 0, 'phải có lượt trích đơn');
  assert.ok(iExtractStart < iUnderstandEnd, `trích đơn phải bắt đầu trước khi lượt hiểu kết thúc (thứ tự: ${events.join(', ')})`);
  assert.equal(events.at(-1), 'answer:start', 'trả lời vẫn là bước cuối');
  // Đơn vẫn được lưu đúng như trước khi tách luồng.
  assert.equal(s.order('111').customer_type, 'personal');
  assert.deepEqual(s.order('111').products, ['ba chỉ bò']);
});

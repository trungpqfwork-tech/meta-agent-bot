import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Worker, pickImages } from '../src/worker.mjs';
import { agentPolicy } from '../src/knowledge.mjs';

// Kho ảnh có ghi đối tượng: thùng carton cho khách buôn, khay thái lát cho khách lẻ.
function imageCatalog(dir) {
  const file = join(dir, 'images/catalog.json');
  mkdirSync(join(dir, 'images'), { recursive: true });
  writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    images: [
      { id: 'gu-hoa-1', title: 'Gù hoa', keywords: ['gù hoa'], caption: 'Gù hoa', file: 'gu-hoa-1.jpg', approved: true, audience: 'wholesale' },
      { id: 'gu-hoa-4', title: 'Gù hoa thái lát khay', keywords: ['gù hoa', 'gù hoa thái lát'], caption: 'Gù hoa thái lát', file: 'gu-hoa-4.jpg', approved: true, audience: 'retail' },
      { id: 'gu-hoa-9', title: 'Gù hoa (ảnh chung)', keywords: ['gù hoa'], caption: 'Gù hoa', file: 'gu-hoa-9.jpg', approved: true },
    ],
  }));
  return file;
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'page-cskh-aud-'));
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
    documents: [{ id: 'product-gu-hoa', title: 'Gù hoa', keywords: ['gù hoa'], content: 'Gù hoa 210.000đ/kg', approved: true, validUntil: null }],
  }));
  writeFileSync(c.imageCatalogFile, readFileSync(imageCatalog(dir)));
  const s = new Store(c.database, c.pageId);
  t.after(() => { s.close(); rmSync(dir, { recursive: true, force: true }); });
  return { c, s };
}

const inbound = (psid, id, text) => ({ psid, id, kind: 'customer', text, at: Date.now() });

test('ảnh có ghi đối tượng: khách buôn không nhận ảnh khay lẻ và ngược lại', t => {
  const dir = mkdtempSync(join(tmpdir(), 'page-cskh-aud-pick-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = imageCatalog(dir);

  const wholesale = pickImages(file, 'Cho anh xin ảnh gù hoa', 'Cho anh xin ảnh gù hoa', 5, 'wholesale').map(i => i.id);
  assert.ok(!wholesale.includes('gu-hoa-4'), `khách buôn không nhận ảnh khay lẻ: ${wholesale.join(', ')}`);
  assert.ok(wholesale.includes('gu-hoa-1') && wholesale.includes('gu-hoa-9'), `khách buôn nhận ảnh buôn + ảnh chung: ${wholesale.join(', ')}`);

  const retail = pickImages(file, 'Cho anh xin ảnh gù hoa', 'Cho anh xin ảnh gù hoa', 5, 'retail').map(i => i.id);
  assert.ok(!retail.includes('gu-hoa-1'), `khách lẻ không nhận ảnh thùng carton: ${retail.join(', ')}`);
  assert.ok(retail.includes('gu-hoa-4') && retail.includes('gu-hoa-9'), `khách lẻ nhận ảnh khay + ảnh chung: ${retail.join(', ')}`);

  const unknown = pickImages(file, 'Cho anh xin ảnh gù hoa', 'Cho anh xin ảnh gù hoa', 5, 'both').map(i => i.id);
  assert.equal(unknown.length, 3, `chưa rõ khách buôn hay lẻ thì gửi cả: ${unknown.join(', ')}`);
});

test('hội thoại của khách buôn chỉ thấy ảnh buôn, khách lẻ chỉ thấy ảnh lẻ', async t => {
  for (const [khach, expectId, forbidId] of [['store', 'gu-hoa-1', 'gu-hoa-4'], ['personal', 'gu-hoa-4', 'gu-hoa-1']]) {
    const { c, s } = fixture(t);
    let sawImages = null;
    const w = new Worker(c, s, async p => {
      if (p.system === agentPolicy) {
        sawImages = JSON.parse(p.message).images.map(i => i.id);
        return JSON.stringify({ action: 'reply', text: 'Dạ em gửi ảnh gù hoa ạ.', sourceIds: ['product-gu-hoa'], imageIds: sawImages });
      }
      if (/bộ kiểm tra/.test(p.system)) return '{"inScope":true,"supported":true}';
      return JSON.stringify({ cau_hoi_da_hieu: 'xin ảnh gù hoa', san_pham: ['gù hoa'], nhom: ['bò'], y_dinh: 'xin ảnh', nhom_khach: khach, chinh_sach: [] });
    }, { send: async () => 'mid', senderAction: async () => true });

    s.ingest([inbound('111', 'm1', 'Cho anh xin ảnh gù hoa')], c);
    await w.process(s.next());

    assert.ok(sawImages, `khách ${khach}: model phải nhận được ảnh`);
    assert.ok(sawImages.includes(expectId), `khách ${khach} phải thấy ${expectId}: ${sawImages.join(', ')}`);
    assert.ok(!sawImages.includes(forbidId), `khách ${khach} KHÔNG được thấy ${forbidId}: ${sawImages.join(', ')}`);
  }
});

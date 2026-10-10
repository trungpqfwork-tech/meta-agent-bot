import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickImages } from '../src/worker.mjs';
import { agentPolicy } from '../src/knowledge.mjs';

// Kho ảnh giống runtime: ba chỉ bò đóng thùng (JBS/Excel), thái dày, thái mỏng, cuộn
function catalog(t) {
  const dir = mkdtempSync(join(tmpdir(), 'page-cskh-bcb-'));
  const file = join(dir, 'images/catalog.json');
  mkdirSync(join(dir, 'images'));
  const images = [];
  for (const n of [1, 2, 3]) images.push({ id: `ba-chi-bo-jbs-${n}`, title: 'Ba chỉ bò Blue ribbon (JBS)', keywords: ['ba chỉ bò blue ribbon', 'ba chỉ bò jbs', 'ba chỉ bò canada', 'ba chỉ bò'], caption: 'JBS', file: 'x.jpg', approved: true });
  for (let i = 1; i <= 4; i++) images.push({ id: `ba-chi-bo-thai-day-${i}`, title: 'Ba chỉ bò thái dày', keywords: ['ba chỉ bò loại 1 thái dày', 'ba chỉ bò thái dày', 'ba chỉ bò', 'ăn nướng', 'ba chỉ bò ăn nướng', 'thái sẵn', 'thái dày'], caption: 'thái dày', file: 'x.jpg', approved: true });
  for (let i = 1; i <= 6; i++) images.push({ id: `ba-chi-bo-thai-mong-${i}`, title: 'Ba chỉ bò thái mỏng', keywords: ['ba chỉ bò thái mỏng', 'ba chỉ bò', 'ăn lẩu', 'ba chỉ bò ăn lẩu', 'ăn nướng', 'ba chỉ bò ăn nướng', 'thái sẵn', 'thái mỏng'], caption: 'thái mỏng', file: 'x.jpg', approved: true });
  for (const n of [1, 2, 3]) images.push({ id: `ba-chi-bo-cuon-${n}`, title: 'Ba chỉ bò loại 3 (cuộn)', keywords: ['ba chỉ bò cuộn', 'thái cuộn', 'ba chỉ bò'], caption: 'cuộn', file: 'x.jpg', approved: true });
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, images }));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return file;
}

test('khách ăn lẩu: chỉ ảnh thái mỏng, không lẫn thái dày/hàng thùng/cuộn', t => {
  const file = catalog(t);
  const ids = pickImages(file, 'ba chỉ bò ăn lẩu', 'ba chỉ bò ăn lẩu').map(i => i.id);
  assert.ok(ids.length > 0, 'phải có ảnh');
  assert.ok(ids.every(id => id.startsWith('ba-chi-bo-thai-mong-')), `lẩu chỉ được ảnh thái mỏng: ${ids.join(', ')}`);
});

test('khách ăn nướng: có CẢ thái dày và thái mỏng', t => {
  const file = catalog(t);
  const ids = pickImages(file, 'ba chỉ bò ăn nướng', 'ba chỉ bò ăn nướng').map(i => i.id);
  assert.ok(ids.some(id => id.startsWith('ba-chi-bo-thai-day-')), `phải có ảnh thái dày: ${ids.join(', ')}`);
  assert.ok(ids.some(id => id.startsWith('ba-chi-bo-thai-mong-')), `phải có ảnh thái mỏng: ${ids.join(', ')}`);
});

test('câu ngắn "thái mỏng" sau khi bot hỏi lại vẫn ra ảnh thái mỏng', t => {
  const file = catalog(t);
  const docQuery = ['ba chỉ bò thái sẵn', 'Ba chỉ bò thái sẵn bên em có loại thái dày và loại thái mỏng.', 'thái mỏng'].join('\n');
  const ids = pickImages(file, 'thái mỏng', docQuery).map(i => i.id);
  assert.ok(ids.some(id => id.startsWith('ba-chi-bo-thai-mong-')), `phải có ảnh thái mỏng: ${ids.join(', ')}`);
});

test('câu "ba chỉ bò thái sẵn" không lôi ảnh hàng đóng thùng lên trước ảnh thái sẵn', t => {
  const file = catalog(t);
  const ids = pickImages(file, 'ba chỉ bò thái sẵn', 'ba chỉ bò thái sẵn').map(i => i.id);
  assert.ok(ids.some(id => id.includes('thai-')), `phải có ảnh thái sẵn: ${ids.join(', ')}`);
});

test('luật phân biệt lẩu/nướng của ba chỉ bò thái sẵn còn trong prompt', () => {
  assert.match(agentPolicy, /LẨU[^]*THÁI MỎNG/);
  assert.match(agentPolicy, /NƯỚNG[^]*thái dày và thái mỏng/);
  assert.match(agentPolicy, /thái dày hay thái mỏng/);
});

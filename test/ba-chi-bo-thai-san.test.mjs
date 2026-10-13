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
  for (const n of [1, 2, 3]) images.push({ id: `ba-chi-bo-cuon-${n}`, title: 'Ba chỉ bò loại 3 (cuộn)', keywords: ['ba chỉ bò cuộn', 'thái cuộn', 'ba chỉ bò', 'ăn lẩu', 'ba chỉ bò ăn lẩu', 'ăn nướng', 'ba chỉ bò ăn nướng'], caption: 'cuộn', file: 'x.jpg', approved: true });
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, images }));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return file;
}

test('khách ăn lẩu: có ảnh thái mỏng VÀ cuộn, không lẫn thái dày/hàng thùng', t => {
  const file = catalog(t);
  const ids = pickImages(file, 'ba chỉ bò ăn lẩu', 'ba chỉ bò ăn lẩu').map(i => i.id);
  assert.ok(ids.length > 0, 'phải có ảnh');
  assert.ok(ids.some(id => id.startsWith('ba-chi-bo-thai-mong-')), `lẩu phải có ảnh thái mỏng: ${ids.join(', ')}`);
  assert.ok(ids.some(id => id.startsWith('ba-chi-bo-cuon-')), `lẩu phải có ảnh cuộn (cuộn dùng cho cả lẩu): ${ids.join(', ')}`);
  assert.ok(!ids.some(id => id.startsWith('ba-chi-bo-thai-day-')), `lẩu không được có ảnh thái dày: ${ids.join(', ')}`);
  assert.ok(!ids.some(id => id.startsWith('ba-chi-bo-jbs-')), `lẩu không được có ảnh hàng đóng thùng: ${ids.join(', ')}`);
});

test('khách ăn nướng: có CẢ thái dày, thái mỏng và cuộn', t => {
  const file = catalog(t);
  const ids = pickImages(file, 'ba chỉ bò ăn nướng', 'ba chỉ bò ăn nướng').map(i => i.id);
  assert.ok(ids.some(id => id.startsWith('ba-chi-bo-thai-day-')), `phải có ảnh thái dày: ${ids.join(', ')}`);
  assert.ok(ids.some(id => id.startsWith('ba-chi-bo-thai-mong-')), `phải có ảnh thái mỏng: ${ids.join(', ')}`);
  assert.ok(ids.some(id => id.startsWith('ba-chi-bo-cuon-')), `phải có ảnh cuộn: ${ids.join(', ')}`);
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
  assert.match(agentPolicy, /LẨU[^]*THÁI MỎNG[^]*cuộn/);
  assert.match(agentPolicy, /NƯỚNG[^]*thái dày, thái mỏng[^]*cuộn/);
  assert.match(agentPolicy, /thái dày hay thái mỏng/);
});

test('khách gõ thiếu dấu "ba chỉ bò mong" vẫn phải ra ảnh thái mỏng, không lôi ảnh hàng đóng thùng', t => {
  const file = catalog(t);
  const ids = pickImages(file, 'Cho anh ảnh ba chỉ bò mong', 'Cho anh ảnh ba chỉ bò mong').map(i => i.id);
  assert.equal(ids.length, 5, `phải đủ 5 ảnh, nhận ${ids.length}: ${ids.join(', ')}`);
  assert.ok(ids.every(id => id.startsWith('ba-chi-bo-thai-mong-')), `chỉ ảnh thái mỏng: ${ids.join(', ')}`);
});

test('"ba chỉ bò mong" (thiếu dấu) không được lẫn thái dày, cuộn hay hàng thùng', t => {
  const file = catalog(t);
  const ids = pickImages(file, 'cho anh xem ảnh ba chỉ bò mong', 'cho anh xem ảnh ba chỉ bò mong').map(i => i.id);
  assert.ok(!ids.some(id => id.includes('-jbs-') || id.includes('-excel-')), `không hàng thùng: ${ids.join(', ')}`);
  assert.ok(!ids.some(id => id.startsWith('ba-chi-bo-thai-day-')), `không thái dày: ${ids.join(', ')}`);
});

test('câu mơ hồ "ảnh rút xương" vẫn để payload rỗng dù đã đổi cách chấm từ khoá', t => {
  const dir = mkdtempSync(join(tmpdir(), 'page-cskh-bcb-rx-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'images'));
  const file = join(dir, 'images/catalog.json');
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, images: [
    { id: 'chan-ga-rut-xuong-1', title: 'Chân gà rút xương', keywords: ['chân gà rút xương', 'gà rút xương'], caption: 'x', file: 'x.jpg', approved: true },
    { id: 'ba-chi-heo-rut-xuong-1', title: 'Ba chỉ heo rút xương', keywords: ['ba chỉ heo rút xương', 'heo rút xương'], caption: 'x', file: 'x.jpg', approved: true },
  ] }));
  const ids = pickImages(file, 'cho anh xem ảnh rút xương', 'cho anh xem ảnh rút xương').map(i => i.id);
  assert.deepEqual(ids, [], `payload phải rỗng để bot hỏi lại: ${ids.join(', ')}`);
});

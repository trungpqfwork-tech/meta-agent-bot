import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickImages } from '../src/worker.mjs';
import { closeEnough } from '../src/images.mjs';

// Kho ảnh giống runtime: ba chỉ bò đóng thùng (JBS/Excel) có từ khoá trần "ba chỉ bò",
// thái dày, thái mỏng, cuộn; thêm chân gà rút xương vs chân gà nguyên xương (2 mặt hàng
// khác nhau) và cá hồi nguyên con.
function catalog(t) {
  const dir = mkdtempSync(join(tmpdir(), 'page-cskh-tokens-'));
  const file = join(dir, 'images/catalog.json');
  mkdirSync(join(dir, 'images'));
  const images = [];
  const push = (id, title, keywords) => images.push({ id, title, keywords, caption: title, file: `${id}.jpg`, approved: true });
  for (const n of [1, 2, 3, 4, 5]) push(`ba-chi-bo-jbs-${n}`, 'Ba chỉ bò Blue ribbon (JBS)', ['ba chỉ bò blue ribbon', 'ba chỉ bò jbs', 'blue ribbon', 'jbs', 'ba chỉ bò canada', 'canada', 'ba chỉ bò']);
  for (const n of [1, 2, 3]) push(`ba-chi-bo-thai-day-${n}`, 'Ba chỉ bò thái dày', ['ba chỉ bò loại 1 thái dày', 'ba chỉ bò thái dày', 'ba chỉ bò', 'ăn nướng', 'ba chỉ bò ăn nướng', 'thái sẵn', 'thái dày']);
  for (const n of [1, 2, 3, 4, 5, 6]) push(`ba-chi-bo-thai-mong-${n}`, 'Ba chỉ bò thái mỏng', ['ba chỉ bò thái mỏng', 'ba chỉ bò loại 1 thái mỏng', 'ba chỉ bò', 'ăn lẩu', 'ba chỉ bò ăn lẩu', 'ăn nướng', 'thái sẵn', 'thái mỏng']);
  for (const n of [1, 2]) push(`ba-chi-bo-cuon-${n}`, 'Ba chỉ bò loại 3 (cuộn)', ['ba chỉ bò cuộn', 'thái cuộn', 'ba chỉ bò', 'ăn lẩu', 'ba chỉ bò ăn lẩu', 'ăn nướng', 'ba chỉ bò ăn nướng']);
  // Từ khoá sao đúng bản thật trong runtime/images/catalog.json: ảnh nguyên xương KHÔNG
  // có từ khoá trần "chân gà" chung với ảnh rút xương.
  for (const n of [1, 2, 3]) push(`chan-ga-rut-xuong-${n}`, 'Chân gà rút xương', ['chân gà rút xương', 'chân gà rút xương minh châu', 'gà rút xương', 'chân gà minh châu']);
  for (const n of [1, 2]) push(`chan-ga-nguyen-xuong-${n}`, 'Chân gà nguyên xương', ['chân gà nguyên xương', 'chân gà có xương']);
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, images }));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return file;
}

test('khách gõ thiếu dấu "ba chỉ bò mong" ra ảnh thái mỏng, không lẫn hàng đóng thùng', t => {
  const ids = pickImages(catalog(t), 'Cho anh ảnh ba chỉ bò mong', 'Cho anh ảnh ba chỉ bò mong').map(i => i.id);
  assert.equal(ids.length, 5, `phải có 5 ảnh: ${ids.join(', ')}`);
  assert.ok(ids.every(id => id.startsWith('ba-chi-bo-thai-mong-')), `phải toàn ảnh thái mỏng: ${ids.join(', ')}`);
});

test('thiếu dấu vẫn ra thái mỏng dù câu không có chữ "thái"', t => {
  const ids = pickImages(catalog(t), 'anh lấy ba chỉ bò mong', 'anh lấy ba chỉ bò mong').map(i => i.id);
  assert.ok(ids.length > 0 && ids.every(id => id.startsWith('ba-chi-bo-thai-mong-')), `phải toàn ảnh thái mỏng: ${ids.join(', ')}`);
});

test('khách nói rõ hãng thì không lẫn ảnh hãng khác kể cả khi thiếu dấu', t => {
  const ids = pickImages(catalog(t), 'cho ảnh ba chỉ bò jbs', 'cho ảnh ba chỉ bò jbs').map(i => i.id);
  assert.equal(ids.length, 5, `phải có 5 ảnh JBS: ${ids.join(', ')}`);
  assert.ok(ids.every(id => id.startsWith('ba-chi-bo-jbs-')), `chỉ JBS: ${ids.join(', ')}`);
});

test('"chân gà rút xương" không lẫn ảnh chân gà NGUYÊN xương (khác mặt hàng)', t => {
  const ids = pickImages(catalog(t), 'cho anh xem ảnh chân gà rút xương', 'cho anh xem ảnh chân gà rút xương').map(i => i.id);
  assert.equal(ids.length, 3, `đúng 3 ảnh chân gà rút xương: ${ids.join(', ')}`);
  assert.ok(ids.every(id => id.startsWith('chan-ga-rut-xuong-')), `không được lẫn chân gà nguyên xương: ${ids.join(', ')}`);
});

test('hỏi chung "ba chỉ bò" thì mỗi nhóm ảnh đều có mặt (không bị nhóm đứng trước chiếm hết)', t => {
  const ids = pickImages(catalog(t), 'cho anh xem ảnh ba chỉ bò', 'cho anh xem ảnh ba chỉ bò').map(i => i.id);
  assert.equal(ids.length, 5, `5 ảnh: ${ids.join(', ')}`);
  for (const prefix of ['ba-chi-bo-jbs-', 'ba-chi-bo-thai-day-', 'ba-chi-bo-thai-mong-', 'ba-chi-bo-cuon-'])
    assert.ok(ids.some(id => id.startsWith(prefix)), `thiếu nhóm ${prefix}: ${ids.join(', ')}`);
});

test('gõ thiếu 1 ký tự "thái mog" vẫn ra ảnh thái mỏng, không trộn dày/cuộn', t => {
  const dir = mkdtempSync(join(tmpdir(), 'page-cskh-typo-'));
  const file = join(dir, 'images/catalog.json');
  mkdirSync(join(dir, 'images'));
  const images = [];
  const push = (id, title, keywords) => images.push({ id, title, keywords, caption: title, file: `${id}.jpg`, approved: true });
  for (const n of [1, 2, 3, 4, 5]) push(`ba-chi-bo-jbs-${n}`, 'Ba chỉ bò Blue ribbon (JBS)', ['ba chỉ bò blue ribbon', 'ba chỉ bò jbs', 'jbs', 'ba chỉ bò']);
  for (let i = 1; i <= 4; i++) push(`ba-chi-bo-thai-day-${i}`, 'Ba chỉ bò thái dày', ['ba chỉ bò thái dày', 'ba chỉ bò', 'thái dày', 'ăn nướng']);
  for (let i = 1; i <= 6; i++) push(`ba-chi-bo-thai-mong-${i}`, 'Ba chỉ bò thái mỏng', ['ba chỉ bò thái mỏng', 'ba chỉ bò', 'thái mỏng', 'ăn lẩu']);
  for (const n of [1, 2, 3]) push(`ba-chi-bo-cuon-${n}`, 'Ba chỉ bò loại 3 (cuộn)', ['ba chỉ bò cuộn', 'ba chỉ bò', 'thái cuộn', 'ăn lẩu']);
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, images }));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ids = pickImages(file, 'Cho ảnh ba chỉ bò thái mog', 'Cho ảnh ba chỉ bò thái mog').map(i => i.id);
  assert.deepEqual(ids, ['ba-chi-bo-thai-mong-1', 'ba-chi-bo-thai-mong-2', 'ba-chi-bo-thai-mong-3', 'ba-chi-bo-thai-mong-4', 'ba-chi-bo-thai-mong-5'], ids.join(', '));
});

test('câu hỏi đơn hàng không được khớp bừa sang từ khóa ảnh: "thay" ≠ "thái"', t => {
  const file = catalog(t);
  const ids = pickImages(file, 'Anh muốn thay đổi đơn hàng đã đặt', 'Anh muốn thay đổi đơn hàng đã đặt').map(i => i.id);
  assert.deepEqual(ids, [], `payload phải rỗng, nhận: ${ids.join(', ')}`);
});

test('nhận lỗi thiếu/đổi chỗ 1 ký tự nhưng không nhận thay thế ký tự', () => {
  assert.equal(closeEnough('mog', 'mong'), true, 'thiếu 1 ký tự');
  assert.equal(closeEnough('mogn', 'mong'), true, 'đổi chỗ 2 ký tự liền nhau');
  assert.equal(closeEnough('thay', 'thai'), false, 'thay thế 1 ký tự thì KHÔNG khớp');
  assert.equal(closeEnough('mong', 'mang'), false, 'thay thế 1 ký tự thì KHÔNG khớp');
  assert.equal(closeEnough('bo', 'bong'), false, 'từ ngắn phải khớp chính xác');
  assert.equal(closeEnough('mong', 'mong'), true, 'khớp chính xác');
});

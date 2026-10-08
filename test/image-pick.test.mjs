import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickImages } from '../src/worker.mjs';

// Kho ảnh giống thật: 4 cá hồi nguyên con + 5 ba chỉ bò JBS + 1 ảnh kho
function catalog(t) {
  const dir = mkdtempSync(join(tmpdir(), 'page-cskh-pick-'));
  const file = join(dir, 'images/catalog.json');
  mkdirSync(join(dir, 'images'));
  const images = [];
  for (let i = 1; i <= 4; i++) images.push({ id: `ca-hoi-nguyen-con-${i}`, title: 'Cá hồi nguyên con', keywords: ['cá hồi nguyên con', 'cá hồi'], caption: 'Cá hồi nguyên con', file: `ca-hoi-nguyen-con-${i}.jpg`, approved: true });
  for (const n of [1, 3, 4, 5, 6]) images.push({ id: `ba-chi-bo-jbs-${n}`, title: 'Ba chỉ bò Blue ribbon (JBS)', keywords: ['ba chỉ bò blue ribbon', 'ba chỉ bò jbs', 'blue ribbon', 'jbs', 'ba chỉ bò'], caption: 'Ba chỉ bò Blue ribbon (JBS)', file: `ba-chi-bo-jbs-${n}.jpg`, approved: true });
  images.push({ id: 'ba-chi-bo-jbs-2', title: 'Kho lạnh bảo quản', keywords: ['kho lạnh', 'số lượng', 'tồn kho'], caption: 'Kho lạnh bảo quản', file: 'ba-chi-bo-jbs-2.jpg', approved: true });
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, images }));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return file;
}

test('câu đang hỏi thắng ngữ cảnh: hỏi ảnh bò JBS ngay sau khi xem cá hồi phải đủ 5 ảnh bò', t => {
  const file = catalog(t);
  const currentMessage = 'Cho anh xin ảnh bò jbs';
  const docQuery = ['bò jbs', 'Cho anh xem ảnh cá hồi nguyên con', currentMessage].join('\n');
  const ids = pickImages(file, currentMessage, docQuery).map(i => i.id);
  assert.equal(ids.length, 5, `phải có 5 ảnh, nhận được ${ids.length}: ${ids.join(', ')}`);
  assert.ok(ids.every(id => id.startsWith('ba-chi-bo-jbs-')), `không được lẫn ảnh cá hồi: ${ids.join(', ')}`);
});

test('khách hỏi ảnh chung thì vẫn lấy được ảnh của món đang bàn trong ngữ cảnh', t => {
  const file = catalog(t);
  const ids = pickImages(file, 'Cho anh xem ảnh với', 'ba chỉ bò jbs\nCho anh xem ảnh với').map(i => i.id);
  assert.ok(ids.length > 0, 'phải có ảnh để gửi');
  assert.ok(ids.some(id => id.startsWith('ba-chi-bo-jbs-')), `ngữ cảnh phải lấp được chỗ trống: ${ids.join(', ')}`);
});

test('khách hỏi ảnh cá hồi thì không lẫn ảnh bò, và ngược lại', t => {
  const file = catalog(t);
  const caHoi = pickImages(file, 'Cho anh xin ảnh cá hồi', 'Cho anh xin ảnh cá hồi').map(i => i.id);
  assert.ok(caHoi.every(id => id.startsWith('ca-hoi-')), `chỉ cá hồi: ${caHoi.join(', ')}`);
  const bo = pickImages(file, 'Cho anh xin ảnh ba chỉ bò', 'Cho anh xin ảnh ba chỉ bò').map(i => i.id);
  assert.ok(bo.every(id => id.startsWith('ba-chi-bo-jbs-')), `chỉ bò: ${bo.join(', ')}`);
});

test('hỏi số lượng thì khớp ảnh kho, không kèm ảnh thịt', t => {
  const file = catalog(t);
  const ids = pickImages(file, 'Hàng này nhà em số lượng còn nhiều không?', 'Hàng này nhà em số lượng còn nhiều không?').map(i => i.id);
  assert.deepEqual(ids, ['ba-chi-bo-jbs-2']);
});

test('không quá 5 ảnh một lượt', t => {
  const file = catalog(t);
  const ids = pickImages(file, 'Cho anh xin ảnh ba chỉ bò và cá hồi', 'ba chỉ bò\ncá hồi');
  assert.ok(ids.length <= 5, `tối đa 5 ảnh, nhận ${ids.length}`);
});

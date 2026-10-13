import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickImages } from '../src/worker.mjs';
import { agentPolicy } from '../src/knowledge.mjs';

// Khách chỉ nói "rút xương" là từ khoá MƠ HỒ giữa hai mặt hàng khác nhau:
// Chân gà rút xương (nhóm gà) và Ba chỉ heo rút xương (nhóm heo). Ca thật 09/10/2026:
// khách xin "ảnh rút xương", payload lẫn cả 2 nhóm và bot tự nhận là chân gà rồi báo
// "chưa có ảnh" dù kho có 3 ảnh chân gà.
function catalog(t) {
  const dir = mkdtempSync(join(tmpdir(), 'page-cskh-rx-'));
  const file = join(dir, 'images/catalog.json');
  mkdirSync(join(dir, 'images'));
  const images = [];
  for (let i = 1; i <= 3; i++) images.push({ id: `chan-ga-rut-xuong-${i}`, title: 'Chân gà rút xương', keywords: ['chân gà rút xương', 'chân gà rút xương minh châu', 'gà rút xương', 'chân gà minh châu'], caption: 'Chân gà rút xương', file: `chan-ga-rut-xuong-${i}.jpg`, approved: true });
  for (let i = 1; i <= 4; i++) images.push({ id: `ba-chi-heo-rut-xuong-${i}`, title: 'Ba chỉ heo rút xương', keywords: ['ba chỉ heo rút xương', 'ba chỉ heo rút sương', 'heo rút xương', 'ba chỉ heo'], caption: 'Ba chỉ heo rút xương', file: `ba-chi-heo-rut-xuong-${i}.jpg`, approved: true });
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, images }));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return file;
}

test('"rút xương" trơ không đưa ảnh nào vào payload (để bot hỏi lại, không lẫn gà với heo)', t => {
  const file = catalog(t);
  for (const q of ['ảnh rút xương', 'cho anh xem ảnh rút xương', 'gửi mình hình rút xương']) {
    const ids = pickImages(file, q, q).map(i => i.id);
    assert.deepEqual(ids, [], `"${q}" phải để payload rỗng, nhận được: ${ids.join(', ')}`);
  }
});

test('nói rõ mặt hàng thì chỉ lấy ảnh của mặt hàng đó', t => {
  const file = catalog(t);
  const ga = pickImages(file, 'cho anh xem ảnh chân gà rút xương', 'cho anh xem ảnh chân gà rút xương').map(i => i.id);
  assert.equal(ga.length, 3, `phải đủ 3 ảnh chân gà: ${ga.join(', ')}`);
  assert.ok(ga.every(id => id.startsWith('chan-ga-rut-xuong-')), `không được lẫn ảnh heo: ${ga.join(', ')}`);

  const heo = pickImages(file, 'ảnh ba chỉ heo rút xương', 'ảnh ba chỉ heo rút xương').map(i => i.id);
  assert.equal(heo.length, 4, `phải đủ 4 ảnh ba chỉ heo: ${heo.join(', ')}`);
  assert.ok(heo.every(id => id.startsWith('ba-chi-heo-rut-xuong-')), `không được lẫn ảnh gà: ${heo.join(', ')}`);
});

test('agentPolicy có luật hỏi lại khi khách chỉ nói "rút xương"', () => {
  assert.match(agentPolicy, /rút xương/, 'luật hỏi lại "rút xương" đã bị gỡ khỏi agentPolicy');
  assert.match(agentPolicy, /Chân gà rút xương và Ba chỉ heo rút xương/, 'luật phải nêu rõ hai mặt hàng để bot không tự đoán');
  assert.match(agentPolicy, /không tự nhận là chân gà/, 'luật phải cấm bot tự nhận là chân gà');
});

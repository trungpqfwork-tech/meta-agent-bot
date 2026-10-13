import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { basename, resolve as resolvePath } from 'node:path';
import { assert } from './config.mjs';
import { normalize } from './knowledge.mjs';

// Which file backs an approved catalog record. Only the basename is used: the
// path comes from imported data, and a crawled/edited catalog entry must never
// be able to point the sender at a file outside runtime/images.
export function imageFilePath(runtimeDir, img) {
  const name = basename(String(img?.file ?? '').trim());
  if(!name || name.startsWith('.')) return null;
  return resolvePath(runtimeDir, 'images', name);
}

// Meta wants an attachment_id per sent image. Uploading on every reply would be
// slow and rate-limited, so the id is cached next to the catalog (a sidecar, so
// the importer's own writes to catalog.json never race with it).
export function attachmentCacheFile(runtimeDir) {
  return resolvePath(runtimeDir, 'images', 'attachments.json');
}
// Meta lấy ảnh theo URL công khai (HTTPS). URL được suy ra từ chính domain webhook
// đã có, nên không cần thêm cấu hình hosting: edge phục vụ /images/<tên file> cho
// đúng những file nằm trong bản ghi ĐÃ DUYỆT.
export function publicImageUrl(publicWebhookUrl, img) {
  const name = basename(String(img?.file ?? '').trim());
  if(!name || name.startsWith('.')) return null;
  let origin;
  try { origin = new URL(String(publicWebhookUrl)).origin; } catch { return null; }
  if(!/^https:$/.test(new URL(origin).protocol)) return null;
  return `${origin}/images/${encodeURIComponent(name)}`;
}
// Tên file mà edge được phép phục vụ công khai: chỉ ảnh đã duyệt.
export function approvedImageNames(catalogFile) {
  return new Set(loadImageCatalog(catalogFile)
    .filter(img => img.approved === true)
    .map(img => basename(String(img.file ?? '').trim()))
    .filter(name => name && !name.startsWith('.')));
}
export function loadAttachmentCache(runtimeDir) {
  const file = attachmentCacheFile(runtimeDir);
  if(!existsSync(file)) return {};
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}
export function saveAttachmentCache(runtimeDir, cache) {
  const file = attachmentCacheFile(runtimeDir);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

export function loadImageCatalog(file) {
  if(!existsSync(file)) return [];
  const raw = readFileSync(file, 'utf8');
  assert(raw.length <= 500000, 'Image catalog too large for MVP');
  const catalog = JSON.parse(raw);
  assert(catalog.schemaVersion === 1 && Array.isArray(catalog.images), 'Invalid image catalog');
  const seen = new Set();
  for(const img of catalog.images) {
    assert(typeof img.id === 'string' && img.id && !seen.has(img.id), 'Duplicate/missing image id'); seen.add(img.id);
    assert(typeof img.title === 'string' && img.title.trim(), 'Image title required');
    assert(Array.isArray(img.keywords) && img.keywords.every(k => typeof k === 'string' && k.trim()), 'Image keywords required');
    assert(img.file == null || typeof img.file === 'string', 'Invalid image file');
    assert(img.url == null || (typeof img.url === 'string' && /^https:\/\//.test(img.url)), 'Invalid image url');
    assert(img.caption == null || typeof img.caption === 'string', 'Invalid image caption');
  }
  return catalog.images;
}

// Khớp từ khoá theo TỪNG TỪ, không theo chuỗi con:
//  - Từ khoá "úc" không còn khớp bừa trong "mực ống"; từ khoá ngắn tự nhiên chỉ khớp
//    khi đứng riêng một từ (trước đây phải có luật riêng cho từ khoá ≤3 ký tự).
//  - Khách gõ thiếu dấu/sai một chữ vẫn khớp đúng loại hàng: "ba chỉ bò mong" khớp
//    "ba chỉ bò thái mỏng" (4/5 từ) — ca thật 10/10/2026 khách gõ "mong", khớp cả cụm
//    không ăn nên mọi ảnh ba chỉ bò bằng điểm nhau và bot gửi toàn ảnh hàng đóng thùng
//    cho khách xin ảnh thái mỏng.
//  - Nhưng câu mơ hồ ngắn như "ảnh rút xương" (chân gà rút xương vs ba chỉ heo rút
//    xương) vẫn phải để payload RỖNG cho bot hỏi lại: chỉ nhận khớp một phần khi từ
//    khoá đủ dài (≥4 từ) và chỉ thiếu tối đa 1 từ.
export function words(text) {
  return normalize(String(text ?? '')).split(/[^a-z0-9]+/).filter(Boolean);
}
// Gõ sai/thiếu một ký tự vẫn phải khớp: khách gõ "thái mog" (thiếu n) hoặc "mogn"
// (đổi chỗ 2 ký tự) vẫn là "mỏng". Chỉ nhận hai dạng lỗi an toàn:
//  - thiếu/thừa đúng 1 ký tự ("mog" ~ "mong"),
//  - đổi chỗ 2 ký tự liền nhau ("mogn" ~ "mong").
// KHÔNG nhận thay thế 1 ký tự ("thay" không được khớp "thái") và không áp cho từ ≤2
// ký tự ("ga", "bo"), để từ ngắn vẫn phải khớp chính xác.
export function closeEnough(a, b) {
  if(a === b) return true;
  if(Math.min(a.length, b.length) < 3) return false;
  if(Math.abs(a.length - b.length) > 1) return false;
  if(a.length === b.length) {
    const diff = [];
    for(let i = 0; i < a.length; i++) if(a[i] !== b[i]) diff.push(i);
    if(diff.length !== 2 || diff[1] !== diff[0] + 1) return false;
    return a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]];
  }
  const long = a.length > b.length ? a : b;
  const short = a.length > b.length ? b : a;
  let skipped = 0;
  for(let i = 0, j = 0; i < long.length && j < short.length; ) {
    if(long[i] === short[j]) { i++; j++; continue; }
    if(++skipped > 1) return false;
    i++;
  }
  return true;
}
function keywordMatch(qWords, qList, keyword) {
  const kw = words(keyword);
  if(!kw.length) return null;
  const hits = kw.filter(w => qWords.has(w) || qList.some(t => closeEnough(w, t)));
  if(!hits.length) return null;
  const full = hits.length === kw.length;
  if(!full && !(kw.length >= 4 && hits.length >= kw.length - 1)) return null;
  return { words: kw, hits, matched: hits.length, ratio: hits.length / kw.length };
}

// Điểm của một ảnh = tổng TRỌNG SỐ IDF của các từ trong từ khoá khớp nhiều nhất.
// Từ chung chung ("ba", "chỉ", "bò" — có ở hàng chục ảnh) gần như không phân biệt
// được gì; từ đặc trưng ("mong", "jbs", "rivasam" — chỉ vài ảnh) quyết định xếp hạng.
// Nhờ vậy khách nêu hãng/độ dày thì đúng nhóm đó lên đầu, kể cả khi câu thiếu dấu.
//
// Ảnh chỉ khớp MỘT PHẦN từ khoá (thiếu 1 từ) chỉ được vào payload khi không còn ảnh
// nào khớp TRỌN từ khoá: nếu không, khách hỏi "chân gà rút xương" sẽ nhận kèm ảnh
// "chân gà nguyên xương" (khớp 3/4 từ), hoặc khách hỏi "ba chỉ bò jbs" nhận kèm ảnh
// hàng thùng hãng khác — hai mặt hàng khác nhau, không được lẫn.
export function imageScores(images, query) {
  const qWords = new Set(words(query));
  const qList = [...qWords];
  const kwWords = new Map();
  const df = new Map();
  for(const img of images) {
    const seen = new Set();
    for(const k of img.keywords) {
      if(!kwWords.has(k)) kwWords.set(k, words(k));
      for(const w of kwWords.get(k)) seen.add(w);
    }
    for(const w of seen) df.set(w, (df.get(w) ?? 0) + 1);
  }
  const total = images.length || 1;
  const weight = w => Math.log(1 + total / (df.get(w) ?? 1));
  const scored = images.map(img => {
    let score = 0, ratio = 0, full = false;
    for(const k of img.keywords) {
      const m = keywordMatch(qWords, qList, k);
      if(!m) continue;
      if(m.matched === m.words.length) full = true;
      let s = 0;
      for(const w of m.hits) s += weight(w);
      if(s > score || (s === score && m.ratio > ratio)) { score = s; ratio = m.ratio; }
    }
    return {...img, score, ratio, full};
  }).filter(img => img.score > 0);
  const pool = scored.some(img => img.full) ? scored.filter(img => img.full) : scored;
  return pool
    .sort((a, b) => b.score - a.score || b.ratio - a.ratio)
    .map(({ full, ...img }) => img);
}
export function retrieveImages(file, query, limit=5) {
  const images = loadImageCatalog(file).filter(img => img.approved === true);
  return imageScores(images, query)
    .slice(0, limit)
    .map(({ ratio, ...img }) => img);
}

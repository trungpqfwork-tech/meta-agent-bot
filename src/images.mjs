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

export function retrieveImages(file, query, limit=5) {
  const q = normalize(query);
  return loadImageCatalog(file)
    .filter(img => img.approved === true)
    .map(img => ({...img, score: img.keywords.reduce((n,k) => n + (q.includes(normalize(k)) ? 1 : 0),0)}))
    .filter(img => img.score > 0)
    .sort((a,b) => b.score-a.score)
    .slice(0, limit);
}

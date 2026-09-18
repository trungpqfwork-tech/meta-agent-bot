import { existsSync, readFileSync } from 'node:fs';
import { assert } from './config.mjs';
import { normalize } from './knowledge.mjs';

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

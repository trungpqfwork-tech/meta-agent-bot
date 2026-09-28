import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';
import { runtimeConfigFromEnv, assert } from '../src/config.mjs';
import { normalize } from '../src/knowledge.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function args(name) {
  const out = [];
  process.argv.forEach((value, i) => { if(value === name && process.argv[i + 1]) out.push(process.argv[i + 1]); });
  return out;
}
function has(name) { return process.argv.includes(name); }
function uniq(values) {
  return [...new Set(values.flatMap(v => splitList(v)).map(v => v.trim()).filter(Boolean))];
}
function splitList(value) {
  if(value == null) return [];
  if(Array.isArray(value)) return value.flatMap(splitList);
  return String(value).split(/[,;|/、\n]+/).map(v => v.trim()).filter(Boolean);
}
function slug(value) {
  const s = normalize(String(value ?? ''))
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return s || `item-${Date.now()}`;
}
function readJson(file, fallback) {
  if(!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}
function writeJson(file, value) {
  mkdirSync(dirname(file), {recursive:true, mode:0o700});
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {mode:0o600});
}
function backup(file, stamp) {
  if(!existsSync(file)) return null;
  const target = `${file}.bak-${stamp}`;
  copyFileSync(file, target);
  return target;
}
function compactRow(row) {
  const out = {};
  for(const [k,v] of Object.entries(row)) {
    if(v == null) continue;
    const value = String(v).trim();
    if(value) out[String(k).trim()] = value;
  }
  return out;
}
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function keyOf(row, aliases) {
  const normalized = Object.keys(row).map(k => [k, normalize(k)]);
  for(const alias of aliases) {
    const needle = normalize(alias);
    if(!needle) continue;
    // Whole-word matching only. Substring matching made the "Ảnh" alias match
    // "Danh Mục" (d-anh-muc) and fabricated an approved image for every product.
    const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegex(needle)}($|[^a-z0-9])`);
    const hit = normalized.find(([,k]) => pattern.test(k));
    if(hit) return hit[0];
  }
  return undefined;
}
function val(row, aliases) {
  const k = keyOf(row, aliases);
  return k ? row[k] : '';
}
// Exact whole-header match. Word-boundary matching is too loose for a bare
// "Giá" alias: it also matches the header "Giá lẻ", so the generic price would
// silently overwrite the retail one.
function exactVal(row, names) {
  const wanted = names.map(normalize).filter(Boolean);
  for(const [k,v] of Object.entries(row)) {
    if(wanted.includes(normalize(k))) return v;
  }
  return '';
}
// Two price tiers: what a household pays, and what a business pays
// (restaurant, canteen, hotel, hotpot/grill shop). The wholesale tier is split by
// order size: below one pack vs one pack and up.
function bandOfKey(key) {
  const k = normalize(key);
  if(!/thung/.test(k)) return null;
  if(/(duoi|nho hon|chua du|khong du|<)/.test(k)) return 'under';
  // "Giá Thùng" is the operator's name for the one-pack-and-up price.
  if(/(tro len|tu 1|tu mot|day thung|du thung|>=|>|≥|gia thung)/.test(k)) return 'from';
  return null;
}
// Any header that mentions a pack size is a band column, never the flat price —
// otherwise the bare "Giá buôn" alias would swallow "Giá buôn từ 1 thùng".
function valNotBand(row, aliases) {
  for(const alias of aliases) {
    const needle = normalize(alias);
    if(!needle) continue;
    const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegex(needle)}($|[^a-z0-9])`);
    const hit = Object.keys(row).find(k => bandOfKey(k) === null && pattern.test(normalize(k)));
    if(hit) return row[hit];
  }
  return '';
}
function priceFromRow(row) {
  const tier = normalize(cleanupValue(val(row, ['Bảng giá','Loại giá','Nhóm giá','Price tier','Tier'])));
  const unit = cleanupValue(exactVal(row, ['Đơn vị','Đơn vị tính','ĐVT','Unit']));
  // 'Quy cách' is the wholesale pack (whole thùng); 'Đóng gói' is the retail pack.
  // They must not share one field: a later retail import would overwrite the
  // wholesale pack size and print "147/Khay" for a price that is really per kg.
  const pack = cleanupValue(exactVal(row, ['Quy cách thùng','Quy cách','Đóng gói','Pack size']));
  const priceValidUntil = cleanupValue(exactVal(row, ['Hiệu lực đến','Hiệu lực','Ngày hết hạn','Hết hạn','Valid until']));
  let priceRetail = cleanupValue(valNotBand(row, ['Giá mua dùng','Giá lẻ','Giá bán lẻ','Giá khách lẻ','Giá cá nhân','Retail price','Retail']));
  let priceWholesale = cleanupValue(valNotBand(row, ['Giá buôn','Giá bán buôn','Giá sỉ','Giá bán sỉ','Giá khách sỉ','Wholesale price','Wholesale']));
  let priceWholesaleUnder = '', priceWholesaleFrom = '';
  for(const [k,v] of Object.entries(row)) {
    const band = bandOfKey(k);
    const value = cleanupValue(v);
    if(!value) continue;
    if(band === 'under' && !priceWholesaleUnder) priceWholesaleUnder = value;
    if(band === 'from' && !priceWholesaleFrom) priceWholesaleFrom = value;
  }
  const generic = cleanupValue(exactVal(row, ['Giá','Đơn giá','Price']));
  if(generic) {
    if(/buon|si|wholesale|store/.test(tier)) { if(!priceWholesale) priceWholesale = generic; }
    else if(!priceRetail) priceRetail = generic;
  }
  const hasRetail = Boolean(priceRetail);
  const hasWholesale = Boolean(priceWholesale || priceWholesaleUnder || priceWholesaleFrom);
  return {
    priceRetail, priceWholesale, priceWholesaleUnder, priceWholesaleFrom,
    priceUnitRetail: hasRetail ? unit : '',
    packSizeRetail: hasRetail ? pack : '',
    priceUnitWholesale: hasWholesale ? unit : '',
    packSizeWholesale: hasWholesale ? pack : '',
    priceValidUntil
  };
}
// The operator sheets write prices as bare thousands ("205" = 205.000đ). Verified
// against the sheet's own arithmetic: Nét 185.25 = Cost 183.75 + Cước 1.5, and
// 205 - 185.25 = 19.75, the margin column.
export function formatPrice(value) {
  const s = String(value ?? '').trim();
  if(!s) return '';
  if(/^\d+$/.test(s)) return `${(Number(s) * 1000).toLocaleString('vi-VN')}đ`;
  return s;
}
function hasPrice(p) {
  const priced = s => Boolean(s && (s.priceRetail || s.priceWholesale || s.priceWholesaleUnder || s.priceWholesaleFrom));
  return priced(p) || Boolean(p.brands?.some(priced));
}
function hasBand(p) {
  return Boolean(p.priceWholesaleUnder || p.priceWholesaleFrom);
}
function priceLine(scope) {
  const unitW = scope.priceUnitWholesale ? `/${scope.priceUnitWholesale}` : '';
  const unitR = scope.priceUnitRetail ? `/${scope.priceUnitRetail}` : '';
  const until = scope.priceValidUntil ? ` (hiệu lực đến ${scope.priceValidUntil})` : '';
  const parts = [];
  if(scope.priceRetail) {
    parts.push(`giá mua dùng ${formatPrice(scope.priceRetail)}${unitR}${scope.packSizeRetail ? ` ${scope.packSizeRetail}` : ''}`);
  }
  const whole = [];
  if(hasBand(scope)) {
    if(scope.priceWholesaleUnder) whole.push(`dưới 1 thùng ${formatPrice(scope.priceWholesaleUnder)}${unitW}`);
    if(scope.priceWholesaleFrom) whole.push(`từ 1 thùng ${formatPrice(scope.priceWholesaleFrom)}${unitW}`);
  } else if(scope.priceWholesale) whole.push(`${formatPrice(scope.priceWholesale)}${unitW}`);
  if(whole.length) parts.push(`giá buôn ${whole.join(', ')}`);
  return parts.length ? `${parts.join('; ')}${until}` : '';
}
// Audience-labelled price lines. The document states who each price is for, so
// the model selects a tier instead of reading out both tables.
function productPriceLines(p, indent='') {
  const unitR = p.priceUnitRetail ? `/${p.priceUnitRetail}` : '';
  const unitW = p.priceUnitWholesale ? `/${p.priceUnitWholesale}` : '';
  const until = p.priceValidUntil ? ` (hiệu lực đến ${p.priceValidUntil})` : '';
  const out = [];
  if(p.priceRetail) out.push(`${indent}Giá mua dùng (khách mua về dùng gia đình, liên hoan): ${formatPrice(p.priceRetail)}${unitR}${p.packSizeRetail ? ` ${p.packSizeRetail}` : ''}${until}`);
  if(hasBand(p)) {
    const pack = p.packSizeWholesale ? ` — quy cách ${p.packSizeWholesale}` : '';
    out.push(`${indent}Giá buôn (bếp ăn, nhà hàng, khách sạn, quán lẩu nướng)${pack}:`);
    if(p.priceWholesaleUnder) out.push(`${indent}- Dưới 1 thùng: ${formatPrice(p.priceWholesaleUnder)}${unitW}${until}`);
    if(p.priceWholesaleFrom) out.push(`${indent}- Từ 1 thùng trở lên: ${formatPrice(p.priceWholesaleFrom)}${unitW}${until}`);
  } else if(p.priceWholesale) {
    const pack = p.packSizeWholesale ? ` — quy cách ${p.packSizeWholesale}` : '';
    out.push(`${indent}Giá buôn (bếp ăn, nhà hàng, khách sạn, quán lẩu nướng)${pack}: ${formatPrice(p.priceWholesale)}${unitW}${until}`);
  }
  return out;
}
export function cleanupValue(value) {
  return String(value ?? '').trim().replace(/[.,;:…\s]+$/, '').trim();
}
export function inferCategory(name, explicit='') {
  const text = normalize(`${explicit} ${name}`);
  // Word-boundary style matching: bare substrings such as "ca" match inside "canh"
  // and misclassify pork cuts as cá, so every animal term is anchored.
  if(/(^| )bo($| )|ba chi bo|bap bo|suon bo|gau bo|gu hoa|de suon/.test(text)) return 'bò';
  if(/trau/.test(text)) return 'trâu';
  if(/(^| )ga($| )|chan ga|toi ga|ga nguyen/.test(text)) return 'gà';
  if(/(^| )heo($| )|(^| )lon($| )|gio |khoanh gio|canh buom|mong |tim heo|xuong ong|sun non|nac vai/.test(text)) return 'heo';
  if(/(^| )ca($| )|ca hoi|salmon/.test(text)) return 'cá';
  return explicit || '';
}
function productFromRow(row, meta={}) {
  const name = val(row, ['Tên sản phẩm','Danh mục','Sản phẩm','Mặt hàng','Tên hàng','Product','Name']);
  if(!name) return null;
  // 'Danh mục' is the product column in the operator sheets, so an explicit group
  // column must be unambiguous rather than matching it by substring.
  const category = inferCategory(name, cleanupValue(val(row, ['Nhóm','Nhóm hàng','Loại','Category'])));
  const brand = cleanupValue(val(row, ['Thương hiệu','Nhãn hiệu','Brand']));
  const traits = uniq([val(row, ['Đặc tính','Mô tả','Đặc điểm','Traits','Description'])]);
  const useCases = uniq([val(row, ['Công dụng','Món phù hợp','Ứng dụng','Dùng cho','Use case','Best for'])]);
  const origins = uniq([val(row, ['Xuất xứ','Origin','Nguồn gốc'])]).map(cleanupValue).filter(Boolean);
  const notes = uniq([val(row, ['Ghi chú','Lưu ý','Note','Notes'])]).map(cleanupValue).filter(Boolean);
  const brandNames = uniq([brand]).map(cleanupValue).filter(Boolean);
  const prices = priceFromRow(row);
  // When the row names a brand, the price belongs to that brand only — putting it
  // on the product too would advertise one brand's price for the whole product.
  const brandPriced = brandNames.length > 0;
  const productPrices = brandPriced
    ? {priceRetail:'', priceWholesale:'', priceUnit:prices.priceUnit, priceValidUntil:prices.priceValidUntil}
    : prices;
  const keywords = uniq([
    name,
    category,
    ...brandNames,
    val(row, ['Từ khóa','Keyword','Keywords']),
    ...useCases
  ]);
  const image = val(row, ['Ảnh','Image','Link ảnh','Photo','URL ảnh']);
  const product = {
    id: slug(val(row, ['ID','Mã','SKU','Code']) || name),
    name,
    category,
    origins,
    brands: brandNames.map(b => ({name:b, traits, bestFor:useCases, ...(brandPriced ? prices : {})})),
    useCases,
    notes,
    keywords,
    images: image ? [`image-${slug(name)}`] : [],
    approved: true,
    source: meta,
    ...productPrices
  };
  if(image) product.imageSource = image;
  return product;
}
function mergeProduct(existing, incoming) {
  const brands = [...(existing.brands ?? [])];
  for(const b of incoming.brands ?? []) {
    const i = brands.findIndex(x => normalize(x.name) === normalize(b.name));
    if(i >= 0) brands[i] = {
      ...brands[i],
      traits: uniq([brands[i].traits ?? [], b.traits ?? []]),
      bestFor: uniq([brands[i].bestFor ?? [], b.bestFor ?? []]),
      // A table that carries no price column must never wipe a price already
      // imported by the other table.
      priceRetail: b.priceRetail || brands[i].priceRetail || '',
      priceWholesale: b.priceWholesale || brands[i].priceWholesale || '',
      priceWholesaleUnder: b.priceWholesaleUnder || brands[i].priceWholesaleUnder || '',
      priceWholesaleFrom: b.priceWholesaleFrom || brands[i].priceWholesaleFrom || '',
      priceUnitRetail: b.priceUnitRetail || brands[i].priceUnitRetail || '',
      packSizeRetail: b.packSizeRetail || brands[i].packSizeRetail || '',
      priceUnitWholesale: b.priceUnitWholesale || brands[i].priceUnitWholesale || '',
      packSizeWholesale: b.packSizeWholesale || brands[i].packSizeWholesale || '',
      priceValidUntil: b.priceValidUntil || brands[i].priceValidUntil || ''
    };
    else brands.push(b);
  }
  return {
    ...existing,
    ...incoming,
    origins: uniq([existing.origins ?? [], incoming.origins ?? []]),
    brands,
    useCases: uniq([existing.useCases ?? [], incoming.useCases ?? []]),
    notes: uniq([existing.notes ?? [], incoming.notes ?? []]),
    keywords: uniq([existing.keywords ?? [], incoming.keywords ?? []]),
    images: uniq([existing.images ?? [], incoming.images ?? []]),
    priceRetail: incoming.priceRetail || existing.priceRetail || '',
    priceWholesale: incoming.priceWholesale || existing.priceWholesale || '',
    priceWholesaleUnder: incoming.priceWholesaleUnder || existing.priceWholesaleUnder || '',
    priceWholesaleFrom: incoming.priceWholesaleFrom || existing.priceWholesaleFrom || '',
    priceUnitRetail: incoming.priceUnitRetail || existing.priceUnitRetail || '',
    packSizeRetail: incoming.packSizeRetail || existing.packSizeRetail || '',
    priceUnitWholesale: incoming.priceUnitWholesale || existing.priceUnitWholesale || '',
    packSizeWholesale: incoming.packSizeWholesale || existing.packSizeWholesale || '',
    priceValidUntil: incoming.priceValidUntil || existing.priceValidUntil || '',
    approved: incoming.approved ?? existing.approved ?? true
  };
}
function contentForProduct(p) {
  const lines = [`Tên sản phẩm: ${p.name}`];
  if(p.category) lines.push(`Nhóm: ${p.category}`);
  if(p.origins?.length) lines.push(`Xuất xứ: ${p.origins.join(', ')}`);
  if(p.brands?.length) {
    lines.push('Thương hiệu/biến thể:');
    // Brands sourced from one sheet row share one description; group them so the
    // document does not repeat the same paragraph per brand.
    const grouped = new Map();
    for(const b of p.brands) {
      const details = [
        b.traits?.length ? `đặc tính ${b.traits.join(', ')}` : '',
        b.bestFor?.length ? `phù hợp ${b.bestFor.join(', ')}` : '',
        priceLine(b)
      ].filter(Boolean).join('; ');
      grouped.set(details, [...(grouped.get(details) ?? []), b.name]);
    }
    for(const [details, names] of grouped) {
      lines.push(`- ${names.join(', ')}${details ? `: ${details}` : ''}`);
    }
  }
  lines.push(...productPriceLines(p));
  if(p.useCases?.length) lines.push(`Công dụng/món phù hợp: ${p.useCases.join(', ')}`);
  if(p.notes?.length) lines.push(`Ghi chú: ${p.notes.join('; ')}`);
  if(p.images?.length) lines.push(`Ảnh: ${p.images.join(', ')}`);
  return lines.join('\n');
}
function knowledgeDocForProduct(p) {
  return {
    id: `product-${p.id}`,
    title: p.name,
    keywords: uniq([
      p.name,
      p.category,
      p.keywords ?? [],
      p.origins ?? [],
      p.useCases ?? [],
      p.brands?.map(b => b.name) ?? [],
      // Retrieval scores keyword hits, so a price question needs its own keyword
      // or it competes with every other product on the bare product name.
      hasPrice(p) ? [`giá ${p.name}`, `bảng giá ${p.name}`] : []
    ]),
    content: contentForProduct(p),
    approved: p.approved === true,
    validUntil: null
  };
}
function categoryDocs(products) {
  const groups = new Map();
  for(const p of products.filter(p => p.approved === true && p.category)) {
    const arr = groups.get(p.category) ?? [];
    arr.push(p.name);
    groups.set(p.category, arr);
  }
  return [...groups.entries()].map(([category,names]) => ({
    id: `category-${slug(category)}`,
    title: `Nhóm sản phẩm ${category}`,
    keywords: uniq([category, `sản phẩm ${category}`, `nhóm ${category}`, ...names]),
    content: `Nhóm ${category} hiện có: ${uniq(names).join(', ')}.`,
    approved: true,
    validUntil: null
  }));
}
function imageRecordForProduct(p) {
  if(!p.imageSource) return null;
  const source = String(p.imageSource).trim();
  const rec = {
    id: `image-${p.id}`,
    title: p.name,
    keywords: uniq([p.name, p.category, p.keywords ?? []]),
    caption: `Ảnh sản phẩm ${p.name}.`,
    approved: true
  };
  if(/^https:\/\//.test(source)) rec.url = source;
  else rec.file = source;
  return rec;
}
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for(let i=0;i<text.length;i++) {
    const ch = text[i], next = text[i+1];
    if(ch === '"' && quoted && next === '"') { cell += '"'; i++; continue; }
    if(ch === '"') { quoted = !quoted; continue; }
    if(ch === ',' && !quoted) { row.push(cell); cell=''; continue; }
    if((ch === '\n' || ch === '\r') && !quoted) {
      if(ch === '\r' && next === '\n') i++;
      row.push(cell); rows.push(row); row=[]; cell=''; continue;
    }
    cell += ch;
  }
  if(cell || row.length) { row.push(cell); rows.push(row); }
  const headers = rows.shift()?.map(h => h.trim()) ?? [];
  return rows.map(values => Object.fromEntries(headers.map((h,i) => [h, values[i] ?? ''])));
}
async function loadRows(file) {
  const ext = extname(file).toLowerCase();
  if(ext === '.json') {
    const data = JSON.parse(readFileSync(file,'utf8'));
    if(Array.isArray(data)) return [{sheet:'json', rows:data}];
    if(Array.isArray(data.products)) return [{sheet:'products', rows:data.products}];
    if(Array.isArray(data.rows)) return [{sheet:data.sheet ?? 'rows', rows:data.rows}];
    throw new Error('JSON import file must be an array or contain products/rows');
  }
  if(ext === '.csv') return [{sheet:'csv', rows:parseCsv(readFileSync(file,'utf8'))}];
  if(['.xlsx','.xlsm'].includes(ext)) {
    const code = `
import json, sys, zipfile, xml.etree.ElementTree as ET
NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
RNS = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
def col_index(ref):
    n = 0
    for ch in ref:
        if ch.isalpha(): n = n * 26 + (ord(ch.upper()) - 64)
        else: break
    return n - 1
def row_number(ref):
    digits = ''.join(ch for ch in ref if ch.isdigit())
    return int(digits) if digits else 0
path = sys.argv[1]
z = zipfile.ZipFile(path)
shared = []
if 'xl/sharedStrings.xml' in z.namelist():
    root = ET.fromstring(z.read('xl/sharedStrings.xml'))
    for si in root.findall(NS + 'si'):
        shared.append(''.join(t.text or '' for t in si.iter(NS + 't')))
rels = {}
if 'xl/_rels/workbook.xml.rels' in z.namelist():
    rel_root = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
    for rel in rel_root:
        rels[rel.get('Id')] = rel.get('Target') or ''
wb = ET.fromstring(z.read('xl/workbook.xml'))
sheets = []
for index, sh in enumerate(wb.iter(NS + 'sheet'), start=1):
    target = rels.get(sh.get(RNS + 'id')) or ('worksheets/sheet%d.xml' % index)
    target = target.lstrip('/')
    if not target.startswith('xl/'): target = 'xl/' + target
    sheets.append((sh.get('name'), target))
out = []
for name, target in sheets:
    if target not in z.namelist():
        out.append({'sheet': name, 'rows': []})
        continue
    root = ET.fromstring(z.read(target))
    grid = {}
    max_col = -1
    for row in root.iter(NS + 'row'):
        for c in row.findall(NS + 'c'):
            ref = c.get('r') or ''
            kind = c.get('t')
            v = c.find(NS + 'v')
            inline = c.find(NS + 'is')
            if kind == 's' and v is not None:
                value = shared[int(v.text)]
            elif kind == 'inlineStr' and inline is not None:
                value = ''.join(x.text or '' for x in inline.iter(NS + 't'))
            elif v is not None:
                value = v.text or ''
            else:
                value = ''
            r, ci = row_number(ref), col_index(ref)
            if not r or ci < 0: continue
            grid[(r, ci)] = str(value).strip()
            if ci > max_col: max_col = ci
    rows_raw = sorted(set(k[0] for k in grid))
    # Header detection must run on raw cells: a merged title row (A3:G3) would
    # otherwise expand into a fake full-width header row.
    header_row = None
    for r in rows_raw[:20]:
        values = [grid.get((r, c), '') for c in range(0, max_col + 1)]
        if len([v for v in values if v]) >= 2:
            header_row = r
            break
    if header_row is None:
        out.append({'sheet': name, 'rows': []})
        continue
    headers = [grid.get((header_row, c), '') for c in range(0, max_col + 1)]
    # Excel keeps a merged value only in the top-left cell; copy it across the
    # range below the header so continuation rows keep category/origin.
    for m in root.iter(NS + 'mergeCell'):
        ref = m.get('ref') or ''
        if ':' not in ref: continue
        a, b = ref.split(':', 1)
        r1, c1 = row_number(a), col_index(a)
        r2, c2 = row_number(b), col_index(b)
        if r1 <= header_row: continue
        value = grid.get((r1, c1), '')
        if not value: continue
        for r in range(r1, r2 + 1):
            for c in range(c1, c2 + 1):
                if not grid.get((r, c)): grid[(r, c)] = value
    records = []
    for r in sorted(set(k[0] for k in grid)):
        if r <= header_row: continue
        values = [grid.get((r, c), '') for c in range(0, max_col + 1)]
        if not any(values): continue
        rec = {}
        for i, h in enumerate(headers):
            if h: rec[h] = values[i] if i < len(values) else ""
        if any(str(v).strip() for v in rec.values()):
            records.append(rec)
    out.append({'sheet': name, 'rows': records})
print(json.dumps(out, ensure_ascii=False))
`;
    const r = spawnSync('python3', ['-c', code, file], {encoding:'utf8', maxBuffer:32*1024*1024});
    if(r.status !== 0) throw new Error(`Excel parser failed: ${r.stderr || r.stdout}`);
    return JSON.parse(r.stdout);
  }
  throw new Error(`Unsupported import file extension: ${ext}`);
}
export function selectSheets(rowsBySheet, only) {
  const wanted = (only ?? []).map(s => normalize(String(s))).filter(Boolean);
  if(!wanted.length) return rowsBySheet;
  const picked = rowsBySheet.filter(s => wanted.includes(normalize(s.sheet)));
  assert(picked.length, `No sheet matched --sheet ${only.join(', ')}. Sheets in file: ${rowsBySheet.map(s => s.sheet).join(', ')}`);
  return picked;
}
export async function buildImportPlan({file, runtimeDir, sheets}) {
  const productsFile = resolve(runtimeDir, 'products.json');
  const knowledgeFile = resolve(runtimeDir, 'knowledge.json');
  const imageCatalogFile = resolve(runtimeDir, 'images/catalog.json');
  const rowsBySheet = selectSheets(await loadRows(file), sheets);
  const incoming = [];
  for(const {sheet, rows} of rowsBySheet) {
    rows.map(compactRow).forEach((row,index) => {
      const p = productFromRow(row, {file:basename(file), sheet, row:index+2});
      if(p) incoming.push(p);
    });
  }
  const currentProducts = readJson(productsFile, {schemaVersion:1, products:[]});
  assert(currentProducts.schemaVersion === 1 && Array.isArray(currentProducts.products), 'Invalid products catalog');
  const byId = new Map(currentProducts.products.map(p => [p.id,p]));
  const added = [], updated = [], skipped = [];
  for(const p of incoming) {
    const existing = byId.get(p.id) ?? currentProducts.products.find(x => normalize(x.name) === normalize(p.name));
    if(existing) {
      const merged = mergeProduct(existing, p);
      byId.delete(existing.id);
      byId.set(merged.id, merged);
      updated.push({id:merged.id, name:merged.name});
    } else {
      byId.set(p.id, p);
      added.push({id:p.id, name:p.name});
    }
  }
  const products = [...byId.values()].sort((a,b) => a.name.localeCompare(b.name, 'vi'));
  const existingKnowledge = readJson(knowledgeFile, {schemaVersion:1, documents:[]});
  const productDocIds = new Set(products.map(p => `product-${p.id}`));
  const generatedDocs = [...products.map(knowledgeDocForProduct), ...categoryDocs(products)];
  const generatedIds = new Set([...productDocIds, ...generatedDocs.map(d => d.id).filter(id => id.startsWith('category-'))]);
  const preservedDocs = (existingKnowledge.documents ?? []).filter(d => !generatedIds.has(d.id));
  const knowledge = {schemaVersion:1, documents:[...preservedDocs, ...generatedDocs]};
  const existingImages = readJson(imageCatalogFile, {schemaVersion:1, images:[]});
  const imageById = new Map((existingImages.images ?? []).map(i => [i.id,i]));
  for(const p of products) {
    const img = imageRecordForProduct(p);
    if(img) imageById.set(img.id, {...(imageById.get(img.id) ?? {}), ...img});
  }
  const images = {schemaVersion:1, images:[...imageById.values()].sort((a,b) => a.title.localeCompare(b.title, 'vi'))};
  return {
    paths:{productsFile, knowledgeFile, imageCatalogFile},
    summary:{importedRows: incoming.length, added, updated, skipped, totalProducts:products.length, totalKnowledgeDocs:knowledge.documents.length, totalImages:images.images.length, withRetailPrice:products.filter(p => p.priceRetail || p.brands?.some(b => b.priceRetail)).length, withWholesalePrice:products.filter(p => p.priceWholesale || p.priceWholesaleUnder || p.priceWholesaleFrom || p.brands?.some(b => b.priceWholesale || b.priceWholesaleUnder || b.priceWholesaleFrom)).length},
    products:{schemaVersion:1, products},
    knowledge,
    images
  };
}
function printPreview(plan) {
  const {summary} = plan;
  console.log(`Import preview`);
  console.log(`- Rows parsed: ${summary.importedRows}`);
  console.log(`- Products total: ${summary.totalProducts}`);
  console.log(`- Add: ${summary.added.length}`);
  console.log(`- Update/merge: ${summary.updated.length}`);
  console.log(`- Knowledge docs after apply: ${summary.totalKnowledgeDocs}`);
  console.log(`- Image records after apply: ${summary.totalImages}`);
  console.log(`- Products with retail price: ${summary.withRetailPrice ?? 0}`);
  console.log(`- Products with wholesale price: ${summary.withWholesalePrice ?? 0}`);
  for(const item of summary.added.slice(0,10)) console.log(`  + ${item.name} (${item.id})`);
  for(const item of summary.updated.slice(0,10)) console.log(`  ~ ${item.name} (${item.id})`);
  console.log('\nUse --apply to write runtime files after reviewing this preview.');
}
function applyPlan(plan) {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g,'').slice(0,14);
  mkdirSync(dirname(plan.paths.productsFile), {recursive:true, mode:0o700});
  mkdirSync(dirname(plan.paths.imageCatalogFile), {recursive:true, mode:0o700});
  const backups = [
    backup(plan.paths.productsFile, stamp),
    backup(plan.paths.knowledgeFile, stamp),
    backup(plan.paths.imageCatalogFile, stamp)
  ].filter(Boolean);
  writeJson(plan.paths.productsFile, plan.products);
  writeJson(plan.paths.knowledgeFile, plan.knowledge);
  writeJson(plan.paths.imageCatalogFile, plan.images);
  return backups;
}
if(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const file = resolve(arg('--file') ?? '');
    assert(file && process.argv.includes('--file'), 'Usage: npm run import-products -- --file products.xlsx --runtime /runtime [--sheet "Tên sheet"] [--preview|--apply]');
    const runtimeArg = arg('--runtime');
    const envArg = arg('--env');
    let runtimeDir = runtimeArg ? resolve(runtimeArg) : '';
    if(!runtimeDir && envArg) {
      const envFile = resolve(envArg);
      const env = parseEnv(readFileSync(envFile, 'utf8'));
      const config = runtimeConfigFromEnv(env);
      runtimeDir = dirname(resolve(config.database));
      if(runtimeDir.endsWith('/data')) runtimeDir = dirname(runtimeDir);
    }
    assert(runtimeDir, 'Provide --runtime /path/to/page-cskh-runtime or --env /path/to/.env');
    const plan = await buildImportPlan({file, runtimeDir, sheets:args('--sheet')});
    if(has('--json')) console.log(JSON.stringify(plan.summary, null, 2));
    else printPreview(plan);
    if(has('--apply')) {
      const backups = applyPlan(plan);
      console.log(`\nApplied product import.`);
      if(backups.length) console.log(`Backups:\n${backups.map(b => `- ${b}`).join('\n')}`);
    }
  } catch(e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}

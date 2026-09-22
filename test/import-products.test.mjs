import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildImportPlan,cleanupValue,inferCategory,selectSheets } from '../scripts/import-products.mjs';

function runtime(t) {
  const dir=mkdtempSync(join(tmpdir(),'page-cskh-import-test-'));
  mkdirSync(dir,{recursive:true});
  return dir;
}

test('category inference never reads an animal term out of the middle of another word',()=>{
  // "canh" contains "ca": without anchored terms this pork cut was classified as cá.
  assert.equal(inferCategory('Sườn cánh buồm'),'heo');
  assert.equal(inferCategory('Khoanh giò trước'),'heo');
  // "gàu" contains "ga": the beef cut must not become gà.
  assert.equal(inferCategory('Gàu bò'),'bò');
  assert.equal(inferCategory('Cá hồi'),'cá');
  assert.equal(inferCategory('Gà nguyên con'),'gà');
  assert.equal(inferCategory('Tỏi gà'),'gà');
  assert.equal(inferCategory('Ba chỉ heo'),'heo');
  assert.equal(inferCategory('Nạc dăm trâu 65'),'trâu');
  assert.equal(inferCategory('Xương ống heo'),'heo');
});

test('explicit group column overrides an unknown name without echoing the product name',()=>{
  assert.equal(inferCategory('Khoanh giò trước','heo'),'heo');
  assert.equal(inferCategory('Mặt hàng mới','heo'),'heo');
  assert.equal(inferCategory('Mặt hàng mới'),'');
});

test('trailing ellipsis and punctuation are stripped from imported values',()=>{
  assert.equal(cleanupValue('Miratorg.....'),'Miratorg');
  assert.equal(cleanupValue('Aqua....'),'Aqua');
  assert.equal(cleanupValue('  Nga,  '),'Nga');
  assert.equal(cleanupValue(null),'');
});

test('sheet selection keeps one sheet and reports unknown names',()=>{
  const rows=[{sheet:'Đặc tính SP',rows:[]},{sheet:'Khoán T3',rows:[]}];
  assert.deepEqual(selectSheets(rows,[]).map(s=>s.sheet),['Đặc tính SP','Khoán T3']);
  assert.deepEqual(selectSheets(rows,['khoan t3']).map(s=>s.sheet),['Khoán T3']);
  assert.throws(()=>selectSheets(rows,['Không có']),/No sheet matched/);
});

test('xlsx import keeps rows that Excel stores as a merged cell and ignores the merged title row',t=>{
  const dir=runtime(t);
  const xlsx=join(dir,'spec.xlsx');
  const generator=join(dir,'make_fixture.py');
  writeFileSync(generator,`
import sys, zipfile
strings = ["TITLE","STT","Danh Muc","Xuat xu","Thuong hieu","Ba chi heo","Nga","APK","VLMK","Doanh so","Lan anh","553"]
def shared_xml():
    items = ''.join('<si><t>%s</t></si>' % s for s in strings)
    return '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">%s</sst>' % items
def cell(ref, idx):
    return '<c r="%s" t="s"><v>%s</v></c>' % (ref, idx)
def sheet(rows, merges):
    body = ''.join('<row r="%d">%s</row>' % (r, ''.join(cell(ref, idx) for ref, idx in cells)) for r, cells in rows)
    merged = '<mergeCells count="%d">%s</mergeCells>' % (len(merges), ''.join('<mergeCell ref="%s"/>' % m for m in merges)) if merges else ''
    return '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>%s</sheetData>%s</worksheet>' % (body, merged)
sheet1 = sheet(
    [(1, [("A1", 0)]),
     (2, [("A2", 1), ("B2", 2), ("C2", 3), ("D2", 4)]),
     (3, [("A3", 1), ("B3", 5), ("C3", 6), ("D3", 7)]),
     (4, [("D4", 8)])],
    ["A1:B1", "B3:B4", "C3:C4"])
sheet2 = sheet(
    [(1, [("A1", 9), ("B1", 2)]),
     (2, [("A2", 10), ("B2", 11)])],
    [])
workbook = '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Dac tinh SP" sheetId="1" r:id="rId1"/><sheet name="Khoan T3" sheetId="2" r:id="rId2"/></sheets></workbook>'
rels = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>'
with zipfile.ZipFile(sys.argv[1], "w") as z:
    z.writestr("xl/workbook.xml", workbook)
    z.writestr("xl/_rels/workbook.xml.rels", rels)
    z.writestr("xl/sharedStrings.xml", shared_xml())
    z.writestr("xl/worksheets/sheet1.xml", sheet1)
    z.writestr("xl/worksheets/sheet2.xml", sheet2)
`);
  const made=spawnSync('python3',[generator,xlsx],{encoding:'utf8'});
  assert.equal(made.status,0,`fixture generation failed: ${made.stderr||made.stdout}`);
  assert.equal(existsSync(xlsx),true);

  const filtered=spawnSync(process.execPath,['-e',`
    import { buildImportPlan } from ${JSON.stringify(new URL('../scripts/import-products.mjs',import.meta.url).href)};
    const plan=await buildImportPlan({file:${JSON.stringify(xlsx)},runtimeDir:${JSON.stringify(dir)},sheets:['Dac tinh SP']});
    console.log(JSON.stringify(plan.summary));
  `],{encoding:'utf8'});
  assert.equal(filtered.status,0,`import failed: ${filtered.stderr||filtered.stdout}`);
  const summary=JSON.parse(filtered.stdout.trim());
  assert.equal(summary.totalProducts,1);
  assert.equal(summary.added.length,1);
  assert.equal(summary.added[0].name,'Ba chi heo');
});

test('importing an operator sheet never creates products from internal numbers',async t=>{
  const dir=runtime(t);
  const file=join(dir,'rows.json');
  writeFileSync(file,JSON.stringify([
    { 'Doanh số':'Lan anh',T2:'553',T3:'620' },
    { 'Danh Mục':'Ba chỉ heo','Xuất xứ':'Nga','Thương hiệu':'APK, VLMK','Đặc tính':'Thơm ngon','Công dụng':'Hấp luộc' }
  ]));
  const all=await buildImportPlan({file,runtimeDir:dir});
  assert.equal(all.products.products.length,1);
  assert.equal(all.products.products[0].name,'Ba chỉ heo');
  assert.deepEqual(all.products.products[0].brands.map(b=>b.name),['APK','VLMK']);
  assert.equal(all.knowledge.documents.filter(d=>d.id.startsWith('product-')).length,1);
  assert.deepEqual(all.knowledge.documents.filter(d=>d.id.startsWith('category-')).map(d=>d.title),['Nhóm sản phẩm heo']);
});

test('a sheet with no image column never invents approved image records',async t=>{
  const dir=runtime(t);
  const file=join(dir,'rows.json');
  writeFileSync(file,JSON.stringify([
    { 'Danh Mục':'Ba chỉ heo','Xuất xứ':'Nga','Thương hiệu':'APK','Đặc tính':'Thơm ngon','Công dụng':'Hấp luộc' }
  ]));
  const plan=await buildImportPlan({file,runtimeDir:dir});
  // "Danh Mục" must not satisfy the "Ảnh" alias.
  assert.deepEqual(plan.images.images,[]);
  assert.equal(plan.products.products[0].imageSource,undefined);
  const doc=plan.knowledge.documents.find(d=>d.id==='product-ba-chi-heo');
  assert.doesNotMatch(doc.content,/Ảnh:/);
});

test('brands that share one sheet description render as a single grouped line',async t=>{
  const dir=runtime(t);
  const file=join(dir,'rows.json');
  writeFileSync(file,JSON.stringify([
    { 'Danh Mục':'Ba chỉ heo','Xuất xứ':'Nga','Thương hiệu':'APK, VLMK, Miratorg','Đặc tính':'Thơm ngon','Công dụng':'Hấp luộc' }
  ]));
  const plan=await buildImportPlan({file,runtimeDir:dir});
  const doc=plan.knowledge.documents.find(d=>d.id==='product-ba-chi-heo');
  assert.match(doc.content,/- APK, VLMK, Miratorg: đặc tính Thơm ngon/);
  assert.equal(doc.content.split('\n').filter(l=>l.startsWith('- ')).length,1);
});

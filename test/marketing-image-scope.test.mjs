// Ca thật 19/10/2026: gọi /marketing/draft chỉ với prompt (không source_ids) làm
// danh sách ảnh gồm ảnh của mọi mặt hàng, model gán ảnh móng sau heo cho bài bắp
// chuột trâu (SEO 3/10). Hai hàng rào: suy tài liệu theo từ khoá và không coi ảnh
// của nháp đã huỷ là "đã dùng".
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { createMarketing,inferImageDocs,normalizeForMatch } from '../src/marketing.mjs';

const TRAU='product-bap-chuot-trau-64';
const HEO='product-mong-sau-heo';
const TRAU_IMGS=['bap-chuot-trau-64-allana-1','bap-chuot-trau-64-allana-2','bap-chuot-trau-64-allana-3'];
const HEO_IMGS=['mong-sau-heo-1','mong-sau-heo-2','mong-sau-heo-3'];
const PROMPT='AUTO_TOPIC: BẮP CHUỘT TRÂU 64 – THỊT TRÂU ẤN ĐỘ, MỀM THƠM, ĐA DẠNG MÓN XÀO – PHỞ – NƯỚNG – LẨU';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'page-cskh-scope-'));
  const c={
    pageId:'100',appId:'200',pageName:'TM Food',graphVersion:'v25.0',mode:'draft',agentId:'page-cskh',
    model:'provider/model',agentTimeoutMs:45000,adminPort:30000+Math.floor(Math.random()*1000),
    publicWebhookUrl:'https://example.test/webhooks/page-cskh',
    database:join(dir,'state.sqlite'),knowledgeFile:join(dir,'knowledge.json'),
    imageCatalogFile:join(dir,'images/catalog.json'),imageDir:join(dir,'images'),
    marketing:{enabled:true,approvalRequired:true,maxPostsPerDay:3,defaultTone:'thân thiện',timezone:'Asia/Ho_Chi_Minh',quietHours:'22:00-07:00',minScore:0,reviseAttempts:1,lowScoreAction:'warn'}
  };
  mkdirSync(c.imageDir,{recursive:true});
  writeFileSync(c.knowledgeFile,JSON.stringify({schemaVersion:1,documents:[
    {id:TRAU,title:'Bắp chuột trâu 64',keywords:['bắp chuột trâu 64','thịt trâu ấn độ','xào','phở','nướng','lẩu'],content:`Bắp chuột trâu 64 nhập khẩu Ấn Độ, thùng 20kg, chỉ bán buôn, hàng cấp đông sâu. Ảnh: ${TRAU_IMGS.join(', ')}`,approved:true,validUntil:null},
    {id:HEO,title:'Móng sau heo',keywords:['móng sau heo','heo nhập khẩu'],content:`Móng sau heo đông lạnh, thùng 10kg, chỉ bán buôn. Ảnh: ${HEO_IMGS.join(', ')}`,approved:true,validUntil:null}
  ]}));
  writeFileSync(c.imageCatalogFile,JSON.stringify({schemaVersion:1,images:[
    ...TRAU_IMGS.map((id,n)=>({id,title:'Ảnh bắp chuột trâu 64',keywords:['bắp chuột trâu 64','thịt trâu'],file:`trau${n}.jpg`,caption:'Bắp chuột trâu',approved:true})),
    ...HEO_IMGS.map((id,n)=>({id,title:'Ảnh móng sau heo',keywords:['móng sau heo'],file:`heo${n}.jpg`,caption:'Móng sau heo',approved:true}))
  ]}));
  const s=new Store(c.database,c.pageId);t.after(()=>s.close());
  return {dir,c,s};
}
const media=ids=>ids.map(id=>({type:'image',image_id:id}));
const trauDraft=()=>({
  topic:'bắp chuột trâu',title_internal:'Bắp chuột trâu 64 – món xào, phở, nướng, lẩu',
  caption:'BẮP CHUỘT TRÂU 64 – THỊT TRÂU ẤN ĐỘ, MỀM THƠM\nBắp chuột trâu 64 nhập khẩu Ấn Độ, thùng 20kg, chỉ bán buôn.\nXào, phở, nướng, lẩu đều lên món.\nHotline: 0976778755 và 0962365073\nInbox/comment để được tư vấn',
  hashtags:['TMFood','BapChuotTrau','NhaHang'],
  cta:'Inbox để được tư vấn',media:media(TRAU_IMGS),source_ids:[TRAU],risk_flags:[]
});

test('suy đúng tài liệu mặt hàng từ prompt không kèm source_ids',()=>{
  const docs=[{id:TRAU,title:'Bắp chuột trâu 64',keywords:['bắp chuột trâu 64','thịt trâu ấn độ']},
    {id:HEO,title:'Móng sau heo',keywords:['móng sau heo','heo nhập khẩu']}];
  const got=inferImageDocs(PROMPT,docs).map(d=>d.id);
  assert.deepEqual(got,[TRAU]);
  assert.equal(normalizeForMatch('BẮP CHUỘT TRÂU 64'),'bap chuot trau 64');
});

test('prompt không source_ids + nháp cũ đã huỷ dùng hết ảnh trâu ⇒ bài mới vẫn dùng ảnh trâu',async t=>{
  const {c,s}=fixture(t);
  // Nháp hôm trước dùng đúng 3 ảnh trâu rồi bị huỷ (chưa từng lên Page).
  const old=s.createMarketingPost({...trauDraft(),topic:'AUTO_TOPIC: BẮP CHUỘT TRÂU 64',caption:trauDraft().caption});
  s.updateMarketingPost(old.id,{status:'cancelled'});
  // Model vẫn trả về ảnh heo như ca thật; source_ids là tài liệu trâu.
  const complete=async ()=>JSON.stringify({...trauDraft(),media:media(HEO_IMGS)});
  const post=await createMarketing(c,s,complete,{}).createDraft({prompt:PROMPT});
  const ids=(JSON.parse(post.media||'[]')).map(m=>m.image_id);
  assert.deepEqual(ids,TRAU_IMGS,'bài trâu phải dùng ảnh trâu, không lấy ảnh móng sau heo');
  const flags=JSON.parse(post.risk_flags||'[]');
  assert.ok(!ids.some(id=>HEO_IMGS.includes(id)),'không được có ảnh móng sau heo');
  assert.ok(flags.length>=0);
});

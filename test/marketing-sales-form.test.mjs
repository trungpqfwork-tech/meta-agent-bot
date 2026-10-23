// Chủ Page chốt 19/10/2026: bài đăng KHÔNG nêu hình thức bán (bán buôn/bán sỉ/bán lẻ).
// Tài liệu KB vẫn có câu đó (dùng cho CSKH khi khách hỏi mua lẻ) nên bài viết phải lược.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { stripSalesFormLines,validateDraft,createMarketing } from '../src/marketing.mjs';

const CAPTION = [
  'Tôm thẻ hấp size 25 và size 28, hàng hấp chín sẵn, đóng thùng 10 kg bán buôn.',
  '',
  '🔥 Bếp ăn công nghiệp',
  '✔ Tôm đã hấp chín, cấp đông sâu, rã đông là dùng được ngay',
  '✔ Quy cách thùng 10 kg, đủ cho mẻ suất ăn đông người',
  '',
  '🍜 Quán lẩu nướng',
  '✔ Hàng chín sẵn, rã đông rồi thả lẩu hay nướng đều tiện',
  '✔ Mặt hàng chỉ bán buôn theo thùng, không bán lẻ',
  '✔ Mặt hàng bán buôn theo thùng, không bán lẻ',
  'Hình thức bán: bán buôn theo thùng',
  '',
  '📞 Hotline: 0976778755 và 0962365073',
  '💬 Inbox/comment để được tư vấn'
].join('\n');

test('lược mọi dòng hình thức bán, giữ nguyên dòng quy cách và CTA',()=>{
  const r=stripSalesFormLines(CAPTION);
  assert.ok(!/bán buôn|bán lẻ|hình thức bán/i.test(r.caption),'không còn chữ nào nói hình thức bán');
  assert.ok(r.caption.includes('✔ Quy cách thùng 10 kg, đủ cho mẻ suất ăn đông người'),'giữ dòng quy cách');
  assert.ok(r.caption.includes('Hotline: 0976778755 và 0962365073'),'giữ hotline');
  assert.ok(r.caption.includes('Tôm thẻ hấp size 25 và size 28, hàng hấp chín sẵn, đóng thùng 10 kg'),'câu mở vẫn trọn ý sau khi bỏ cụm cuối');
  assert.ok(r.removed.length>=4,'có ghi lại các dòng/cụm đã bỏ');
});

test('validateDraft gắn cờ sales_form_removed và không để lại chữ bán lẻ',()=>{
  const draft=validateDraft({caption:CAPTION,hashtags:['tom the hap'],media:[],source_ids:[],risk_flags:[]},{docs:[],images:[],config:{pageName:'TM Food'},topic:'tôm thẻ hấp'});
  assert.ok(draft.risk_flags.includes('sales_form_removed'),'có cờ sales_form_removed');
  assert.ok(!/bán lẻ/i.test(draft.caption));
  assert.ok(draft.caption.startsWith('Tôm thẻ hấp size 25'));
});

test('prompt gửi model có quy tắc cấm nêu hình thức bán',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'page-cskh-salesform-'));
  const c={pageId:'100',appId:'200',pageName:'TM Food',graphVersion:'v25.0',mode:'draft',agentId:'page-cskh',
    model:'provider/model',agentTimeoutMs:45000,adminPort:30000+Math.floor(Math.random()*1000),
    publicWebhookUrl:'https://example.test/webhooks/page-cskh',
    database:join(dir,'state.sqlite'),knowledgeFile:join(dir,'knowledge.json'),
    imageCatalogFile:join(dir,'images/catalog.json'),imageDir:join(dir,'images'),
    marketing:{enabled:true,approvalRequired:true,maxPostsPerDay:3,defaultTone:'thân thiện',timezone:'Asia/Ho_Chi_Minh',quietHours:'22:00-07:00',minScore:0,reviseAttempts:1,lowScoreAction:'warn'}};
  mkdirSync(c.imageDir,{recursive:true});
  writeFileSync(c.knowledgeFile,JSON.stringify({schemaVersion:1,documents:[{id:'product-tom-the-hap-size-25',title:'Tôm thẻ hấp size 25',keywords:['tôm thẻ hấp'],content:'Tôm thẻ hấp size 25, hàng chín sẵn, thùng 10 kg. Mặt hàng này chỉ bán buôn theo thùng, không bán lẻ. Hotline: 0976778755 và 0962365073',approved:true,validUntil:null}]}));
  writeFileSync(c.imageCatalogFile,JSON.stringify({schemaVersion:1,images:[1,2,3].map(n=>({id:`tom-the-hap-25-${n}`,title:'Ảnh tôm thẻ hấp',keywords:['tôm thẻ hấp'],file:`t${n}.jpg`,caption:'Ảnh tôm',approved:true}))}));
  const s=new Store(c.database,c.pageId);t.after(()=>s.close());
  const seen=[];
  const complete=async pr=>{seen.push(pr.prompt??pr.messages?.[0]?.content??JSON.stringify(pr));return JSON.stringify({
    topic:'tôm thẻ hấp',title_internal:'Tôm thẻ hấp size 25',caption:'Tôm thẻ hấp size 25, hàng chín sẵn, thùng 10 kg.\n📞 Hotline: 0976778755 và 0962365073',
    hashtags:['tom the hap'],cta:'Inbox',media:[{type:'image',image_id:'tom-the-hap-25-1'}],source_ids:['product-tom-the-hap-size-25'],risk_flags:[]});};
  await createMarketing(c,s,complete,{}).createDraft({prompt:'tôm thẻ hấp',sourceIds:['product-tom-the-hap-size-25']});
  assert.ok(seen.length>=1,'có gọi model');
  assert.match(seen[0],/KHÔNG nêu hình thức bán/);
  assert.match(seen[0],/bán sỉ/);
  assert.match(seen[0],/KHÔNG tự so sánh với thương hiệu khác/);
});

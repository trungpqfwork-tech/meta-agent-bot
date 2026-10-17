import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { createMarketing,POST_ANGLES,pickAngle,captionRepeatRatio,REPEAT_MAX_RATIO,stripDanglingQuestions,stripFreshClaimForCooked } from '../src/marketing.mjs';

const CAP_A = [
  '🥩 LÕI VAI BÒ ACC - THỊT BÒ NHẬP KHẨU ÚC, BÁN BUÔN THEO THÙNG 20-24KG',
  '🔥 Lõi vai bò ACC nhập khẩu Úc, hàng dùng công nghệ cấp đông sâu nên khi rã đông và sử dụng, chất lượng được giữ gần như hàng tươi sống.',
  '✅ Phù hợp cho:',
  '- 🍲 Bếp ăn',
  '- 🍛 Nhà hàng',
  '- 🏨 Khách sạn',
  '- 🥘 Quán lẩu nướng',
  '💯 TM Food - nguồn hàng bò nhập khẩu Úc cho bếp ăn, nhà hàng, khách sạn, quán lẩu nướng.',
  '✔ Lõi vai bò ACC, xuất xứ Úc',
  '✔ Quy cách thùng 20 - 24kg',
  '✔ Mặt hàng bán buôn theo thùng, không bán lẻ',
  '📞 Hotline: 0976778755 và 0962365073',
  '💬 Inbox/comment để được tư vấn'
].join('\n');
const CAP_B = CAP_A.replace('LÕI VAI BÒ ACC','DẢI HEO NHẬP KHẨU NGA').replace('Lõi vai bò ACC nhập khẩu Úc','Dải heo nhập khẩu Nga')
  .replace('Lõi vai bò ACC, xuất xứ Úc','Dải heo nhập khẩu từ Nga')
  .replace('Quy cách thùng 20 - 24kg','Quy cách thùng 10kg, bán buôn theo thùng');
const CAP_NEW = 'Dải heo Nga về thùng 10kg cho quán nướng. Hàng cấp đông sâu, rã đông là dùng được ngay.\nAnh chị lấy cho quán hay cho gia đình ạ?\n📞 Hotline: 0976778755 và 0962365073\n💬 Inbox/comment để được tư vấn';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'page-cskh-angle-'));
  const c={
    pageId:'100',appId:'200',pageName:'TM Food',graphVersion:'v25.0',mode:'draft',agentId:'page-cskh',model:'provider/model',agentTimeoutMs:45000,adminPort:30000+Math.floor(Math.random()*10000),
    publicWebhookUrl:'https://example.test/webhooks/page-cskh',
    database:join(dir,'state.sqlite'),knowledgeFile:join(dir,'knowledge.json'),imageCatalogFile:join(dir,'images/catalog.json'),imageDir:join(dir,'images'),
    marketing:{enabled:true,approvalRequired:true,maxPostsPerDay:3,defaultTone:'thân thiện',timezone:'Asia/Ho_Chi_Minh',quietHours:'22:00-07:00',minScore:0,reviseAttempts:1,lowScoreAction:'warn'}
  };
  mkdirSync(c.imageDir,{recursive:true});
  writeFileSync(c.knowledgeFile,JSON.stringify({schemaVersion:1,documents:[{id:'product-dai-heo',title:'Dải heo',keywords:['dải heo'],content:'Dải heo nhập khẩu Nga, thùng 10kg, chỉ bán buôn. Hotline: 0976778755 và 0962365073',approved:true,validUntil:null}]}));
  writeFileSync(c.imageCatalogFile,JSON.stringify({schemaVersion:1,images:[1,2,3].map(n=>({id:`dai-heo-${n}`,title:'Ảnh dải heo',keywords:['dải heo'],file:`dh${n}.jpg`,caption:'Ảnh dải heo',approved:true}))}));
  const s=new Store(c.database,c.pageId);t.after(()=>s.close());
  return {dir,c,s};
}
const draftJson=(caption)=>({topic:'dải heo',title_internal:'Dải heo',caption,hashtags:['TMFood','DaiHeoNga','ThucPhamDongLanh'],cta:'Inbox để được tư vấn',media:[{type:'image',image_id:'dai-heo-1'},{type:'image',image_id:'dai-heo-2'},{type:'image',image_id:'dai-heo-3'}],source_ids:['product-dai-heo'],risk_flags:[]});

test('có 5 dạng bài và luân phiên không lặp 2 dạng gần nhất',()=>{
  assert.equal(POST_ANGLES.length,5);
  assert.equal(POST_ANGLES[0].id,'mon-cach-dung');
  const first=pickAngle([]);
  assert.equal(first.id,'mon-cach-dung');
  const second=pickAngle([first.id]);
  assert.notEqual(second.id,first.id);
  const third=pickAngle([second.id,first.id]);
  assert.ok(![second.id,first.id].includes(third.id),'dạng thứ 3 không được trùng 2 dạng gần nhất');
  const exclude=pickAngle([first.id],{exclude:[POST_ANGLES[1].id]});
  assert.ok(![first.id,POST_ANGLES[1].id].includes(exclude.id));
});

test('đo được tỉ lệ dòng trùng giữa 2 bài',()=>{
  const r=captionRepeatRatio(CAP_A,[{id:'bai-cu',caption:CAP_B}]);
  assert.ok(r.ratio>REPEAT_MAX_RATIO,'bài 2 bài khuân mẫu phải vượt ngưỡng 40%, đo được '+r.ratio);
  const fresh=captionRepeatRatio(CAP_NEW,[{id:'bai-cu',caption:CAP_B}]);
  assert.ok(fresh.ratio<REPEAT_MAX_RATIO,'bài viết mới không được vượt ngưỡng, đo được '+fresh.ratio);
});

test('bài trùng khung bị viết lại bằng dạng khác và ghi lại dạng đã dùng',async t=>{
  const {c,s}=fixture(t);
  s.createMarketingPost(draftJson(CAP_B));
  const seen=[];
  const complete=async ({message})=>{
    seen.push(String(message));
    return JSON.stringify(draftJson(seen.length===1?CAP_A:CAP_NEW));
  };
  const post=await createMarketing(c,s,complete,{}).createDraft({prompt:'viết bài dải heo'});
  assert.equal(seen.length,2,'phải sinh lại 1 lần vì trùng khung');
  const first=seen[0].match(/DẠNG BÀI HÔM NAY: "([^"]+)"/)[1];
  const second=seen[1].match(/DẠNG BÀI HÔM NAY: "([^"]+)"/)[1];
  assert.notEqual(first,second,'lượt viết lại phải đổi dạng bài');
  assert.match(seen[1],/trùng \d+% số dòng/,'lượt viết lại phải nêu lý do trùng khung');
  assert.match(seen[0],/QUY TẮC CAPTION/);
  assert.doesNotMatch(seen[0],/FORMAT BẮT BUỘC/,'không còn khuôn bắt buộc 6 khối');
  assert.equal(post.caption,CAP_NEW,'bài lưu phải là bản viết lại');
  assert.ok(!JSON.parse(post.risk_flags||'[]').some(f=>/^template_repeat_/.test(f)),'bản viết lại không còn cờ trùng khung');
  const recent=JSON.parse(s.getMeta('marketing.recent_angles'));
  assert.equal(recent[0],POST_ANGLES.find(a=>a.name===second).id,'dạng đã dùng phải được ghi lại');
});

test('viết lại vẫn trùng khung thì gắn cờ template_repeat để chủ Page soát',async t=>{
  const {c,s}=fixture(t);
  s.createMarketingPost(draftJson(CAP_B));
  let calls=0;
  const complete=async ()=>{ calls++; return JSON.stringify(draftJson(CAP_A)); };
  const post=await createMarketing(c,s,complete,{}).createDraft({prompt:'viết bài dải heo'});
  assert.equal(calls,2,'lượt đầu + 1 lượt viết lại vì trùng khung');
  const flags=JSON.parse(post.risk_flags||'[]');
  assert.ok(flags.some(f=>/^template_repeat_\d+pct$/.test(f)),'phải có cờ template_repeat, có: '+flags.join(','));
});

test('bỏ câu hỏi trống, giữ câu hỏi có trả lời', () => {
  const bad='Mực ống làm sạch, khách hay hỏi mấy câu dưới đây 🦑\n\n❓ Rã đông có mất vị không?\n\n❓ Đóng gói theo quy cách nào?\n→ Túi 2kg cho khách mua về dùng.\n\n📞 Hotline: 0976778755 và 0962365073';
  const r=stripDanglingQuestions(bad);
  assert.equal(r.removed.length,1);
  assert.ok(!/mất vị/.test(r.caption),'câu hỏi trống bị bỏ');
  assert.ok(/Đóng gói theo quy cách nào/.test(r.caption),'câu hỏi có trả lời được giữ');
  assert.ok(/Túi 2kg/.test(r.caption),'câu trả lời giữ nguyên');
  const ok=stripDanglingQuestions('❓ Đóng gói theo quy cách nào?\n→ Túi 2kg.');
  assert.equal(ok.removed.length,0);
});

test('câu hỏi nhắc "hàng chín" không bị coi là khẳng định hàng chín', () => {
  const question='Mực ống làm sạch sơ chế sẵn 🦑\n\n❓ Hàng đông lạnh hay hàng chín?\n→ Hàng cấp đông sâu, rã đông là chế biến được.\n\nHàng cấp đông sâu, chất lượng giữ gần như hàng tươi sống.';
  const r=stripFreshClaimForCooked(question);
  assert.equal(r.removed.length,0,'không cắt câu so sánh của hàng sống');
  const cooked='Tôm thẻ hấp, hàng hấp chín sẵn, đóng thùng 10 kg.\n\nChất lượng giữ gần như hàng tươi sống.';
  const r2=stripFreshClaimForCooked(cooked);
  assert.equal(r2.removed.length,1);
  assert.ok(!/tươi sống/.test(r2.caption));
});

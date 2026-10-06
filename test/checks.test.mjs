import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Worker,UNDERSTAND_PROMPT,SUMMARY_PROMPT,moneyValues,unsupportedMoney } from '../src/worker.mjs';

const KB={schemaVersion:1,documents:[
  {id:'product-ca-hoi',title:'Cá hồi',keywords:['cá hồi','cá'],content:'Tên sản phẩm: Cá hồi\nGiá mua dùng: 250.000đ/kg con 4 - 5kg',approved:true,validUntil:null},
  {id:'product-ca-hoi-cat-khuc-khuc-giua',title:'Cá hồi cắt khúc (khúc giữa)',keywords:['cá hồi cắt khúc','khúc giữa'],content:'Giá mua dùng: 299.000đ/kg khay thực tế',approved:true,validUntil:null},
  {id:'category-ca',title:'Nhóm cá',keywords:['nhóm cá'],content:'Nhóm cá gồm cá hồi, cá trứng.',approved:true,validUntil:null},
  {id:'policy-gia',title:'Chính sách giá',keywords:['giá'],content:'Giá đã bao gồm VAT. Giá buôn chia mốc dưới 1 thùng và từ 1 thùng.',approved:true,validUntil:null}
]};
const TTL=6*3600;

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'page-cskh-checks-'));
  const knowledgeFile=join(dir,'knowledge.json');
  writeFileSync(knowledgeFile,JSON.stringify(KB));
  mkdirSync(join(dir,'agent'),{recursive:true});
  const c={schemaVersion:1,pageId:'100',appId:'200',agentId:'page-cskh',pageName:'TM Food',model:'m',graphVersion:'v25.0',
    scopeDescription:'Chỉ tư vấn sản phẩm của Page.',scopeKeywords:['giá','sản phẩm'],
    handoffText:'Em chuyển nhân viên nhé.',outOfScopeText:'Em chỉ hỗ trợ sản phẩm ạ.',clarifyText:'Anh/chị cần gì ạ?',
    mode:'draft',knowledgeFile,workspace:join(dir,'agent'),database:join(dir,'data/state.sqlite'),
    imageDir:join(dir,'images'),imageCatalogFile:join(dir,'images/catalog.json'),
    messageDebounceSeconds:0,sessionTtlSeconds:TTL,waitingResetSeconds:0,enableHumanHandoff:true,
    maxDailyAgentCalls:100,maxCustomerCallsPerHour:50,agentTimeoutMs:45000,adminPort:18891,edgePort:18892,
    webhookPath:'/webhooks/page-cskh',publicWebhookUrl:'https://x.test/webhooks/page-cskh',orderTelegramChatIds:[]};
  const s=new Store(c.database,c.pageId,{sessionTtlSeconds:c.sessionTtlSeconds});
  t.after(()=>s.close());
  return {c,s,dir};
}
const say=(s,c,id,text,at)=>s.ingest([{psid:'111',id,kind:'customer',text,at}],c);
const drain=(s)=>{let j;while((j=s.next())) s.finish(j.id,'sent');};

function harness(c,s,{answer='Dạ cá hồi 250.000đ/kg ạ.',check='{"inScope":true,"supported":true}',throwOnRetry=false}={}) {
  let generate=0;
  const complete=async ({system,message})=>{
    const payload=JSON.parse(message);
    if(system===UNDERSTAND_PROMPT) return JSON.stringify({cau_hoi_da_hieu:'khách hỏi giá cá hồi',san_pham:['Cá hồi'],nhom:['cá'],y_dinh:'hỏi giá',nhom_khach:'personal',chinh_sach:['giá'],tin_nhan_tiep_theo:'giá cá hồi'});
    if(system===SUMMARY_PROMPT) return JSON.stringify({summary:'Phiên trước: khách hỏi giá cá hồi cho gia đình, đã báo 250.000đ/kg.'});
    if(system.includes('bộ kiểm tra')) return check;
    if(system.includes('bộ trích xuất thông tin đặt hàng')) return JSON.stringify({wantsOrder:false,customerType:null,customerName:null,phone:null,address:null,products:[],notes:null,ready:false});
    generate++;
    if(throwOnRetry && generate>1) throw new Error('Hermes completion failed: boom');
    return JSON.stringify({action:'reply',text:answer,sourceIds:[payload.documents[0]?.id??'policy-gia'],reason:'ok'});
  };
  const worker=new Worker(c,s,complete,{send:async()=>{throw new Error('draft must not send');}},{enabled:false,notifyOrder:async()=>0});
  worker.logFile=join(c.workspace,'logs','worker.log');
  return {worker,stats:()=>({generate})};
}

test('đọc được số tiền ở nhiều cách viết',t=>{
  assert.deepEqual(moneyValues('250.000đ/kg'),[250000]);
  assert.deepEqual(moneyValues('299.000 đ/kg'),[299000]);
  assert.deepEqual(moneyValues('213k'),[213000]);
  assert.deepEqual(moneyValues('1,2 triệu'),[1200000]);
  assert.deepEqual(moneyValues('con 4 - 5kg'),[],'số lượng không phải tiền');
  assert.deepEqual(moneyValues('1kg'),[]);
});

test('số tiền không có trong tài liệu bị coi là bịa',t=>{
  const docs=[{content:'Giá mua dùng: 250.000đ/kg'}];
  assert.deepEqual(unsupportedMoney('Dạ 250.000đ/kg ạ',docs,''),[]);
  assert.deepEqual(unsupportedMoney('Dạ 999.000đ/kg ạ',docs,''),[999000]);
  assert.deepEqual(unsupportedMoney('Anh nói 300k đúng không ạ?',docs,'bán 300k không em'),[],'khách đã nói thì được nhắc lại');
});

test('câu trả lời bịa giá bị chặn trước khi gửi và handoff sau 2 lượt',async t=>{
  const {c,s,dir}=fixture(t);
  const {worker,stats}=harness(c,s,{answer:'Dạ cá hồi 999.000đ/kg ạ. Em chốt đơn nhé.'});
  say(s,c,'a','Cho anh giá cá hồi',1700000000000);
  await worker.process(s.next());
  assert.equal(stats().generate,2,'phải sinh lại 1 lần trước khi handoff');
  const snap=s.snapshot();
  assert.equal(snap.jobs[0].status,'draft');
  assert.equal(snap.conversations[0].state,'WAITING','handoff sau khi cả 2 lượt đều sai giá');
  assert.equal(snap.jobs[0].reply,'Em chuyển nhân viên nhé.');
  const log=readFileSync(join(dir,'agent','logs','worker.log'),'utf8');
  assert.match(log,/numeric_fail .*values=\[999000\]/,'phải ghi log số tiền bịa');
});

test('câu trả lời đúng giá trong tài liệu được gửi',async t=>{
  const {c,s}=fixture(t);
  const {worker}=harness(c,s,{answer:'Dạ cá hồi 250.000đ/kg (con 4 - 5kg) ạ.'});
  say(s,c,'a','Cho anh giá cá hồi',1700000000000);
  await worker.process(s.next());
  assert.equal(s.snapshot().jobs[0].status,'draft');
  assert.match(s.snapshot().jobs[0].reply,/250\.000đ\/kg/);
});

test('lỗi runtime ở lượt thử lại thì requeue, không handoff',async t=>{
  const {c,s}=fixture(t);
  const {worker}=harness(c,s,{answer:'Dạ cá hồi 999.000đ/kg ạ.',throwOnRetry:true});
  say(s,c,'a','Cho anh giá cá hồi',1700000000000);
  await worker.process(s.next());
  const jobs=s.snapshot().jobs;
  assert.equal(jobs[0].status,'pending','job phải quay lại hàng đợi');
  assert.equal(s.snapshot().conversations[0].state,'BOT','không được handoff vì lỗi hạ tầng');
  assert.ok(s.db.prepare("SELECT 1 FROM audit WHERE action='job_requeue'").get(),'phải ghi audit requeue');
});

test('doc danh mục của nhóm đang bàn được chèn vào tập tài liệu',async t=>{
  const {c,s}=fixture(t);
  let docs=null;
  const complete=async ({system,message})=>{
    const payload=JSON.parse(message);
    if(system===UNDERSTAND_PROMPT) return JSON.stringify({cau_hoi_da_hieu:'khách hỏi giá cá hồi',san_pham:['Cá hồi'],nhom:['cá'],y_dinh:'hỏi giá',nhom_khach:'personal',chinh_sach:['giá'],tin_nhan_tiep_theo:''});
    if(system.includes('bộ kiểm tra')) return '{"inScope":true,"supported":true}';
    if(system.includes('bộ trích xuất thông tin đặt hàng')) return '{"wantsOrder":false,"products":[]}';
    docs=payload.documents.map(d=>d.id);
    return JSON.stringify({action:'reply',text:'Dạ em tư vấn ạ.',sourceIds:[payload.documents[0].id]});
  };
  const worker=new Worker(c,s,complete,{send:async()=>{throw new Error('draft');}},{enabled:false,notifyOrder:async()=>0});
  worker.logFile=join(c.workspace,'logs','worker.log');
  say(s,c,'a','Cho anh giá cá hồi',1700000000000);
  await worker.process(s.next());
  assert.ok(docs.includes('category-ca'),'phải có doc danh mục cá, có: '+docs.join(','));
});

test('doc chính sách không bị trần 8 doc cắt mất',async t=>{
  const {c,s}=fixture(t);
  let docs=null;
  const complete=async ({system,message})=>{
    const payload=JSON.parse(message);
    if(system===UNDERSTAND_PROMPT) return JSON.stringify({cau_hoi_da_hieu:'khách hỏi giá ba chỉ bò',san_pham:['Ba chỉ bò'],nhom:['bò'],y_dinh:'hỏi giá',nhom_khach:'personal',chinh_sach:['giá'],tin_nhan_tiep_theo:''});
    if(system.includes('bộ kiểm tra')) return '{"inScope":true,"supported":true}';
    if(system.includes('bộ trích xuất thông tin đặt hàng')) return '{"wantsOrder":true,"products":["ba chỉ bò","ba chỉ bò Excel","cá hồi"]}';
    docs=payload.documents.map(d=>d.id);
    return JSON.stringify({action:'reply',text:'Dạ em báo giá ạ.',sourceIds:[payload.documents[0].id]});
  };
  const worker=new Worker(c,s,complete,{send:async()=>{throw new Error('draft');}},{enabled:false,notifyOrder:async()=>0});
  worker.logFile=join(c.workspace,'logs','worker.log');
  say(s,c,'a','Cho anh hỏi ba chỉ bò',1700000000000);
  await worker.process(s.next());
  assert.ok(docs.includes('policy-gia'),'policy-gia phải sống sót qua trần 8 doc, có: '+docs.join(','));
  assert.ok(docs.length<=8,'trần 8 doc vẫn phải giữ');
});

test('nén summary chạy nền khi khách đã sang phiên mới',async t=>{
  const {c,s}=fixture(t);
  const {worker}=harness(c,s);
  const base=1700000000000;
  say(s,c,'a','Cho anh giá cá hồi',base);
  say(s,c,'b','Gia đình đi',base+60*1000);
  drain(s);
  say(s,c,'c','chào em',base+TTL*1000+120*1000);
  drain(s);
  assert.equal(s.session('111').summaryPending,true);
  await worker.compactSummaries();
  const session=s.session('111');
  assert.equal(session.summaryPending,false,'nén xong phải gỡ khỏi hàng đợi');
  assert.match(session.summary,/250\.000đ\/kg/);
  assert.equal(s.summaryQueue().length,0);
});

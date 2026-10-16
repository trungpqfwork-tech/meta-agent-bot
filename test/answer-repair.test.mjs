import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Worker,UNDERSTAND_PROMPT,SUMMARY_PROMPT,ANSWER_REPAIR_PROMPT,EXTRACT_ORDER_PROMPT } from '../src/worker.mjs';
import { agentPolicy } from '../src/knowledge.mjs';

// Ngữ cảnh: 16/10/2026 bot trả lời khách "Dải heo là tấm ba chỉ nguyên" (bịa cấu tạo
// mặt hàng + mượn món của ba chỉ heo). Bộ kiểm 2 lớp đã chấm câu đó là không đủ căn cứ,
// nhưng theo hành vi cũ câu bị chấm vẫn được gửi nguyên. Chủ Page chốt: viết lại một
// lần chỉ với dữ kiện trong tài liệu rồi mới gửi.

test('agentPolicy cấm tự định nghĩa mặt hàng và mượn món của mặt hàng khác',()=>{
  assert.match(agentPolicy,/dải heo là tấm ba chỉ nguyên/,'luật ví dụ bịa cấu tạo đã bị gỡ');
  assert.match(agentPolicy,/mượn món hay đặc điểm của mặt hàng khác/,'luật cấm mượn món mặt hàng khác đã bị gỡ');
  assert.match(agentPolicy,/CHÍNH mặt hàng/,'luật phạm vi tài liệu theo đúng mặt hàng đã bị gỡ');
  assert.match(ANSWER_REPAIR_PROMPT,/viết lại câu trả lời/);
});

const KB={schemaVersion:1,documents:[
  {id:'product-dai-heo',title:'Dải heo',keywords:['dải heo'],content:'Tên sản phẩm: Dải heo\nNhóm: heo\nXuất xứ: Nga\nGiá buôn — Thùng 10kg: Từ 1 thùng trở lên 95.000đ/kg',approved:true,validUntil:null},
  {id:'product-ba-chi-heo',title:'Ba chỉ heo',keywords:['ba chỉ heo'],content:'Tên sản phẩm: Ba chỉ heo\nCông dụng/món phù hợp: Hấp luộc, rang cháy cạnh',approved:true,validUntil:null},
  {id:'policy-gia',title:'Chính sách giá',keywords:['giá'],content:'Giá đã bao gồm VAT.',approved:true,validUntil:null}
]};
const TTL=6*3600;

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'page-cskh-repair-'));
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

const BAD='Dải heo là tấm ba chỉ nguyên nên quán nướng thường thái lát nướng, hấp luộc/rang cháy cạnh đều ngon ạ.';

function harness(c,s,{repaired,repairRepairs=true}={}) {
  let generate=0, repairSeen=null, checkCalls=0;
  const complete=async ({system,message})=>{
    const payload=JSON.parse(message);
    if(system===UNDERSTAND_PROMPT) return JSON.stringify({cau_hoi_da_hieu:'dải heo chế biến món gì',san_pham:['Dải heo'],nhom:['heo'],y_dinh:'hỏi đặc tính',nhom_khach:null,chinh_sach:[],tin_nhan_tiep_theo:'dải heo nấu gì'});
    if(system===SUMMARY_PROMPT) return JSON.stringify({summary:''});
    if(system===EXTRACT_ORDER_PROMPT||system.includes('bộ trích xuất thông tin đặt hàng')) return JSON.stringify({wantsOrder:false,customerType:null,customerName:null,phone:null,address:null,products:[],notes:null,ready:false});
    if(system.includes('bộ viết lại')) {
      repairSeen={system,message:payload};
      return JSON.stringify({action:'reply',text:repaired,sourceIds:[payload.documents[0]?.id??'product-dai-heo'],reason:'rewritten'});
    }
    if(system.includes('bộ kiểm tra')) { checkCalls++; return '{"inScope":true,"supported":false}'; }
    generate++;
    return JSON.stringify({action:'reply',text:BAD,sourceIds:['product-dai-heo']});
  };
  const worker=new Worker(c,s,complete,{send:async()=>{throw new Error('draft must not send');}},{enabled:false,notifyOrder:async()=>0});
  worker.logFile=join(c.workspace,'logs','worker.log');
  return {worker,stats:()=>({generate,checkCalls,repairSeen,repaired})};
}

test('câu bị chấm không đủ căn cứ được viết lại trước khi gửi',async t=>{
  const {c,s}=fixture(t);
  const {worker,stats}=harness(c,s,{repaired:'Dạ tài liệu bên em chưa ghi món riêng cho dải heo ạ. Dải heo nhập từ Nga, chỉ bán buôn theo thùng 10kg.'});
  s.ingest([{psid:'111',id:'a',kind:'customer',text:'Dải heo chế biến món gì ngon em',at:1792140951828}],c);
  await worker.process(s.next());
  const job=s.snapshot().jobs[0];
  assert.equal(job.reply,stats().repaired,'phải gửi bản viết lại, không gửi câu bị chấm là bịa');
  assert.ok(!/tấm ba chỉ nguyên/.test(job.reply),'câu bịa không được lọt ra khách');
  assert.equal(stats().generate,2,'sinh câu trả lời 2 lượt như cũ');
  assert.equal(stats().checkCalls,2,'chấm 2 lượt như cũ');
  assert.ok(stats().repairSeen,'phải gọi bộ viết lại một lần');
  assert.equal(stats().repairSeen.message.answer,BAD.slice(0,1800),'bộ viết lại phải nhận đúng câu bị chấm');
  assert.deepEqual(stats().repairSeen.message.nhan_xet_kiem,{inScope:true,supported:false},'phải kèm lý do bị chấm');
  assert.ok(s.db.prepare("SELECT 1 FROM audit WHERE action='verify_failed_rewritten'").get(),'phải ghi audit viết lại');
  assert.ok(!s.db.prepare("SELECT 1 FROM audit WHERE action='verify_failed_sent'").get(),'không còn audit gửi nguyên câu bị chấm');
  assert.equal(s.snapshot().conversations[0].state,'BOT','không handoff: khách vẫn được trả lời');
});

test('bộ viết lại bịa giá thì bỏ, quay về hành vi cũ (gửi bản cũ + audit)',async t=>{
  const {c,s}=fixture(t);
  const {worker}=harness(c,s,{repaired:'Dạ dải heo 999.000đ/kg ạ.'});
  s.ingest([{psid:'111',id:'a',kind:'customer',text:'Dải heo chế biến món gì ngon em',at:1792140951828}],c);
  await worker.process(s.next());
  const job=s.snapshot().jobs[0];
  assert.equal(job.reply,BAD,'giá bịa thì không dùng bản viết lại');
  assert.ok(s.db.prepare("SELECT 1 FROM audit WHERE action='verify_failed_sent'").get(),'phải ghi audit gửi nguyên câu bị chấm');
  assert.ok(!s.db.prepare("SELECT 1 FROM audit WHERE action='verify_failed_rewritten'").get());
  const log=readFileSync(join(c.workspace,'logs','worker.log'),'utf8');
  assert.match(log,/verify_repair_unsupported_money .*values=\[999000\]/,'phải ghi log lý do bỏ bản viết lại');
});

test('lỗi hạ tầng ở bộ viết lại thì quay về hành vi cũ, không handoff',async t=>{
  const {c,s}=fixture(t);
  const {worker}=harness(c,s,{repaired:BAD});
  const original=worker.infer.bind(worker);
  worker.infer=async (j,message,system)=>{
    if(String(system).includes('bộ viết lại')) throw new Error('Hermes completion failed: boom');
    return original(j,message,system);
  };
  s.ingest([{psid:'111',id:'a',kind:'customer',text:'Dải heo chế biến món gì ngon em',at:1792140951828}],c);
  await worker.process(s.next());
  const job=s.snapshot().jobs[0];
  assert.equal(job.reply,BAD);
  assert.equal(s.snapshot().conversations[0].state,'BOT','lỗi hạ tầng không được handoff');
  const log=readFileSync(join(c.workspace,'logs','worker.log'),'utf8');
  assert.match(log,/verify_repair_failed/,'phải ghi log lỗi bộ viết lại');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Worker,UNDERSTAND_PROMPT } from '../src/worker.mjs';

const KB={schemaVersion:1,documents:[
  {id:'product-ca-hoi',title:'Cá hồi',keywords:['cá hồi','cá hồi nguyên con','cá'],content:'Tên sản phẩm: Cá hồi\nGiá mua dùng: 250.000đ/kg',approved:true,validUntil:null},
  {id:'product-ca-hoi-cat-khuc-khuc-giua',title:'Cá hồi cắt khúc (khúc giữa)',keywords:['cá hồi cắt khúc (khúc giữa)','cá hồi cắt khúc','khúc giữa'],content:'Giá mua dùng: 299.000đ/kg',approved:true,validUntil:null},
  {id:'product-ba-chi-bo',title:'Ba chỉ bò',keywords:['ba chỉ bò','ba chỉ','bò'],content:'Giá buôn dưới 1 thùng: 213.000đ/kg',approved:true,validUntil:null},
  {id:'category-ca',title:'Nhóm cá',keywords:['nhóm cá','cá'],content:'Nhóm cá gồm cá hồi, cá trứng.',approved:true,validUntil:null},
  {id:'policy-gia',title:'Chính sách giá',keywords:['giá','bảng giá','vat'],content:'Giá đã bao gồm VAT.',approved:true,validUntil:null}
]};

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'page-cskh-topic-'));
  const knowledgeFile=join(dir,'knowledge.json');
  writeFileSync(knowledgeFile,JSON.stringify(KB));
  mkdirSync(join(dir,'agent'),{recursive:true});
  const c={schemaVersion:1,pageId:'100',appId:'200',agentId:'page-cskh',pageName:'TM Food',model:'m',graphVersion:'v25.0',
    scopeDescription:'Chỉ tư vấn sản phẩm của Page.',scopeKeywords:['giá','sản phẩm'],
    handoffText:'Em chuyển nhân viên nhé.',outOfScopeText:'Em chỉ hỗ trợ sản phẩm ạ.',clarifyText:'Anh/chị cần gì ạ?',
    mode:'draft',knowledgeFile,workspace:join(dir,'agent'),database:join(dir,'data/state.sqlite'),
    imageCatalogFile:join(dir,'images/catalog.json'),imageDir:join(dir,'images'),
    messageDebounceSeconds:0,sessionTtlSeconds:21600,waitingResetSeconds:0,enableHumanHandoff:true,
    maxDailyAgentCalls:100,maxCustomerCallsPerHour:50,agentTimeoutMs:45000,adminPort:18891,edgePort:18892,
    webhookPath:'/webhooks/page-cskh',publicWebhookUrl:'https://x.test/webhooks/page-cskh',orderTelegramChatIds:[]};
  const s=new Store(c.database,c.pageId,{sessionTtlSeconds:c.sessionTtlSeconds});
  t.after(()=>s.close());
  return {c,s,dir};
}

// B1 trả chủ đề theo nội dung tin khách; ghi lại mọi lượt gọi để đếm.
function harness(c,s) {
  const calls={understand:0,answer:0,payloads:[]};
  const complete=async ({system,message})=>{
    const payload=JSON.parse(message);
    if(system===UNDERSTAND_PROMPT) {
      calls.understand++;
      const text=String(payload.currentMessage||'');
      const topic=/bò/.test(text)
        ? {cau_hoi_da_hieu:'khách hỏi giá ba chỉ bò',san_pham:['Ba chỉ bò'],nhom:['bò'],y_dinh:'hỏi giá',nhom_khach:'personal',chinh_sach:['giá'],tin_nhan_tiep_theo:'giá ba chỉ bò'}
        : {cau_hoi_da_hieu:'khách hỏi giá cá hồi cho gia đình',san_pham:['Cá hồi'],nhom:['cá'],y_dinh:'hỏi giá',nhom_khach:'personal',chinh_sach:['giá'],tin_nhan_tiep_theo:'giá cá hồi cho gia đình'};
      return JSON.stringify(topic);
    }
    if(system.includes('bộ kiểm tra')) return '{"inScope":true,"supported":true}';
    if(system.includes('bộ trích xuất thông tin đặt hàng')) return JSON.stringify({wantsOrder:false,customerType:null,customerName:null,phone:null,address:null,products:[],notes:null,ready:false});
    calls.answer++;
    calls.payloads.push(payload);
    return JSON.stringify({action:'reply',text:'Dạ em báo giá ạ.',sourceIds:[payload.documents[0]?.id??'policy-gia'],reason:'ok'});
  };
  const worker=new Worker(c,s,complete,{send:async()=>{throw new Error('draft must not send');}},{enabled:false,notifyOrder:async()=>0});
  return {worker,calls};
}
const say=(s,c,psid,id,text,at)=>s.ingest([{psid,id,kind:'customer',text,at}],c);

test('tin nối tiếp không có từ khoá vẫn ra đúng sản phẩm nhờ B1',async t=>{
  const {c,s}=fixture(t);
  const {worker,calls}=harness(c,s);
  const base=1700000000000;
  say(s,c,'111','a','Cho anh giá cá hồi',base);
  await worker.process(s.next());
  say(s,c,'111','b','Gia đình đi',base+60*1000);
  await worker.process(s.next());
  const last=calls.payloads.at(-1);
  assert.deepEqual(s.session('111').topic.san_pham,['Cá hồi']);
  assert.ok(last.documents.some(d=>d.id==='product-ca-hoi'),'tài liệu cá hồi phải được cấp cho lượt "Gia đình đi"');
  assert.deepEqual(last.topic.san_pham,['Cá hồi'],'payload phải chở topic của phiên');
  assert.equal(s.order('111').customer_type,'personal','B1 phân loại khách và ghi vào đơn');
  assert.ok(s.order('111').products.includes('Cá hồi'));
});

test('tin cùng chủ đề không gọi lại B1',async t=>{
  const {c,s}=fixture(t);
  const {worker,calls}=harness(c,s);
  const base=1700000000000;
  say(s,c,'111','a','Cho anh giá cá hồi',base);
  await worker.process(s.next());
  assert.equal(calls.understand,1);
  say(s,c,'111','b','Cá hồi nguyên con 4-5kg giá bao nhiêu em?',base+60*1000);
  await worker.process(s.next());
  assert.equal(calls.understand,1,'cùng chủ đề thì dùng lại topic, không tốn lượt hiểu');
  assert.equal(calls.answer,2);
});

test('khách đổi sang mặt hàng khác thì B1 chạy lại và topic đổi',async t=>{
  const {c,s}=fixture(t);
  const {worker,calls}=harness(c,s);
  const base=1700000000000;
  say(s,c,'111','a','Cho anh giá cá hồi',base);
  await worker.process(s.next());
  say(s,c,'111','b','Thế ba chỉ bò bao nhiêu 1 kg?',base+60*1000);
  await worker.process(s.next());
  assert.equal(calls.understand,2,'đổi mặt hàng phải hiểu lại');
  assert.deepEqual(s.session('111').topic.san_pham,['Ba chỉ bò']);
  assert.equal(calls.payloads.at(-1).documents[0].id,'product-ba-chi-bo','tài liệu phải theo mặt hàng mới');
});

test('phiên mới không mang chủ đề cũ sang, nhưng vẫn có summary',async t=>{
  const {c,s}=fixture(t);
  const {worker,calls}=harness(c,s);
  const base=1700000000000;
  say(s,c,'111','a','Cho anh giá cá hồi',base);
  await worker.process(s.next());
  s.saveSummary('111','Phiên trước: khách hỏi giá cá hồi cho gia đình, đã báo 250.000đ/kg.',base+60*1000);
  const later=base+21600*1000+120*1000;
  say(s,c,'111','b','chào em',later);
  await worker.process(s.next());
  const last=calls.payloads.at(-1);
  assert.equal(calls.understand,2,'phiên mới phải hiểu lại từ đầu');
  assert.deepEqual(last.history.map(h=>h.text),['chào em'],'chỉ tin trong phiên hiện tại đi vào history');
  assert.match(last.summary,/250\.000đ\/kg/,'summary của phiên cũ vẫn được chở theo');
});

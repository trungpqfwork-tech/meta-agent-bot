import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { Worker,openClawCompletion } from '../src/worker.mjs';
import { makeWebhook,normalizeEvents } from '../src/webhook.mjs';
import { applyEnvOverrides,loadConfig,loadSecrets,runtimeConfigFromEnv } from '../src/config.mjs';
import { metaClient } from '../src/meta.mjs';
import { parseModelJson,retrieve,validateAnswer } from '../src/knowledge.mjs';
import { retrieveImages } from '../src/images.mjs';
import { makePatch } from '../scripts/setup.mjs';
import { startAdmin } from '../src/admin.mjs';
import { buildImportPlan } from '../scripts/import-products.mjs';

function fixture(t,mode='draft') {
  const dir=mkdtempSync(join(tmpdir(),'page-cskh-test-'));
  const c={...JSON.parse(readFileSync(new URL('../config.example.json',import.meta.url))),pageId:'100',appId:'200',model:'provider/model',mode,workspace:join(dir,'agent'),envFile:join(dir,'.env'),database:join(dir,'data/state.sqlite'),knowledgeFile:join(dir,'knowledge.json'),messageDebounceSeconds:0};
  mkdirSync(c.workspace);
  const secrets={META_APP_SECRET:'s'.repeat(32),META_PAGE_ACCESS_TOKEN:'p'.repeat(32),META_WEBHOOK_VERIFY_TOKEN:'v'.repeat(32),CSKH_ADMIN_TOKEN:'a'.repeat(40)};
  writeFileSync(c.envFile,Object.entries(secrets).map(([k,v])=>`${k}=${v}`).join('\n'),{mode:0o600});
  writeFileSync(c.knowledgeFile,JSON.stringify({schemaVersion:1,documents:[{id:'hours',title:'Giờ',keywords:['giờ'],content:'Mở cửa 8h.',approved:true,validUntil:null}]}));
  const s=new Store(c.database,c.pageId);let closed=false;
  t.after(()=>{if(!closed)s.close();});
  return {c,s,secrets,dir,close:()=>{s.close();closed=true;}};
}
function inbound(psid='111',id='m1',text='mấy giờ?',at=Date.now()) {return {psid,id,kind:'customer',text,at};}
const answer=JSON.stringify({action:'reply',text:'Mở cửa 8h.',sourceIds:['hours'],reason:''});
function completion(message=answer) {return async ({system})=>system.includes('bộ kiểm tra')?'{"inScope":true,"supported":true}':message;}
test('dedup webhook batch and stable customer ownership',t=>{
  const {s}=fixture(t);assert.equal(s.ingest([inbound(),inbound()]),1);assert.equal(s.ingest([inbound()]),0);
  assert.equal(s.next().psid,'111');assert.equal(s.next(),null);
});
test('message debounce folds rapid customer messages into one delayed job',t=>{
  const {s,c}=fixture(t);c.messageDebounceSeconds=2;
  const base=1700000000000;
  assert.equal(s.ingest([inbound('111','a','xin chào',base)],c),1);
  assert.equal(s.next(),null);
  assert.equal(s.ingest([inbound('111','b','mình muốn hỏi giá',base+500)],c),1);
  assert.equal(s.snapshot().jobs.filter(j=>j.status==='pending').length,1);
  assert.equal(s.snapshot().jobs.filter(j=>j.status==='superseded').length,1);
  const created=s.snapshot().jobs.find(j=>j.status==='pending').created;
  assert.equal(s.next(created-1),null);
  const j=s.next(created);
  assert.equal(j.psid,'111');
  assert.equal(j.text,'xin chào\nmình muốn hỏi giá');
});
test('normalization rejects wrong Page and forged route',()=>{
  const payload={object:'page',entry:[{id:'100',messaging:[{sender:{id:'111'},recipient:{id:'999'},timestamp:Date.now(),message:{mid:'m1',text:'hi'}}]}]};
  assert.deepEqual(normalizeEvents(payload,'100'),[]);
});
test('two concurrent completions reversed still send to correct recipients',async t=>{
  const {s,c}=fixture(t,'live');s.ingest([inbound('111','a'),inbound('222','b')]);
  const a=s.next(),b=s.next(),sent=[];
  let release;const gate=new Promise(r=>release=r);
  const w=new Worker(c,s,async p=>{
    if(p.system.includes('bộ kiểm tra'))return '{"inScope":true,"supported":true}';
    const text=JSON.parse(p.message).currentMessage;
    if(text==='first giờ')await gate;
    return JSON.stringify({action:'reply',text,sourceIds:['hours']});
  },{send:async(psid,text)=>{sent.push({psid,text});return 'out-'+psid;}});
  a.text='first giờ';b.text='second giờ';
  const one=w.process(a);await w.process(b);release();await one;
  assert.deepEqual(sent,[{psid:'222',text:'second giờ'},{psid:'111',text:'first giờ'}]);
});
test('takeover while model running cancels late output',async t=>{
  const {s,c}=fixture(t,'live');s.ingest([inbound()]);let release;const gate=new Promise(r=>release=r);let sent=0;
  const w=new Worker(c,s,async()=>{await gate;return answer;},{send:async()=>{sent++;return 'x';}});
  const pending=w.process(s.next());s.takeover('111');release();await pending;
  assert.equal(sent,0);assert.equal(s.conversation('111').state,'HUMAN');assert.equal(s.snapshot().jobs[0].status,'cancelled');
});
test('new customer message while model is running cancels stale reply',async t=>{
  const {s,c}=fixture(t,'live');s.ingest([inbound('111','a','hi',1000)]);let release;const gate=new Promise(r=>release=r);let sent=0;
  const w=new Worker(c,s,async p=>{if(p.system.includes('bộ kiểm tra'))return '{"inScope":true,"supported":true}';await gate;return JSON.stringify({action:'social',text:'hello',sourceIds:[],reason:''});},{send:async()=>{sent++;return 'x';}});
  const pending=w.process(s.next());
  s.ingest([inbound('111','b','toi can hoi tro',2000)],c);
  release();await pending;
  assert.equal(sent,0);
  assert.equal(s.snapshot().jobs.find(j=>j.event_id==='100:a').status,'cancelled');
  assert.equal(s.next().text,'toi can hoi tro');
});
test('draft makes zero network sends',async t=>{
  const {s,c}=fixture(t);s.ingest([inbound()]);let sent=0;
  await new Worker(c,s,completion(),{send:async()=>sent++}).process(s.next());
  assert.equal(sent,0);assert.equal(s.snapshot().jobs[0].delivery,'draft');
});
test('handoff notifies once then incoming messages stay silent',async t=>{
  const {s,c}=fixture(t,'live');s.ingest([inbound()]);let sent=0;
  const w=new Worker(c,s,completion('{"action":"handoff","text":"","sourceIds":[],"reason":"missing"}'),{send:async()=>{sent++;return 'out1';}});
  await w.process(s.next());s.ingest([inbound('111','m2')]);assert.equal(s.next(),null);
  assert.equal(sent,1);assert.equal(s.conversation('111').state,'WAITING');
});
test('disabled human handoff keeps bot ownership for testing',async t=>{
  const {s,c}=fixture(t,'live');c.enableHumanHandoff=false;s.ingest([inbound()]);let sent=0;
  const w=new Worker(c,s,completion('{"action":"handoff","text":"","sourceIds":[],"reason":"missing"}'),{send:async()=>{sent++;return 'out1';}});
  await w.process(s.next());s.ingest([inbound('111','m2')]);
  assert.equal(sent,1);assert.equal(s.conversation('111').state,'BOT');assert.equal(s.next().text,'mấy giờ?');
});
test('suppressed handoff lets AI compose scoped fallback instead of generic clarify',async t=>{
  const {s,c}=fixture(t,'live');c.enableHumanHandoff=false;s.ingest([inbound('111','chem','chân gà có ngâm hóa chất k')]);let text='';
  const w=new Worker(c,s,async p=>{
    if(p.system.includes('Chỉ trả JSON {"text"')) return '{"text":"Dạ hiện dữ liệu em có chưa xác nhận thông tin ngâm hóa chất cho chân gà ạ. Anh/chị cho em xin đúng loại chân gà để nhân viên kiểm tra lại giúp nhé."}';
    return '{"action":"handoff","text":"","sourceIds":[],"reason":"missing_safety_data"}';
  },{send:async(_,v)=>{text=v;return 'out1';}});
  await w.process(s.next());
  assert.match(text,/ngâm hóa chất|chân gà|chưa xác nhận|nhân viên/);
  assert.notEqual(text,c.clarifyText);
});
test('generic clarify is rewritten by scoped AI fallback',async t=>{
  const {s,c}=fixture(t,'live');s.ingest([inbound('111','chem','chân gà có ngâm hóa chất k')]);let text='',fallbackCalls=0;
  const w=new Worker(c,s,async p=>{
    if(p.system.includes('Chỉ trả JSON {"text"')) {fallbackCalls++; return '{"text":"Dạ hiện dữ liệu em có chưa xác nhận vấn đề hóa chất của chân gà ạ. Em cần nhân viên kiểm tra thông tin này cho anh/chị."}';}
    return JSON.stringify({action:'clarify',text:c.clarifyText,sourceIds:[],reason:'missing_safety_data'});
  },{send:async(_,v)=>{text=v;return 'out1';}});
  await w.process(s.next());
  assert.equal(fallbackCalls,1);
  assert.match(text,/hóa chất|chân gà|nhân viên/);
  assert.notEqual(text,c.clarifyText);
});
test('awkward ordering handoff prose is rewritten when customer did not ask to order',async t=>{
  const {s,c}=fixture(t,'live');s.ingest([inbound('111','catalog','bên mình có sản phẩm gì?')]);let text='',fallbackCalls=0;
  const awkward='Anh/chị muốn tìm hiểu hoặc đặt nhóm nào ạ? Em chưa có thông tin về nhóm bò và quy trình đặt hàng chi tiết, cần chuyển nhân viên hỗ trợ thêm khi anh/chị chốt nhóm nhé.';
  const w=new Worker(c,s,async p=>{
    if(p.system.includes('Chỉ trả JSON {"text"')) {fallbackCalls++; return '{"text":"Dạ bên em có các nhóm bò, heo, trâu, gà và cá hồi ạ. Anh/chị đang muốn dùng để lẩu, nướng hay lấy theo nhóm nào để em tư vấn sát hơn?"}';}
    return JSON.stringify({action:'clarify',text:awkward,sourceIds:[],reason:'broad_catalog_question'});
  },{send:async(_,v)=>{text=v;return 'out1';}});
  await w.process(s.next());
  assert.equal(fallbackCalls,1);
  assert.match(text,/bò|heo|trâu|gà|cá hồi/);
  assert.doesNotMatch(text,/quy trình đặt hàng|chốt nhóm|chuyển nhân viên/);
});
test('order intake extracts and persists required customer fields',async t=>{
  const {s,c}=fixture(t,'live');s.ingest([inbound('111','order','em đặt 2kg ba chỉ bò, tên Nam, sdt 0912345678, giao 12 Láng Hạ, mua cá nhân')]);let text='';
  const notified=[];
  const w=new Worker(c,s,async p=>{
    if(p.system.includes('bộ trích xuất thông tin đặt hàng')) return JSON.stringify({wantsOrder:true,customerType:'personal',customerName:'Nam',phone:'0912345678',address:'12 Láng Hạ',products:['2kg ba chỉ bò'],notes:null,ready:true});
    if(p.system.includes('bộ kiểm tra')) return '{"inScope":true,"supported":true}';
    const payload=JSON.parse(p.message);
    assert.equal(payload.order.status,'ready');
    return JSON.stringify({action:'reply',text:'Dạ em đã ghi nhận đơn 2kg ba chỉ bò cho anh Nam, giao tới 12 Láng Hạ. Em sẽ chuyển xử lý bước tiếp theo ạ.',sourceIds:['hours'],reason:'order_ready'});
  },{send:async(_,v)=>{text=v;return 'out';}},{enabled:true,notifyOrder:async order=>{notified.push(order);return 2;}});
  await w.process(s.next());
  const order=s.order('111');
  assert.equal(order.status,'ready');
  assert.ok(order.notified_at > 0);
  assert.equal(notified.length,1);
  assert.equal(notified[0].psid,'111');
  assert.equal(order.customer_type,'personal');
  assert.equal(order.customer_name,'Nam');
  assert.equal(order.phone,'0912345678');
  assert.equal(order.address,'12 Láng Hạ');
  assert.deepEqual(order.products,['2kg ba chỉ bò']);
  assert.match(text,/ghi nhận đơn|ba chỉ bò|Nam/);
});
test('ready order notification is not sent twice',async t=>{
  const {s,c}=fixture(t,'live');
  s.saveOrder('111',{wantsOrder:true,customerType:'personal',customerName:'Nam',phone:'0912345678',address:'12 Láng Hạ',products:['2kg ba chỉ bò']});
  s.markOrderNotified('111');
  s.ingest([inbound('111','again','em bổ sung ghi chú giao buổi sáng')]);
  let count=0;
  const w=new Worker(c,s,async p=>{
    if(p.system.includes('bộ trích xuất thông tin đặt hàng')) return JSON.stringify({wantsOrder:true,customerType:null,customerName:null,phone:null,address:null,products:[],notes:'giao buổi sáng',ready:true});
    if(p.system.includes('bộ kiểm tra')) return '{"inScope":true,"supported":true}';
    return JSON.stringify({action:'reply',text:'Dạ em đã cập nhật ghi chú giao buổi sáng ạ.',sourceIds:['hours'],reason:'order_update'});
  },{send:async()=> 'out'},{enabled:true,notifyOrder:async()=>{count++;return 1;}});
  await w.process(s.next());
  assert.equal(count,0);
  assert.ok(s.order('111').notified_at > 0);
});
test('handoff alerts the consultant on Telegram and holds the conversation',async t=>{
  const {s,c}=fixture(t,'live');
  s.ingest([inbound('111','hand','chân gà có ngâm hóa chất k')]);
  const alerts=[];
  const w=new Worker(c,s,async()=>JSON.stringify({action:'handoff',text:'',sourceIds:[],reason:'missing_safety_data'}),
    {send:async()=> 'out'},{enabled:true,notifyOrder:async()=>0,notifyHandoff:async info=>{alerts.push(info);return 1;}});
  await w.process(s.next());
  assert.equal(alerts.length,1);
  assert.equal(alerts[0].psid,'111');
  assert.equal(alerts[0].reason,'missing_safety_data');
  assert.deepEqual(alerts[0].messages,['chân gà có ngâm hóa chất k']);
  assert.equal(s.conversation('111').state,'WAITING');
});

test('handoff alert is not repeated for a job that already alerted',async t=>{
  const {s,c}=fixture(t,'live');
  s.ingest([inbound('111','hand2','chân gà có ngâm hóa chất k')]);
  const job=s.next();
  s.markHandoffNotified(job.psid,job.id);
  const alerts=[];
  const w=new Worker(c,s,async()=>JSON.stringify({action:'handoff',text:'',sourceIds:[],reason:'missing_safety_data'}),
    {send:async()=> 'out'},{enabled:true,notifyOrder:async()=>0,notifyHandoff:async info=>{alerts.push(info);return 1;}});
  await w.process(job);
  assert.equal(alerts.length,0);
  assert.equal(s.conversation('111').state,'WAITING');
});

test('suppressed handoff does not alert the consultant',async t=>{
  const {s,c}=fixture(t,'live');
  c.enableHumanHandoff=false;
  s.ingest([inbound('111','sup','chân gà có ngâm hóa chất k')]);
  const alerts=[];
  const w=new Worker(c,s,async p=>{
    if(p.system.includes('Chỉ trả JSON {"text"')) return '{"text":"Dạ dữ liệu em có chưa xác nhận vấn đề này, em xin phép kiểm tra lại ạ."}';
    return JSON.stringify({action:'handoff',text:'',sourceIds:[],reason:'missing_safety_data'});
  },{send:async()=> 'out'},{enabled:true,notifyOrder:async()=>0,notifyHandoff:async info=>{alerts.push(info);return 1;}});
  await w.process(s.next());
  assert.equal(alerts.length,0);
  assert.equal(s.conversation('111').state,'BOT');
});

test('a Telegram failure still hands the conversation to a human',async t=>{
  const {s,c}=fixture(t,'live');
  s.ingest([inbound('111','failnotify','chân gà có ngâm hóa chất k')]);
  let text='';
  const w=new Worker(c,s,async()=>JSON.stringify({action:'handoff',text:'',sourceIds:[],reason:'missing_safety_data'}),
    {send:async(_,v)=>{text=v;return 'out'}},{enabled:true,notifyOrder:async()=>0,notifyHandoff:async()=>{throw new Error('Telegram notify failed for chat 111');}});
  await w.process(s.next());
  assert.equal(s.conversation('111').state,'WAITING');
  assert.equal(text,c.handoffText);
  assert.equal(s.handoffNotified(s.snapshot().jobs.at(-1).id),false);
});

test('collecting order continues extracting later customer details',async t=>{
  const {s,c}=fixture(t,'live');s.saveOrder('111',{wantsOrder:true,products:['chân gà rút xương']});
  s.ingest([inbound('111','details','mình là cửa hàng, tên Hạnh, số 0900000000, địa chỉ 5 Nguyễn Trãi')]);let text='';
  const w=new Worker(c,s,async p=>{
    if(p.system.includes('bộ trích xuất thông tin đặt hàng')) return JSON.stringify({wantsOrder:true,customerType:'store',customerName:'Hạnh',phone:'0900000000',address:'5 Nguyễn Trãi',products:[],notes:null,ready:true});
    if(p.system.includes('bộ kiểm tra')) return '{"inScope":true,"supported":true}';
    const payload=JSON.parse(p.message);
    assert.equal(payload.order.customerType,'store');
    assert.equal(payload.order.status,'ready');
    return JSON.stringify({action:'reply',text:'Dạ em đã đủ thông tin lên đơn chân gà rút xương cho cửa hàng mình rồi ạ.',sourceIds:['hours'],reason:'order_ready'});
  },{send:async(_,v)=>{text=v;return 'out';}});
  await w.process(s.next());
  const order=s.order('111');
  assert.equal(order.status,'ready');
  assert.equal(order.customer_type,'store');
  assert.deepEqual(order.products,['chân gà rút xương']);
  assert.match(text,/đủ thông tin|lên đơn/);
});
test('WAITING auto reset returns conversation to BOT after env-controlled timeout',t=>{
  const {s}=fixture(t);s.ingest([inbound()]);s.hold('111','WAITING','missing');
  assert.equal(s.autoResumeExpiredWaiting(3600),0);
  s.db.prepare("UPDATE audit SET at=? WHERE psid=? AND action='WAITING'").run(Date.now()-2000,'111');
  assert.equal(s.autoResumeExpiredWaiting(1),1);
  assert.equal(s.conversation('111').state,'BOT');
  assert.equal(s.conversation('111').reason,'auto_waiting_reset');
});
test('unknown send not retried; resume blocked until reconciliation',async t=>{
  const {s,c}=fixture(t,'live');s.ingest([inbound()]);const j=s.next();
  await new Worker(c,s,completion(),{send:async()=>{throw Error('timeout');}}).process(j);
  assert.equal(s.snapshot().jobs[0].delivery,'unknown');assert.throws(()=>s.resume('111'));
  s.reconcile(j.id,true);s.resume('111');assert.equal(s.conversation('111').state,'BOT');assert.equal(s.next(),null);
});
test('restart preserves HUMAN and fences in-flight sends',t=>{
  const f=fixture(t);f.s.ingest([inbound()]);const j=f.s.next();f.s.prepare(j,'reply',[],'sending');f.s.finish(j.id,'sending');f.close();
  const s=new Store(f.c.database,'100');t.after(()=>s.close());
  assert.equal(s.conversation('111').state,'WAITING');assert.equal(s.snapshot().jobs[0].delivery,'unknown');
  s.takeover('111');assert.equal(s.conversation('111').state,'HUMAN');
});
test('duplicate runtime cannot claim DB',t=>{const {s,c}=fixture(t);assert.throws(()=>new Store(c.database,'100'),/already owned/);assert.ok(s.conversation('none')===undefined);});
test('database cannot be reused for another Page',t=>{const f=fixture(t);f.close();assert.throws(()=>new Store(f.c.database,'999'),/another Page/);});
test('own echo does not trigger agent; unknown Page sender takes over',t=>{
  const {s}=fixture(t);s.ingest([inbound()]);const j=s.next();s.prepare(j,'hi',[]);s.sent(j,'out1','hi');
  s.ingest([{id:'out1',mid:'out1',psid:'111',kind:'echo',text:'hi',at:Date.now()}]);assert.equal(s.conversation('111').state,'BOT');
  s.ingest([{id:'external',mid:'external',psid:'111',kind:'echo',text:'staff reply',at:Date.now()}]);assert.equal(s.conversation('111').state,'HUMAN');assert.equal(s.next(),null);
});
test('expired window blocks outgoing reply',async t=>{
  const {s,c}=fixture(t,'live');s.ingest([inbound('111','m1','giờ',Date.now()-25*3600000)]);let sent=0;
  await new Worker(c,s,completion(),{send:async()=>sent++}).process(s.next());assert.equal(sent,0);assert.equal(s.snapshot().jobs[0].delivery,'blocked_window');
});
test('invalid citations and failed semantic review hand off',async t=>{
  const {s,c}=fixture(t);assert.throws(()=>validateAnswer('{"action":"reply","text":"x","sourceIds":["fake"]}',[]));
  s.ingest([inbound()]);await new Worker(c,s,async p=>p.system.includes('bộ kiểm tra')?'{"inScope":false,"supported":false}':answer,{}).process(s.next());
  assert.equal(s.conversation('111').state,'WAITING');
});
test('model JSON parser tolerates fenced or prefixed JSON output',()=>{
  assert.equal(parseModelJson('```json\n{"ok":true}\n```').ok,true);
  assert.equal(parseModelJson('Dạ đây là JSON:\\n{"ok":true}').ok,true);
});
test('out-of-scope uses AI wording instead of fixed env prose',async t=>{
  const {s,c}=fixture(t,'live');s.ingest([inbound('111','x','bên mình có tuyển nhân viên không')]);let text;
  await new Worker(c,s,completion('{"action":"out_of_scope","text":"Dạ hiện em chưa hỗ trợ thông tin tuyển dụng ở đây ạ. Em có thể tư vấn sản phẩm và dịch vụ của Page nếu anh/chị cần.","sourceIds":[]}'),{send:async(_,v)=>{text=v;return 'out';}}).process(s.next());
  assert.match(text,/tuyển dụng|sản phẩm|dịch vụ/);
  assert.notEqual(text,c.outOfScopeText);
});
test('generic out-of-scope env prose is rewritten by AI fallback',async t=>{
  const {s,c}=fixture(t,'live');s.ingest([inbound('111','chem','chân gà có ngâm hóa chất k')]);let text='',fallbackCalls=0;
  const w=new Worker(c,s,async p=>{
    if(p.system.includes('Chỉ trả JSON {"text"')) {fallbackCalls++; return '{"text":"Dạ câu này liên quan đến an toàn sản phẩm nên em không muốn trả lời thiếu căn cứ ạ. Hiện dữ liệu em có chưa xác nhận thông tin ngâm hóa chất cho chân gà; em cần nhân viên kiểm tra chính xác giúp anh/chị."}';}
    return JSON.stringify({action:'out_of_scope',text:c.outOfScopeText,sourceIds:[],reason:'missing_safety_data'});
  },{send:async(_,v)=>{text=v;return 'out';}});
  await w.process(s.next());
  assert.equal(fallbackCalls,1);
  assert.match(text,/an toàn|hóa chất|chân gà|kiểm tra/);
  assert.notEqual(text,c.outOfScopeText);
});
test('expired/unapproved knowledge excluded',t=>{
  const {c}=fixture(t);const docs=JSON.parse(readFileSync(c.knowledgeFile)).documents;docs[0].validUntil='2000-01-01';writeFileSync(c.knowledgeFile,JSON.stringify({schemaVersion:1,documents:docs}));assert.deepEqual(retrieve(c.knowledgeFile,'giờ'),[]);
});
test('generic customer questions still receive bounded catalog context',t=>{
  const {c}=fixture(t);
  writeFileSync(c.knowledgeFile,JSON.stringify({schemaVersion:1,documents:[
    {id:'beef',title:'Sản phẩm bò',keywords:['ba chỉ bò'],content:'Ba chỉ bò dùng lẩu, nướng.',approved:true,validUntil:null},
    {id:'usage',title:'Công dụng sản phẩm',keywords:['sản phẩm'],content:'Tư vấn theo nhu cầu sử dụng.',approved:true,validUntil:null},
    {id:'buffalo',title:'Sản phẩm trâu',keywords:['nạc dăm trâu'],content:'Nạc dăm trâu, thăn trâu, đuôi trâu.',approved:true,validUntil:null}
  ]}));
  const docs=retrieve(c.knowledgeFile,'bên mình có sản phẩm gì?');
  assert.deepEqual(docs.map(d=>d.id),['usage','beef','buffalo']);
});
test('image catalog retrieves approved matching product images',t=>{
  const {dir}=fixture(t);
  const file=join(dir,'images.json');
  writeFileSync(file,JSON.stringify({schemaVersion:1,images:[
    {id:'buffalo',title:'Thăn trâu 67',keywords:['thăn trâu','trâu'],caption:'Ảnh thăn trâu 67',file:'buffalo.jpg',approved:true},
    {id:'draft',title:'Ảnh nháp',keywords:['trâu'],file:'draft.jpg',approved:false}
  ]}));
  const images=retrieveImages(file,'trâu có ảnh không');
  assert.equal(images.length,1);
  assert.equal(images[0].id,'buffalo');
});
test('product import preview builds product, knowledge, and image catalogs',async t=>{
  const {dir}=fixture(t);
  const runtime=join(dir,'runtime');
  mkdirSync(runtime,{recursive:true});
  writeFileSync(join(runtime,'knowledge.json'),JSON.stringify({schemaVersion:1,documents:[{id:'page-info',title:'Page info',keywords:['page'],content:'Page info',approved:true,validUntil:null}]}));
  mkdirSync(join(runtime,'images'),{recursive:true});
  writeFileSync(join(runtime,'images/catalog.json'),JSON.stringify({schemaVersion:1,images:[]}));
  const input=join(dir,'products.json');
  writeFileSync(input,JSON.stringify({products:[{
    'Tên sản phẩm':'Chân gà rút xương',
    'Xuất xứ':'Việt Nam',
    'Công dụng':'nộm, ăn vặt',
    'Ảnh':'chan-ga.jpg'
  }]}));
  const plan=await buildImportPlan({file:input,runtimeDir:runtime});
  assert.equal(plan.summary.added.length,1);
  assert.equal(plan.products.products[0].name,'Chân gà rút xương');
  assert.ok(plan.knowledge.documents.some(d=>d.id==='product-chan-ga-rut-xuong'));
  assert.ok(plan.knowledge.documents.some(d=>d.id==='category-ga'));
  assert.equal(plan.images.images[0].file,'chan-ga.jpg');
  assert.ok(plan.knowledge.documents.some(d=>d.id==='page-info'));
});
test('budget exhaustion hands off without model call',async t=>{
  const {s,c}=fixture(t);c.maxDailyAgentCalls=0;s.ingest([inbound()]);let calls=0;
  await new Worker(c,s,async()=>{calls++;return answer;},{}).process(s.next());assert.equal(calls,0);assert.equal(s.conversation('111').state,'WAITING');
});
test('customer histories never cross',t=>{const {s}=fixture(t);s.ingest([inbound('111','a','private A'),inbound('222','b','private B')]);assert.equal(s.history('111').length,1);assert.equal(s.history('111')[0].text,'private A');});
test('env is private and not injected into process environment',t=>{
  const {c}=fixture(t);const before=process.env.META_PAGE_ACCESS_TOKEN;loadSecrets(c.envFile,c.workspace);assert.equal(process.env.META_PAGE_ACCESS_TOKEN,before);
  chmodSync(c.envFile,0o644);assert.throws(()=>loadSecrets(c.envFile),/600/);
});
test('runtime env overrides mode and handoff controls',t=>{
  const {c,secrets}=fixture(t);
  const runtime=applyEnvOverrides(c,{...secrets,PAGE_CSKH_MODE:'live',PAGE_CSKH_WAITING_RESET_SECONDS:'12',PAGE_CSKH_MESSAGE_DEBOUNCE_SECONDS:'3',PAGE_CSKH_ENABLE_HUMAN_HANDOFF:'false'});
  assert.equal(runtime.mode,'live');
  assert.equal(runtime.waitingResetSeconds,12);
  assert.equal(runtime.messageDebounceSeconds,3);
  assert.equal(runtime.enableHumanHandoff,false);
});
test('runtime config can be generated from private env',t=>{
  const {dir,secrets}=fixture(t);
  const c=runtimeConfigFromEnv({
    ...secrets,
    PAGE_CSKH_PAGE_ID:'123',
    PAGE_CSKH_APP_ID:'456',
    PAGE_CSKH_PAGE_NAME:'Test Page',
    PAGE_CSKH_PUBLIC_WEBHOOK_URL:'https://example.com/webhooks/page-cskh',
    PAGE_CSKH_MODEL:'provider/model',
    PAGE_CSKH_EDGE_PORT:'19992',
    PAGE_CSKH_IMAGE_DIR:'./product-images',
    PAGE_CSKH_IMAGE_CATALOG_FILE:'./product-images/catalog.json',
    PAGE_CSKH_ORDER_TELEGRAM_CHAT_IDS:'["123","-100456"]',
    PAGE_CSKH_MESSAGE_DEBOUNCE_SECONDS:'4',
    PAGE_CSKH_MODE:'live',
    PAGE_CSKH_ENABLE_HUMAN_HANDOFF:'false',
    PAGE_CSKH_SCOPE_KEYWORDS:'a,b,c'
  });
  const file=join(dir,'generated.json');writeFileSync(file,JSON.stringify(c));
  const loaded=loadConfig(file);
  assert.equal(loaded.pageId,'123');
  assert.equal(loaded.mode,'live');
  assert.equal(loaded.edgePort,19992);
  assert.deepEqual(loaded.orderTelegramChatIds,['123','-100456']);
  assert.ok(loaded.imageDir.endsWith('/product-images'));
  assert.ok(loaded.imageCatalogFile.endsWith('/product-images/catalog.json'));
  assert.equal(loaded.messageDebounceSeconds,4);
  assert.equal(loaded.enableHumanHandoff,false);
  assert.deepEqual(loaded.scopeKeywords,['a','b','c']);
});
test('config forbids secrets inside agent workspace',t=>{
  const {c,dir}=fixture(t);const file=join(dir,'config.json');c.envFile=join(c.workspace,'.env');writeFileSync(file,JSON.stringify(c));assert.throws(()=>loadConfig(file),/outside agent workspace/);
});
test('patch only targets dedicated agent and plugin',t=>{
  const {c}=fixture(t);const p=makePatch(c,'/config.json');assert.deepEqual(Object.keys(p.agents.entries),[c.agentId]);assert.deepEqual(p.agents.entries[c.agentId].tools.deny,['*']);assert.equal(p.agents.entries.main,undefined);
});
test('runtime adapter passes no secrets/tools/recipient and uses configured agent',async()=>{
  let args;const complete=openClawCompletion({runtime:{subagent:{complete:async a=>{args=a;return {text:'ok'};}}}});
  assert.equal(await complete({agentId:'support',message:'question',system:'policy',timeoutMs:10}),'ok');
  assert.equal(args.agentId,'support');assert.equal(args.model,undefined);assert.equal(args.recipient,undefined);assert.equal(args.tools,undefined);
});
test('Meta refuses token/Page mismatch; exact recipient captured in request',async()=>{
  const c={graphVersion:'v25.0',pageId:'100'},sec={META_PAGE_ACCESS_TOKEN:'test'};let captured;
  await assert.rejects(()=>metaClient(c,sec,async()=>({ok:true,json:async()=>({id:'999'})})).probe(),/does not match/);
  const client=metaClient(c,sec,async(url,opts)=>{captured=JSON.parse(opts.body);return {ok:true,json:async()=>({recipient_id:'111',message_id:'m1'})};});
  assert.equal(await client.send('111','hi'),'m1');assert.equal(captured.recipient.id,'111');
});
test('Meta probe accepts valid Page token when metadata endpoint lacks permission',async()=>{
  const c={graphVersion:'v25.0',pageId:'100',appId:'200'},sec={META_PAGE_ACCESS_TOKEN:'test',META_APP_SECRET:'secret'};
  const client=metaClient(c,sec,async url=>{
    if(String(url).includes('/me?')) return {ok:false,json:async()=>({error:{code:100}})};
    assert.ok(String(url).includes('/debug_token?'));
    return {ok:true,json:async()=>({data:{is_valid:true,type:'PAGE',profile_id:'100'}})};
  });
  assert.equal(await client.probe(),true);
});
test('HTTP webhook: valid challenge, signed batch, rejection and retry dedup',async t=>{
  const {s,c,secrets}=fixture(t);const server=createServer(makeWebhook(c,secrets,s));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const url=`http://127.0.0.1:${server.address().port}/webhooks/page-cskh`;
  const get=await fetch(url+'?hub.mode=subscribe&hub.verify_token='+secrets.META_WEBHOOK_VERIFY_TOKEN+'&hub.challenge=123');assert.equal(await get.text(),'123');
  const body=JSON.stringify({object:'page',entry:[{id:'100',messaging:[{sender:{id:'111'},recipient:{id:'100'},timestamp:Date.now(),message:{mid:'m1',text:'giờ'}}]}]});
  assert.equal((await fetch(url,{method:'POST',body})).status,403);
  const signature='sha256='+createHmac('sha256',secrets.META_APP_SECRET).update(body).digest('hex');
  for(let i=0;i<2;i++)assert.equal((await fetch(url,{method:'POST',body,headers:{'x-hub-signature-256':signature}})).status,200);
  assert.equal(s.snapshot().jobs.length,1);
});
test('operator endpoints require token and enforce takeover',async t=>{
  const {s,c,secrets}=fixture(t);s.ingest([inbound()]);
  // Reserve an ephemeral loopback port before the actual admin listener.
  const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));c.adminPort=reserve.address().port;await new Promise(r=>reserve.close(r));
  const server=await startAdmin(c,secrets,s);t.after(()=>new Promise(r=>server.close(r)));
  const url=`http://127.0.0.1:${c.adminPort}`;
  assert.equal((await fetch(url+'/status')).status,401);
  const r=await fetch(url+'/takeover',{method:'POST',headers:{Authorization:`Bearer ${secrets.CSKH_ADMIN_TOKEN}`},body:JSON.stringify({psid:'111'})});assert.equal(r.status,200);assert.equal(s.conversation('111').state,'HUMAN');
});

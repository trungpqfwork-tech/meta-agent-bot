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
import { retrieve,validateAnswer } from '../src/knowledge.mjs';
import { makePatch } from '../scripts/setup.mjs';
import { startAdmin } from '../src/admin.mjs';

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
  assert.equal(s.ingest([inbound('111','a','xin chào')],c),1);
  assert.equal(s.next(),null);
  assert.equal(s.ingest([inbound('111','b','mình muốn hỏi giá')],c),1);
  assert.equal(s.snapshot().jobs.filter(j=>j.status==='pending').length,1);
  assert.equal(s.snapshot().jobs.filter(j=>j.status==='superseded').length,1);
  assert.equal(s.next(Date.now()+1999),null);
  const j=s.next(Date.now()+2001);
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
test('out-of-scope model prose never sent verbatim',async t=>{
  const {s,c}=fixture(t,'live');s.ingest([inbound()]);let text;
  await new Worker(c,s,completion('{"action":"out_of_scope","text":"unsafe general answer","sourceIds":[]}'),{send:async(_,v)=>{text=v;return 'out';}}).process(s.next());assert.equal(text,c.outOfScopeText);
});
test('expired/unapproved knowledge excluded',t=>{
  const {c}=fixture(t);const docs=JSON.parse(readFileSync(c.knowledgeFile)).documents;docs[0].validUntil='2000-01-01';writeFileSync(c.knowledgeFile,JSON.stringify({schemaVersion:1,documents:docs}));assert.deepEqual(retrieve(c.knowledgeFile,'giờ'),[]);
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

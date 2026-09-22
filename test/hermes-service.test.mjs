import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync,mkdtempSync,mkdirSync,writeFileSync,readFileSync,chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter,join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Store } from '../src/store.mjs';
import { createPageCskhService,isEntryPoint } from '../src/service.mjs';
import { buildHermesChildEnv,createHermesCompletion,resolveHermesRuntime } from '../src/hermes.mjs';
import { loadConfig,runtimeConfigFromEnv } from '../src/config.mjs';
import { setupHermes } from '../scripts/setup-hermes.mjs';

function fixture(t,mode='draft') {
  const dir=mkdtempSync(join(tmpdir(),'page-cskh-hermes-test-'));
  const c={
    ...JSON.parse(readFileSync(new URL('../config.example.json',import.meta.url))),
    pageId:'100',appId:'200',model:'provider/model',mode,
    workspace:join(dir,'agent'),envFile:join(dir,'.env'),database:join(dir,'data/state.sqlite'),knowledgeFile:join(dir,'knowledge.json'),
    messageDebounceSeconds:0,
    edgePort:20000+Math.floor(Math.random()*10000),
    adminPort:30000+Math.floor(Math.random()*10000)
  };
  mkdirSync(c.workspace,{recursive:true});
  const secrets={META_APP_SECRET:'s'.repeat(32),META_PAGE_ACCESS_TOKEN:'p'.repeat(32),META_WEBHOOK_VERIFY_TOKEN:'v'.repeat(32),CSKH_ADMIN_TOKEN:'a'.repeat(40)};
  writeFileSync(c.envFile,Object.entries(secrets).map(([k,v])=>`${k}=${v}`).join('\n'),{mode:0o600});
  chmodSync(c.envFile,0o600);
  writeFileSync(c.knowledgeFile,JSON.stringify({schemaVersion:1,documents:[{id:'hours',title:'Giờ',keywords:['giờ'],content:'Mở cửa 8h.',approved:true,validUntil:null}]}));
  const file=join(dir,'config.json');
  writeFileSync(file,JSON.stringify(c));
  return {dir,c,file,secrets};
}
function inbound(psid='111',id='m1',text='mấy giờ?',at=Date.now()) {return {psid,id,kind:'customer',text,at};}
async function waitFor(fn,ms=2000) {
  const until=Date.now()+ms;
  while(Date.now()<until) {
    const value=await fn();
    if(value) return value;
    await new Promise(r=>setTimeout(r,25));
  }
  throw new Error('timed out waiting for condition');
}

test('standalone Hermes service resumes queued SQLite conversation without native Hermes session state',async t=>{
  const {file,c}=fixture(t);
  const old=new Store(c.database,c.pageId);
  // Distinct timestamps keep "newer customer message cancels stale output" deterministic.
  old.ingest([inbound('111','before','trước đó',Date.now()-1000),inbound('111','queued','mấy giờ?',Date.now())],c);
  old.close();
  const seen=[];
  const service=createPageCskhService({
    configFile:file,
    complete:async p=>{
      const payload=JSON.parse(p.message);
      seen.push(payload);
      if(p.system.includes('bộ kiểm tra')) return '{"inScope":true,"supported":true}';
      assert.deepEqual(payload.history.filter(x=>x.kind==='customer').map(x=>x.text),['trước đó','mấy giờ?']);
      return JSON.stringify({action:'reply',text:'Mở cửa 8h.',sourceIds:['hours'],reason:'answered_from_kb'});
    },
    meta:{send:async()=>{throw new Error('draft must not send');}},
    notifier:{enabled:false,notifyOrder:async()=>0},
    startHttp:false,
    startAdmin:false
  });
  await service.start();
  t.after(()=>service.stop());
  const answered=await waitFor(()=>service.store.snapshot().jobs.find(j=>j.reply));
  assert.equal(answered.reply,'Mở cửa 8h.');
  assert.equal(answered.delivery,'draft');
  assert.equal(service.store.snapshot().jobs.length,2);
  assert.ok(seen.length >= 1);
});

test('standalone service exposes Meta webhook on its own loopback port',async t=>{
  const {file,c,secrets}=fixture(t);
  const reserve=createServer();
  await new Promise(r=>reserve.listen(0,'127.0.0.1',r));
  c.edgePort=reserve.address().port;
  await new Promise(r=>reserve.close(r));
  writeFileSync(file,JSON.stringify(c));
  const service=createPageCskhService({
    configFile:file,
    complete:async p=>p.system.includes('bộ kiểm tra')?'{"inScope":true,"supported":true}':JSON.stringify({action:'reply',text:'Mở cửa 8h.',sourceIds:['hours']}),
    meta:{send:async()=>{throw new Error('draft must not send');}},
    notifier:{enabled:false,notifyOrder:async()=>0},
    startAdmin:false
  });
  await service.start();
  t.after(()=>service.stop());
  const url=`http://127.0.0.1:${c.edgePort}/webhooks/page-cskh`;
  const r=await fetch(url+'?hub.mode=subscribe&hub.verify_token='+secrets.META_WEBHOOK_VERIFY_TOKEN+'&hub.challenge=ok');
  assert.equal(await r.text(),'ok');
});

test('Hermes child environment strips Page runtime secrets while preserving provider config',()=>{
  const env=buildHermesChildEnv({
    PATH:'/bin',HOME:'/home/test',HERMES_HOME:'/tmp/hermes',OPENAI_API_KEY:'ok',
    META_PAGE_ACCESS_TOKEN:'secret',META_APP_SECRET:'secret',CSKH_ADMIN_TOKEN:'secret',PAGE_CSKH_MODE:'live',TELEGRAM_BOT_TOKEN:'secret'
  });
  assert.equal(env.OPENAI_API_KEY,'ok');
  assert.equal(env.HERMES_HOME,'/tmp/hermes');
  assert.equal(env.META_PAGE_ACCESS_TOKEN,undefined);
  assert.equal(env.META_APP_SECRET,undefined);
  assert.equal(env.CSKH_ADMIN_TOKEN,undefined);
  assert.equal(env.PAGE_CSKH_MODE,undefined);
  assert.equal(env.TELEGRAM_BOT_TOKEN,undefined);
});

test('dedicated Hermes home is parsed and resolved from runtime env config',t=>{
  const {dir,secrets}=fixture(t);
  const c=runtimeConfigFromEnv({
    ...secrets,
    PAGE_CSKH_PAGE_ID:'100',
    PAGE_CSKH_APP_ID:'200',
    PAGE_CSKH_PAGE_NAME:'Test Page',
    PAGE_CSKH_PUBLIC_WEBHOOK_URL:'https://example.com/webhooks/page-cskh',
    PAGE_CSKH_MODEL:'provider/model',
    PAGE_CSKH_HERMES_HOME:'./hermes-cskh'
  });
  const file=join(dir,'with-hermes-home.json');
  writeFileSync(file,JSON.stringify(c));
  const loaded=loadConfig(file);
  assert.equal(loaded.hermesHome,join(dir,'hermes-cskh'));
});

test('Hermes child environment uses dedicated home without leaking Page secrets',()=>{
  const env=buildHermesChildEnv({
    PATH:'/bin',HOME:'/home/test',HERMES_HOME:'/old/hermes',OPENAI_API_KEY:'ok',
    META_PAGE_ACCESS_TOKEN:'secret',META_APP_SECRET:'secret',CSKH_ADMIN_TOKEN:'secret',PAGE_CSKH_HERMES_HOME:'./bad'
  },{hermesHome:'/runtime/hermes-cskh'});
  assert.equal(env.HERMES_HOME,'/runtime/hermes-cskh');
  assert.equal(env.OPENAI_API_KEY,'ok');
  assert.equal(env.META_PAGE_ACCESS_TOKEN,undefined);
  assert.equal(env.PAGE_CSKH_HERMES_HOME,undefined);
});

test('Hermes completion adapter carries dedicated home only through sanitized runtime options',async()=>{
  let request;
  const complete=createHermesCompletion({
    model:'provider/model',
    hermesHome:'/runtime/hermes-cskh',
    runner:async r=>{request=r;return '{"ok":true}';}
  });
  await complete({agentId:'page-cskh',message:'{}',system:'policy',timeoutMs:123});
  assert.equal(request.hermesHome,'/runtime/hermes-cskh');
  assert.equal(request.model,'provider/model');
});

test('setup creates dedicated Hermes home marker without customer data or Meta secrets',async t=>{
  const {dir,c}=fixture(t);
  c.hermesHome=join(dir,'hermes-home');
  writeFileSync(join(dir,'config.json'),JSON.stringify(c));
  await setupHermes(['--config',join(dir,'config.json'),'--apply']);
  const marker=join(c.hermesHome,'AGENTS.md');
  assert.equal(existsSync(marker),true);
  const text=readFileSync(marker,'utf8');
  assert.match(text,/SQLite database is the only durable customer memory/);
  assert.doesNotMatch(text,/META_PAGE_ACCESS_TOKEN|CSKH_ADMIN_TOKEN|pppp|ssss|aaaa/);
});

test('a prose answer is re-enveloped into the JSON contract instead of being discarded',async t=>{
  const {file,c}=fixture(t);
  const seed=new Store(c.database,c.pageId);
  seed.ingest([inbound('111','m-prose','mấy giờ?')],c);
  seed.close();
  const seen=[];
  const service=createPageCskhService({
    configFile:file,
    complete:async p=>{
      if(p.system.includes('bộ kiểm tra')) return '{"inScope":true,"supported":true}';
      if(p.system.includes('bộ định dạng')) {
        seen.push(JSON.parse(p.message).answer);
        return JSON.stringify({action:'reply',text:'Dạ, bên em mở cửa từ 8h ạ.',sourceIds:['hours'],reason:'reformatted'});
      }
      // First answer is usable prose but not JSON.
      return 'Dạ, bên em mở cửa từ 8h ạ.';
    },
    meta:{send:async()=>{throw new Error('draft must not send');}},
    notifier:{enabled:false,notifyOrder:async()=>0},
    startHttp:false,
    startAdmin:false
  });
  await service.start();
  t.after(()=>service.stop());
  const job=await waitFor(()=>service.store.snapshot().jobs.find(x=>x.reply));
  assert.equal(job.reply,'Dạ, bên em mở cửa từ 8h ạ.');
  assert.equal(seen[0],'Dạ, bên em mở cửa từ 8h ạ.');
});

test('a prose answer with no usable evidence still falls back instead of being sent',async t=>{
  const {file,c}=fixture(t);
  writeFileSync(c.knowledgeFile,JSON.stringify({schemaVersion:1,documents:[]}));
  const seed=new Store(c.database,c.pageId);
  seed.ingest([inbound('112','m-prose-empty','mấy giờ?')],c);
  seed.close();
  const service=createPageCskhService({
    configFile:file,
    complete:async p=>p.system.includes('bộ kiểm tra')?'{"inScope":true,"supported":true}':'Dạ em chào anh chị ạ.',
    meta:{send:async()=>{throw new Error('draft must not send');}},
    notifier:{enabled:false,notifyOrder:async()=>0},
    startHttp:false,
    startAdmin:false
  });
  await service.start();
  t.after(()=>service.stop());
  const settled=await waitFor(()=>{const j=service.store.snapshot().jobs;return j.every(x=>x.status!=='pending')?j:null;});
  assert.notEqual(settled.at(-1).reply,'Dạ em chào anh chị ạ.');
});

test('Hermes completion adapter sends only prompt fields and never recipient, tools, or secrets',async()=>{
  let request;
  const complete=createHermesCompletion({
    model:'provider/model',
    runner:async r=>{request=r;return '{"ok":true}';}
  });
  assert.equal(await complete({agentId:'page-cskh',message:'{"currentMessage":"hi"}',system:'policy',timeoutMs:123,recipient:'111',tools:['exec'],secrets:{META_PAGE_ACCESS_TOKEN:'secret'}}),'{"ok":true}');
  assert.deepEqual(Object.keys(request).sort(),['agentId','message','model','system','timeoutMs'].sort());
  assert.equal(request.agentId,'page-cskh');
  assert.equal(request.model,'provider/model');
  assert.equal(request.recipient,undefined);
  assert.equal(request.tools,undefined);
  assert.equal(request.secrets,undefined);
});

test('Hermes runtime resolves the venv interpreter inside the install dir so run_agent is importable',t=>{
  const {dir}=fixture(t);
  const appDir=join(dir,'hermes-agent');
  mkdirSync(join(appDir,'venv','bin'),{recursive:true});
  writeFileSync(join(appDir,'venv','bin','python'),'');
  writeFileSync(join(appDir,'run_agent.py'),'');
  const resolved=resolveHermesRuntime({HERMES_APP_DIR:appDir});
  assert.equal(resolved.appDir,appDir);
  assert.equal(resolved.pythonPath,join(appDir,'venv','bin','python'));
});

test('Hermes runtime falls back to explicit python then system python3',t=>{
  const {dir}=fixture(t);
  const appDir=join(dir,'no-venv-here');
  assert.equal(resolveHermesRuntime({HERMES_APP_DIR:appDir}).pythonPath,'python3');
  assert.equal(resolveHermesRuntime({HERMES_APP_DIR:appDir,HERMES_PYTHON:'/opt/py'}).pythonPath,'/opt/py');
});

test('Hermes child env exposes the install dir on PYTHONPATH without dropping existing entries',()=>{
  const env=buildHermesChildEnv({PATH:'/bin',PYTHONPATH:'/existing'},{appDir:'/opt/hermes-agent'});
  assert.equal(env.PYTHONPATH,`/opt/hermes-agent${delimiter}/existing`);
  assert.equal(buildHermesChildEnv({PATH:'/bin'},{appDir:'/opt/hermes-agent'}).PYTHONPATH,'/opt/hermes-agent');
  assert.equal(buildHermesChildEnv({PATH:'/bin',PYTHONPATH:'/existing'}).PYTHONPATH,'/existing');
});

test('config accepts the bare model id the Hermes runtime actually calls and still rejects placeholders',t=>{
  const {dir,c}=fixture(t);
  const file=join(dir,'bare-model.json');
  writeFileSync(file,JSON.stringify({...c,model:'deepseek-v4.1-flash'}));
  assert.equal(loadConfig(file).model,'deepseek-v4.1-flash');
  writeFileSync(file,JSON.stringify({...c,model:'provider/REPLACE_ME'}));
  assert.throws(()=>loadConfig(file),/Set a model/);
  writeFileSync(file,JSON.stringify({...c,model:'   '}));
  assert.throws(()=>loadConfig(file),/Set a model/);
});

test('entry detection follows pm_exec_path when a process manager owns argv[1]',()=>{
  const self=pathToFileURL(new URL('../src/service.mjs',import.meta.url).pathname).href;
  const file=new URL('../src/service.mjs',import.meta.url).pathname;
  assert.equal(isEntryPoint([process.execPath,file],{},self),true);
  assert.equal(isEntryPoint([process.execPath,'/pm2/ProcessContainerFork.js'],{pm_exec_path:file},self),true);
  assert.equal(isEntryPoint([process.execPath,'/pm2/ProcessContainerFork.js'],{},self),false);
  assert.equal(isEntryPoint([process.execPath,'/pm2/ProcessContainerFork.js'],{pm_exec_path:'/other/service.mjs'},self),false);
});

test('service started through a process-manager container still binds its webhook port',async t=>{
  const {dir,file,c,secrets}=fixture(t);
  writeFileSync(file,JSON.stringify(c));
  const servicePath=new URL('../src/service.mjs',import.meta.url).pathname;
  const launcher=join(dir,'container.cjs');
  writeFileSync(launcher,`process.env.pm_exec_path=process.argv[2];import(require('node:url').pathToFileURL(process.argv[2]).href).catch(e=>{console.error(e.message);process.exit(1);});`);
  const child=spawn(process.execPath,[launcher,servicePath,'--config',file],{stdio:['ignore','pipe','pipe'],env:process.env});
  let stderr='';
  child.stderr.on('data',d=>{stderr+=d;});
  t.after(()=>child.kill('SIGKILL'));
  const url=`http://127.0.0.1:${c.edgePort}${c.webhookPath}?hub.mode=subscribe&hub.verify_token=${secrets.META_WEBHOOK_VERIFY_TOKEN}&hub.challenge=ok`;
  const body=await waitFor(async()=>{
    try {
      const r=await fetch(url);
      return r.status===200 ? await r.text() : false;
    } catch { return false; }
  },10000).catch(()=>{throw new Error(`service never bound port ${c.edgePort}; stderr=${stderr.slice(0,400)}`);});
  assert.equal(body,'ok');
});

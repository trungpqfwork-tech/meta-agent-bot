// Real isolated OpenClaw install + Gateway + local mock provider. No Meta sends.
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,openSync,closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn,spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const base=mkdtempSync(join(tmpdir(),'page-cskh-smoke-'));
for(const d of ['state','runtime','extract'])mkdirSync(join(base,d),{mode:0o700});
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('OPENCLAW_')));
env.OPENCLAW_STATE_DIR=join(base,'state');env.OPENCLAW_CONFIG_PATH=join(base,'state/openclaw.json');
function command(bin,args,cwd=root) {
  const r=spawnSync(bin,args,{cwd,env,encoding:'utf8',timeout:90000,maxBuffer:8*1024*1024});
  if(r.status!==0) {writeFileSync(join(base,'failed-command.log'),r.stdout+'\n'+r.stderr,{mode:0o600});throw Error(`${bin} ${args.slice(0,2).join(' ')} failed; inspect ${base}/failed-command.log`);}
  return r.stdout;
}
async function port() {const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
let gateway,model,logfd;
try {
  const gatewayPort=await port(),adminPort=await port();let modelCalls=0;
  model=createServer(async(req,res)=> {
    const chunks=[];for await(const c of req)chunks.push(c);
    const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');modelCalls++;
    const review=JSON.stringify(body).includes('bộ kiểm tra');
    const text=JSON.stringify(review?{inScope:true,supported:true}:{action:'reply',text:'Mở cửa 8h.',sourceIds:['hours'],reason:''});
    if(body.stream) {
      res.setHeader('Content-Type','text/event-stream');
      for(const [delta,finish_reason] of [[{role:'assistant',content:text},null],[{},'stop']])
        res.write('data: '+JSON.stringify({id:'smoke',object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:'mock-support',choices:[{index:0,delta,finish_reason}]})+'\n\n');
      res.end('data: [DONE]\n\n');
    }else {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'smoke',object:'chat.completion',model:'mock-support',choices:[{index:0,message:{role:'assistant',content:text},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}}));}
  });
  await new Promise(r=>model.listen(0,'127.0.0.1',r));
  const original={name:'Existing untouched',workspace:join(base,'existing-agent')};
  writeFileSync(env.OPENCLAW_CONFIG_PATH,JSON.stringify({gateway:{mode:'local',port:gatewayPort,bind:'loopback',auth:{mode:'none'}},agents:{entries:{main:original}},models:{providers:{smoke:{api:'openai-completions',baseUrl:`http://127.0.0.1:${model.address().port}/v1`,apiKey:'local-test-only',models:[{id:'mock-support',name:'Mock support',contextWindow:32768,maxTokens:1024}]}}}}),{mode:0o600});
  const c={...JSON.parse(readFileSync(join(root,'config.example.json'),'utf8')),pageId:'100',appId:'200',model:'smoke/mock-support',publicWebhookUrl:'https://example.invalid/webhooks/page-cskh',adminPort};
  const cfg=join(base,'runtime/config.json');writeFileSync(cfg,JSON.stringify(c),{mode:0o600});
  const secrets=Object.fromEntries(['META_APP_SECRET','META_PAGE_ACCESS_TOKEN','META_WEBHOOK_VERIFY_TOKEN','CSKH_ADMIN_TOKEN'].map(k=>[k,`test-only-${k}`.repeat(3)]));
  writeFileSync(join(base,'runtime/.env'),Object.entries(secrets).map(([k,v])=>`${k}=${v}`).join('\n'),{mode:0o600});
  const packed=JSON.parse(command('npm',['pack','--ignore-scripts','--json','--pack-destination',base]))[0];
  assert(!packed.files.some(f=>f.path==='.env'||/\.sqlite|config\.local/.test(f.path)));
  command('tar',['xzf',join(base,packed.filename),'-C',join(base,'extract')]);
  const extracted=join(base,'extract/package');
  command('node',['scripts/setup.mjs','--config',cfg,'--apply'],extracted);
  const kb={schemaVersion:1,documents:[{id:'hours',title:'Hours',keywords:['giờ'],content:'Mở cửa 8h.',approved:true}]};
  writeFileSync(join(base,'runtime/knowledge.json'),JSON.stringify(kb));
  command('node',['scripts/setup.mjs','--config',cfg,'--apply'],extracted);
  assert.deepEqual(JSON.parse(readFileSync(join(base,'runtime/knowledge.json'),'utf8')),kb);
  assert.deepEqual(JSON.parse(command('openclaw',['config','get','agents.entries.main','--json'])),original);
  command('node',['scripts/doctor.mjs','--config',cfg],extracted);
  const inspected=JSON.parse(command('openclaw',['plugins','inspect','page-cskh','--runtime','--json']));
  assert.equal(inspected.plugin.status,'loaded');assert.equal(inspected.httpRouteCount,1);
  logfd=openSync(join(base,'gateway.log'),'w',0o600);
  gateway=spawn('openclaw',['gateway','run','--port',String(gatewayPort),'--bind','loopback','--auth','none'],{env,stdio:['ignore',logfd,logfd]});
  const admin=`http://127.0.0.1:${adminPort}`;
  const headers={Authorization:`Bearer ${secrets.CSKH_ADMIN_TOKEN}`};
  async function status(){const r=await fetch(admin+'/status',{headers,signal:AbortSignal.timeout(2000)});assert.equal(r.status,200);return r.json();}
  const until=Date.now()+60000;
  for(;;){try{await status();break;}catch(e){if(Date.now()>until||gateway.exitCode!==null)throw Error('Gateway not ready; inspect '+base+'/gateway.log');await new Promise(r=>setTimeout(r,300));}}
  const webhook=`http://127.0.0.1:${gatewayPort}${c.webhookPath}`;
  const verify=await fetch(webhook+'?hub.mode=subscribe&hub.verify_token='+secrets.META_WEBHOOK_VERIFY_TOKEN+'&hub.challenge=smoke');assert.equal(await verify.text(),'smoke');
  const body=JSON.stringify({object:'page',entry:[{id:'100',messaging:[{sender:{id:'111'},recipient:{id:'100'},timestamp:Date.now(),message:{mid:'smoke-1',text:'Mấy giờ mở cửa?'}}]}]});
  const signature='sha256='+createHmac('sha256',secrets.META_APP_SECRET).update(body).digest('hex');
  for(let i=0;i<2;i++)assert.equal((await fetch(webhook,{method:'POST',body,headers:{'x-hub-signature-256':signature}})).status,200);
  let snapshot;const deadline=Date.now()+60000;
  for(;;){snapshot=await status();if(snapshot.jobs[0]?.status==='draft')break;if(Date.now()>deadline)throw Error('No draft within deadline');await new Promise(r=>setTimeout(r,300));}
  assert.equal(snapshot.jobs.length,1);assert.equal(snapshot.jobs[0].reply,'Mở cửa 8h.');assert.equal(snapshot.jobs[0].psid,'111');assert.equal(snapshot.jobs[0].mid,null);assert.equal(modelCalls,2);
  assert.equal((await fetch(admin+'/status')).status,401);
  assert.equal((await fetch(admin+'/takeover',{method:'POST',headers,body:JSON.stringify({psid:'111'})})).status,200);
  assert.equal((await status()).conversations[0].state,'HUMAN');
  const report={ok:true,host:'target-host',artifact:packed.filename,setupTwice:true,existingAgentPreserved:true,kbPreserved:true,pluginLoaded:true,signedWebhook:true,dedup:true,toolFreeRuntimeWithMockProvider:true,modelCalls,draftRecipient:'111',takeover:true,realMeta:false,realModel:false};
  writeFileSync(join(base,'report.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({...report,evidenceDirectory:base},null,2));
}catch(e){console.error(e.message);process.exitCode=1;}
finally {
  if(gateway&&gateway.exitCode===null){gateway.kill('SIGTERM');await Promise.race([new Promise(r=>gateway.once('exit',r)),new Promise(r=>setTimeout(r,8000))]);if(gateway.exitCode===null)gateway.kill('SIGKILL');}
  if(model)await new Promise(r=>model.close(r));if(logfd!==undefined)closeSync(logfd);
}

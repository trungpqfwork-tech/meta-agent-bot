// Webhook-only public edge. Never forwards Gateway administration routes.
import { createServer } from 'node:http';
import { readFileSync,statSync,mkdirSync } from 'node:fs';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { createHmac } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { equal,readBody } from './webhook.mjs';
import { assert } from './config.mjs';
function log(path,msg){
  const line=`${new Date().toISOString()} ${msg}`;
  console.log(line);
  try{mkdirSync(dirname(path),{recursive:true});appendFileSync(path,`${line}\n`);}catch{}
}
function clientIp(req){return String(req.headers['cf-connecting-ip']||req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0].trim();}
function safeHeaderValue(name,value) {
  const n=name.toLowerCase();
  if(['authorization','cookie','set-cookie','x-hub-signature','x-hub-signature-256'].includes(n)) return '[masked]';
  return value;
}
function safeHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).map(([k,v])=>[k,safeHeaderValue(k,v)]));
}
function safeSearchParams(params) {
  return Object.fromEntries([...params.entries()].map(([k,v])=>[k,k==='hub.verify_token'?'[masked]':v]));
}
function safeBody(raw) {
  const text=raw.toString('utf8');
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return JSON.stringify(text);
  }
}
function summarizeMetaPayload(raw){
  try {
    const body=JSON.parse(raw.toString('utf8'));
    const entries=Array.isArray(body.entry)?body.entry:[];
    const firstMessaging=entries.flatMap(e=>Array.isArray(e.messaging)?e.messaging:[])[0];
    const message=firstMessaging?.message;
    const text=typeof message?.text==='string'?message.text:'';
    const attachments=Array.isArray(message?.attachments)?message.attachments.map(a=>a?.type).filter(Boolean):[];
    return `object=${body.object??'unknown'} entries=${entries.length} page=${entries[0]?.id??'unknown'} sender=${firstMessaging?.sender?.id??'none'} mid=${message?.mid??'none'} text=${JSON.stringify(text).slice(0,500)} attachments=${JSON.stringify(attachments)}`;
  } catch {
    return 'unparseable';
  }
}

export function createEdge(c,secrets,fetcher=fetch) {
  const target=new URL(c.upstream);
  assert(target.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(target.hostname),'Edge upstream must be local HTTP');
  assert(target.pathname===c.webhookPath && !target.search && !target.username && !target.password,'Upstream must be exact webhook route');
  let windowStart=Date.now(),requests=0;
  return createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','text/plain; charset=utf-8');res.setHeader('X-Content-Type-Options','nosniff');
    if(Date.now()-windowStart>60000){windowStart=Date.now();requests=0;}
    if(++requests>300){res.statusCode=429;res.end('rate limited');return;}
    const u=new URL(req.url,'http://localhost');
    log(c.logFile,`REQUEST method=${req.method} path=${u.pathname} query=${JSON.stringify(safeSearchParams(u.searchParams))} ip=${clientIp(req)} headers=${JSON.stringify(safeHeaders(req.headers))}`);
    if(u.pathname!==c.webhookPath){log(c.logFile,`REJECT path path=${u.pathname}`);res.statusCode=404;res.end('not found');return;}
    log(c.logFile,`INCOMING method=${req.method} path=${u.pathname} ip=${clientIp(req)} ua=${JSON.stringify(req.headers['user-agent']??'')} len=${req.headers['content-length']??'unknown'}`);
    if(req.method==='GET') {
      const ok=u.searchParams.get('hub.mode')==='subscribe' && equal(u.searchParams.get('hub.verify_token'),secrets.META_WEBHOOK_VERIFY_TOKEN);
      log(c.logFile,`GET verify ${ok?'ok':'fail'} challenge=${u.searchParams.get('hub.challenge')??'none'}`);
      res.statusCode=ok?200:403;res.end(ok?u.searchParams.get('hub.challenge')??'':'forbidden');return;
    }
    if(req.method!=='POST'){res.statusCode=405;res.end('method not allowed');return;}
    try {
      const raw=await readBody(req);
      log(c.logFile,`POST body raw=${safeBody(raw)}`);
      const expected='sha256='+createHmac('sha256',secrets.META_APP_SECRET).update(raw).digest('hex');
      if(!equal(req.headers['x-hub-signature-256'],expected)){log(c.logFile,'POST sig_fail');res.statusCode=403;res.end('forbidden');return;}
      log(c.logFile,`POST ok len=${raw.length} ${summarizeMetaPayload(raw)}`);
      // In bootstrap mode GET verification works, but events are NOT acknowledged.
      if(c.backendEnabled!==true){log(c.logFile,'POST rejected: backend disabled');res.statusCode=503;res.end('message processing not configured');return;}
      const r=await fetcher(target,{method:'POST',headers:{'Content-Type':'application/json','x-hub-signature-256':expected},body:raw,redirect:'error',signal:AbortSignal.timeout(10000)});
      log(c.logFile,`POST upstream status=${r.status}`);
      res.statusCode=r.status;res.end(r.status===200?'EVENT_RECEIVED':'backend unavailable');
    }catch(e){log(c.logFile,`POST err:${e.message}`);res.statusCode=e.message==='body_limit'?413:503;res.end('unavailable');}
  });
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const c=JSON.parse(readFileSync(process.argv[2],'utf8'));
    assert(Number.isInteger(c.port)&&c.port>1024&&c.port<65536,'Invalid edge port');
    assert((statSync(c.envFile).mode&0o077)===0,'Env must have mode 600');
    const secrets=parseEnv(readFileSync(c.envFile,'utf8'));
    assert(secrets.META_WEBHOOK_VERIFY_TOKEN?.length>=16 && secrets.META_APP_SECRET?.length>=16,'Required webhook secrets missing');
    const logFile=resolve(dirname(process.argv[2]),'logs','edge.log');
    c.logFile=logFile;
    const server=createEdge(c,secrets);server.requestTimeout=15000;server.headersTimeout=10000;
    server.on('error',(e)=>{log(logFile,`ERR ${e.message}`);console.error('Edge listener failed');process.exitCode=1;});
    server.listen(c.port,'127.0.0.1',()=>console.log(`Webhook-only edge listening on loopback port ${c.port}; log=${logFile}; processing=${c.backendEnabled===true}`));
    for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{server.close(()=>process.exit(0));server.closeIdleConnections();setTimeout(()=>process.exit(0),12000).unref();});
  }catch(e){console.error('Edge configuration invalid; secret values withheld');console.error(e?.message);process.exitCode=1;}
}

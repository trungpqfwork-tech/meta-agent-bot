import { createHmac, timingSafeEqual } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { eventHash } from './store.mjs';
function log(path,msg){try{mkdirSync(dirname(path),{recursive:true});appendFileSync(path,`${new Date().toISOString()} ${msg}\n`);}catch{}}
function clientIp(req){return String(req.headers['cf-connecting-ip']||req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0].trim();}
function summarizeEvents(events){
  const first=events[0];
  return `events=${events.length} firstKind=${first?.kind??'none'} firstPsid=${first?.psid??'none'} firstMid=${first?.mid??'none'}`;
}
export function equal(a,b) {
  const x=Buffer.from(String(a??'')),y=Buffer.from(String(b??''));
  return x.length===y.length && timingSafeEqual(x,y);
}
export async function readBody(req,max=1048576) {
  const chunks=[]; let size=0;
  for await(const b of req) { size+=b.length; if(size>max) throw new Error('body_limit'); chunks.push(b); }
  return Buffer.concat(chunks);
}
export function normalizeEvents(payload,pageId) {
  if(payload?.object!=='page' || !Array.isArray(payload.entry)) throw new Error('invalid_payload');
  const out=[];
  for(const entry of payload.entry) {
    if(entry.id!==pageId) continue;
    for(const e of entry.messaging??[]) {
      if(e.delivery || e.read) continue;
      const echo=e.message?.is_echo===true;
      const psid=echo?e.recipient?.id:e.sender?.id;
      if(!/^\d+$/.test(psid??'')) continue;
      if((echo?e.sender?.id:e.recipient?.id)!==pageId) continue;
      if(!e.message && !e.postback) continue;
      const at=Number(e.timestamp);
      if(!Number.isFinite(at) || at<=0 || at>Date.now()+300000) continue;
      const text=String(e.message?.text??e.postback?.title??'').slice(0,6000);
      out.push({id:e.message?.mid??e.postback?.mid??eventHash(e),mid:e.message?.mid,psid,kind:echo?'echo':'customer',text,at});
    }
  }
  return out;
}
export function makeWebhook(config,secrets,store) {
  const logFile=resolve(dirname(config.database),'..','logs','webhook.log');
  return async(req,res)=> {
    const u=new URL(req.url,'http://localhost');
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Type','text/plain; charset=utf-8');
    res.setHeader('X-Content-Type-Options','nosniff');
    log(logFile,`INCOMING method=${req.method} path=${u.pathname} ip=${clientIp(req)} len=${req.headers['content-length']??'unknown'}`);
    if(req.method==='GET') {
      const ok=u.searchParams.get('hub.mode')==='subscribe' && equal(u.searchParams.get('hub.verify_token'),secrets.META_WEBHOOK_VERIFY_TOKEN);
      log(logFile,`GET verify ${ok?'ok':'fail'} challenge=${u.searchParams.get('hub.challenge')??'none'}`);
      res.statusCode=ok?200:403; res.end(ok?u.searchParams.get('hub.challenge')??'':'forbidden'); return true;
    }
    if(req.method!=='POST') { log(logFile,`METHOD reject method=${req.method}`); res.statusCode=405; res.end(); return true; }
    try {
      const raw=await readBody(req);
      const expected='sha256='+createHmac('sha256',secrets.META_APP_SECRET).update(raw).digest('hex');
      if(!equal(req.headers['x-hub-signature-256'],expected)) {log(logFile,`POST sig_fail len=${raw.length}`);res.statusCode=403;res.end('forbidden');return true;}
      let events;
      try { events=normalizeEvents(JSON.parse(raw.toString('utf8')),config.pageId); }
      catch(e) {log(logFile,`POST invalid_payload len=${raw.length} err=${e.message}`);res.statusCode=400;res.end('invalid payload');return true;}
      store.ingest(events,config);
      log(logFile,`POST ingested len=${raw.length} ${summarizeEvents(events)}`);
      res.statusCode=200;res.end('EVENT_RECEIVED');
    } catch(e) {log(logFile,`POST err=${e.message}`);res.statusCode=e.message==='body_limit'?413:503;res.end('unavailable');}
    return true;
  };
}

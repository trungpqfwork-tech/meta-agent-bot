import { createServer } from 'node:http';
import { equal, readBody } from './webhook.mjs';

const html=`<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Page CSKH</title>
<style>body{font:16px system-ui;max-width:1000px;margin:32px auto;padding:16px}input,button{padding:10px;margin:6px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f1f5f9;padding:16px}</style>
<h1>Page CSKH — Điều khiển nhân viên</h1><p>Mở qua localhost hoặc SSH tunnel. Token chỉ giữ trong bộ nhớ trang, không lưu trình duyệt.</p>
<input id="token" type="password" placeholder="Admin token" autocomplete="off"><button id="load">Tải trạng thái</button>
<p id="notice"></p><div id="items"></div><h2>Lượt xử lý gần đây</h2><pre id="jobs"></pre>
<script>
const notice=document.getElementById('notice');
async function api(path,body){const r=await fetch(path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+document.getElementById('token').value,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const j=await r.json();if(!r.ok)throw Error(j.error);return j;}
async function load(){try{const s=await api('/status');notice.textContent='Page '+s.pageId+' — '+s.mode;const items=document.getElementById('items');items.replaceChildren();for(const c of s.conversations){const row=document.createElement('div');const label=document.createElement('span');label.textContent=c.psid+' — '+c.state+' — '+c.reason;row.append(label);for(const [name,path] of [['Tiếp quản','/takeover'],['Giao lại bot','/resume']]){const b=document.createElement('button');b.textContent=name;b.onclick=async()=>{try{await api(path,{psid:c.psid});await load();}catch(e){notice.textContent=e.message}};row.append(b)}items.append(row)}document.getElementById('jobs').textContent=JSON.stringify(s.jobs,null,2)}catch(e){notice.textContent=e.message}}
document.getElementById('load').onclick=load;
</script></html>`;

export async function startAdmin(c,secrets,store) {
  const server=createServer(async(req,res)=> {
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    const host=req.headers.host;
    if(![`127.0.0.1:${c.adminPort}`,`localhost:${c.adminPort}`].includes(host)) {res.statusCode=403;res.end();return;}
    const u=new URL(req.url,`http://${host}`);
    if(u.pathname==='/' && req.method==='GET') {res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return;}
    res.setHeader('Content-Type','application/json');
    if(!equal(req.headers.authorization,`Bearer ${secrets.CSKH_ADMIN_TOKEN}`)) {res.statusCode=401;res.end('{"error":"Unauthorized"}');return;}
    try {
      if(req.method==='GET' && u.pathname==='/status') {res.end(JSON.stringify({...store.snapshot(),mode:c.mode}));return;}
      if(req.method==='GET' && u.pathname==='/history') {res.end(JSON.stringify(store.history(u.searchParams.get('psid')??'')));return;}
      if(req.method!=='POST') {res.statusCode=404;res.end('{}');return;}
      const body=JSON.parse((await readBody(req,4096)).toString());
      if(u.pathname==='/takeover') store.takeover(body.psid);
      else if(u.pathname==='/resume') store.resume(body.psid);
      else if(u.pathname==='/reconcile' && typeof body.delivered==='boolean') store.reconcile(body.jobId,body.delivered);
      else {res.statusCode=404;res.end('{}');return;}
      res.end('{"ok":true}');
    }catch {res.statusCode=409;res.end('{"error":"Action rejected. Check conversation and unresolved sends."}');}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(c.adminPort,'127.0.0.1',resolve)});
  return server;
}

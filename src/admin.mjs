import { createServer } from 'node:http';
import { equal, readBody } from './webhook.mjs';
import { scoreMarketingSeo } from './seoscore.mjs';
import { composePostMessage } from './marketing.mjs';

// Danh sách bài cho admin UI: thêm điểm SEO/social và nội dung thật sẽ đăng
// (caption + hashtag) để người duyệt thấy đúng thứ Facebook sẽ nhận.
function withSeo(c, post) {
  let hashtags=[], media=[];
  try { hashtags=JSON.parse(post.hashtags||'[]'); } catch {}
  try { media=JSON.parse(post.media||'[]'); } catch {}
  const parsed={...post,hashtags,media};
  const minScore=Number(c?.marketing?.minScore??0);
  const seo=scoreMarketingSeo(parsed);
  return {...parsed,seo,below_min_score:minScore>0&&seo.score<minScore,min_score:minScore,publish_body:composePostMessage(post.caption,hashtags)};
}

const html=`<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Page CSKH</title>
<style>body{font:16px system-ui;max-width:1000px;margin:32px auto;padding:16px}input,button{padding:10px;margin:6px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f1f5f9;padding:16px}</style>
<h1>Page CSKH — Điều khiển nhân viên</h1><p>Mở qua localhost hoặc SSH tunnel. Token chỉ giữ trong bộ nhớ trang, không lưu trình duyệt.</p>
<input id="token" type="password" placeholder="Admin token" autocomplete="off"><button id="load">Tải trạng thái</button>
<p id="notice"></p><div id="items"></div><h2>Bài marketing</h2><button id="loadMarketing">Tải bài marketing</button><button id="autoDraft">Tự chọn chủ đề + viết draft</button><input id="autoInstruction" placeholder="Gợi ý tuỳ chọn, ví dụ: ưu tiên món có ảnh" style="width:360px"><div id="marketingItems"></div><pre id="marketing"></pre><h2>Lượt xử lý gần đây</h2><pre id="jobs"></pre>
<script>
const notice=document.getElementById('notice');
async function api(path,body){const r=await fetch(path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+document.getElementById('token').value,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const j=await r.json();if(!r.ok)throw Error(j.error);return j;}
async function load(){try{const s=await api('/status');notice.textContent='Page '+s.pageId+' — '+s.mode;const items=document.getElementById('items');items.replaceChildren();for(const c of s.conversations){const row=document.createElement('div');const label=document.createElement('span');label.textContent=c.psid+' — '+c.state+' — '+c.reason;row.append(label);for(const [name,path] of [['Tiếp quản','/takeover'],['Giao lại bot','/resume']]){const b=document.createElement('button');b.textContent=name;b.onclick=async()=>{try{await api(path,{psid:c.psid});await load();}catch(e){notice.textContent=e.message}};row.append(b)}items.append(row)}document.getElementById('jobs').textContent=JSON.stringify(s.jobs,null,2)}catch(e){notice.textContent=e.message}}
async function loadMarketing(){try{const s=await api('/marketing/posts');const box=document.getElementById('marketingItems');box.replaceChildren();for(const p of s.posts){const row=document.createElement('div');const label=document.createElement('div');label.textContent=p.id+' — '+p.status;row.append(label);const meta=document.createElement('div');meta.textContent='SEO/social: '+p.seo.score+'/10'+(p.below_min_score?' (DƯỚI NGƯỠNG '+p.min_score+'/10)':'')+(p.seo.notes.length?' — cần cải thiện: '+p.seo.notes.join('; '):'')+' · Hashtag khi đăng: '+((p.hashtags.length?p.hashtags.join(' '):'(chưa có)'))+' · Ảnh: '+((p.media.length?p.media.map(m=>m.image_id||m.url||'ảnh').join(', '):'(chưa có ảnh đã duyệt)'));row.append(meta);const ta=document.createElement('textarea');ta.value=p.caption;ta.rows=5;ta.style.width='100%';row.append(ta);const body=document.createElement('details');const sum=document.createElement('summary');sum.textContent='Nội dung sẽ đăng (caption + hashtag)';const pre=document.createElement('pre');pre.textContent=p.publish_body;body.append(sum,pre);row.append(body);if(p.facebook_permalink){const link=document.createElement('div');link.textContent='Đã đăng: '+p.facebook_permalink;row.append(link)}for(const [name,action] of [['Lưu sửa','edit'],['Duyệt','approve'],['Đăng ngay','publish'],['Huỷ','cancel']]){const b=document.createElement('button');b.textContent=name;b.onclick=async()=>{try{const body=action==='edit'?{caption:ta.value}:{};await api('/marketing/posts/'+encodeURIComponent(p.id)+'/'+action,body);await loadMarketing();}catch(e){notice.textContent=e.message}};row.append(b)}box.append(row)}document.getElementById('marketing').textContent=JSON.stringify(s.posts,null,2)}catch(e){notice.textContent=e.message}}
document.getElementById('load').onclick=load;
document.getElementById('loadMarketing').onclick=loadMarketing;
document.getElementById('autoDraft').onclick=async()=>{try{notice.textContent='Đang tự chọn chủ đề và viết draft...';await api('/marketing/auto-draft',{instruction:document.getElementById('autoInstruction').value});await loadMarketing();notice.textContent='Đã tạo draft tự động'}catch(e){notice.textContent=e.message}};
</script></html>`;

export async function startAdmin(c,secrets,store,marketing=null) {
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
      if(req.method==='GET' && u.pathname==='/marketing/posts') {res.end(JSON.stringify({posts:store.listMarketingPosts().map(p=>withSeo(c,p))}));return;}
      if(req.method==='GET' && /^\/marketing\/posts\/[^/]+$/.test(u.pathname)) {const id=decodeURIComponent(u.pathname.split('/').at(-1));const post=store.marketingPost(id);if(!post){res.statusCode=404;res.end('{"error":"Not found"}');return;}res.end(JSON.stringify(post));return;}
      if(req.method==='GET' && u.pathname==='/marketing/permissions') {res.end(JSON.stringify(marketing?.permissions?await marketing.permissions():{granted:[],missing:['marketing_not_configured']}));return;}
      if(req.method!=='POST') {res.statusCode=404;res.end('{}');return;}
      const body=JSON.parse((await readBody(req,4096)).toString());
      if(u.pathname==='/takeover') store.takeover(body.psid);
      else if(u.pathname==='/resume') store.resume(body.psid);
      else if(u.pathname==='/reconcile' && typeof body.delivered==='boolean') store.reconcile(body.jobId,body.delivered);
      else if(u.pathname==='/marketing/draft') {if(!marketing?.createDraft) throw new Error('Marketing not configured');res.end(JSON.stringify(await marketing.createDraft(body)));return;}
      else if(u.pathname==='/marketing/auto-draft') {if(!marketing?.createAutoDraft) throw new Error('Marketing auto-draft not configured');res.end(JSON.stringify(await marketing.createAutoDraft(body)));return;}
      else if(/^\/marketing\/posts\/[^/]+\/(approve|schedule|publish|cancel|reconcile|edit|regenerate)$/.test(u.pathname)) {
        const [, , , encoded, action]=u.pathname.split('/');
        const id=decodeURIComponent(encoded);
        let result;
        if(action==='approve') result=store.approveMarketingPost(id,body.approvedBy??'admin');
        else if(action==='schedule') result=store.scheduleMarketingPost(id,Number(body.scheduledAt),body.approvedBy??'admin');
        else if(action==='publish') result=await marketing.publishNow(id,body);
        else if(action==='cancel') result=store.cancelMarketingPost(id,body.reason??'operator_cancelled');
        else if(action==='reconcile') result=store.reconcileMarketingPost(id,body);
        else if(action==='edit') result=store.updateMarketingPost(id,body);
        else if(action==='regenerate') result=await marketing.createDraft(body);
        res.end(JSON.stringify(result));return;
      }
      else {res.statusCode=404;res.end('{}');return;}
      res.end('{"ok":true}');
    }catch(e) {res.statusCode=409;res.end(JSON.stringify({error:String(e?.message??'Action rejected. Check conversation and unresolved sends.').slice(0,1000)}));}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(c.adminPort,'127.0.0.1',resolve)});
  return server;
}

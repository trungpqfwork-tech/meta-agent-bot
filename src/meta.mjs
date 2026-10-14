import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

async function metaError(response, fallback) {
  let detail = '';
  try {
    const j = await response.json();
    const e = j?.error;
    if (e) detail = [e.message, e.code ? `code=${e.code}` : '', e.error_subcode ? `subcode=${e.error_subcode}` : '', e.type ? `type=${e.type}` : ''].filter(Boolean).join(' ');
    else detail = JSON.stringify(j).slice(0,500);
  } catch {
    try { detail = (await response.text()).slice(0,500); } catch { detail = ''; }
  }
  return new Error(detail ? `${fallback}: ${detail}` : fallback);
}

export function metaClient(config,secrets,fetcher=fetch) {
  const base=`https://graph.facebook.com/${config.graphVersion}`;
  const headers={Authorization:`Bearer ${secrets.META_PAGE_ACCESS_TOKEN}`,'Content-Type':'application/json'};
  return {
    async probe() {
      const r=await fetcher(`${base}/me?fields=id`,{headers,signal:AbortSignal.timeout(10000)});
      if(!r.ok) {
        const appToken=`${config.appId}|${secrets.META_APP_SECRET}`;
        const d=await fetcher(`${base.replace(/\/v\d+\.\d+$/,'')}/debug_token?input_token=${encodeURIComponent(secrets.META_PAGE_ACCESS_TOKEN)}&access_token=${encodeURIComponent(appToken)}`,{signal:AbortSignal.timeout(10000)});
        if(!d.ok) throw new Error('Meta token probe failed');
        const data=(await d.json()).data;
        if(data?.is_valid!==true || data?.type!=='PAGE' || data?.profile_id!==config.pageId) throw new Error('Page token does not match configured Page');
        return true;
      }
      const j=await r.json(); if(j.id!==config.pageId) throw new Error('Page token does not match configured Page');
      return true;
    },
    async send(psid,text) {
      // Recipient comes ONLY from stored job, never model output.
      const r=await fetcher(`${base}/${config.pageId}/messages`,{
        method:'POST',headers,signal:AbortSignal.timeout(15000),
        body:JSON.stringify({recipient:{id:psid},messaging_type:'RESPONSE',message:{text}})
      });
      if(!r.ok) throw new Error('Meta send failed; inspect before retry');
      const j=await r.json();
      if(j.recipient_id!==psid || typeof j.message_id!=='string') throw new Error('Unexpected Meta receipt');
      return j.message_id;
    },
    async senderAction(psid,action) {
      const r=await fetcher(`${base}/${config.pageId}/messages`,{
        method:'POST',headers,signal:AbortSignal.timeout(10000),
        body:JSON.stringify({recipient:{id:psid},sender_action:action})
      });
      if(!r.ok) throw new Error('Meta sender action failed');
      return true;
    },
    // Upload a local file once and reuse the returned attachment_id. Meta only
    // accepts an image by public URL or by an id it issued itself; uploading is
    // what lets the operator keep photos as local files under runtime/images.
    async uploadAttachment(filePath) {
      const buf=readFileSync(filePath);
      const form=new FormData();
      form.append('message',JSON.stringify({attachment:{type:'image'}}));
      form.append('filedata',new Blob([buf]),basename(filePath));
      // No Content-Type here: fetch must set the multipart boundary itself.
      const r=await fetcher(`${base}/${config.pageId}/message_attachments`,{
        method:'POST',headers:{Authorization:`Bearer ${secrets.META_PAGE_ACCESS_TOKEN}`},
        body:form,signal:AbortSignal.timeout(30000)
      });
      if(!r.ok) throw new Error('Meta attachment upload failed');
      const j=await r.json();
      if(typeof j.attachment_id!=='string') throw new Error('Unexpected attachment receipt');
      return j.attachment_id;
    },
    async probePostPermissions() {
      const token=secrets.META_PAGE_PUBLISH_ACCESS_TOKEN || secrets.META_PAGE_ACCESS_TOKEN;
      const r=await fetcher(`${base}/me/permissions`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(10000)});
      if(!r.ok) throw new Error('Meta post permission probe failed');
      const data=(await r.json()).data ?? [];
      const granted=data.filter(x=>x.status==='granted').map(x=>x.permission);
      return {granted,missing:['pages_manage_posts','pages_read_engagement','pages_show_list'].filter(x=>!granted.includes(x))};
    },
    async listPublishedPosts({limit=12}={}) {
      const token=secrets.META_PAGE_PUBLISH_ACCESS_TOKEN || secrets.META_PAGE_ACCESS_TOKEN;
      const fields='id,created_time,message,permalink_url,attachments{media_type,url,title,description,media}';
      const r=await fetcher(`${base}/${config.pageId}/published_posts?fields=${encodeURIComponent(fields)}&limit=${Math.max(1,Math.min(25,Number(limit)||12))}`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(10000)});
      if(!r.ok) throw new Error('Meta published posts read failed');
      const data=(await r.json()).data ?? [];
      return data.map(p=>({
        id:String(p.id??''),
        created_time:String(p.created_time??''),
        permalink_url:String(p.permalink_url??''),
        message:String(p.message??''),
        attachments:Array.isArray(p.attachments?.data)?p.attachments.data.map(a=>({media_type:String(a.media_type??''),has_media:!!a.media,url:String(a.url??'')})):[]
      })).filter(p=>p.id && p.message).slice(0,25);
    },
    async publishFeedPost({message,link='',scheduledAt=0}={}) {
      const token=secrets.META_PAGE_PUBLISH_ACCESS_TOKEN || secrets.META_PAGE_ACCESS_TOKEN;
      const body={message:String(message??'')};
      if(!body.message.trim()) throw new Error('Meta post message required');
      if(link) body.link=String(link);
      if(scheduledAt) { body.published=false; body.scheduled_publish_time=Math.floor(scheduledAt/1000); }
      const r=await fetcher(`${base}/${config.pageId}/feed`,{
        method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(20000),body:JSON.stringify(body)
      });
      if(!r.ok) throw await metaError(r, 'Meta feed publish failed');
      const j=await r.json();
      if(typeof j.id!=='string') throw new Error('Unexpected Meta post receipt');
      return j.id;
    },
    async publishPhotoPost({caption='',imageUrl='',filePath='',scheduledAt=0}={}) {
      const token=secrets.META_PAGE_PUBLISH_ACCESS_TOKEN || secrets.META_PAGE_ACCESS_TOKEN;
      const form=new FormData();
      form.append('caption',String(caption));
      if(imageUrl) form.append('url',String(imageUrl));
      else if(filePath) form.append('source',new Blob([readFileSync(filePath)]),basename(filePath));
      else throw new Error('Meta photo source required');
      if(scheduledAt) { form.append('published','false'); form.append('scheduled_publish_time',String(Math.floor(scheduledAt/1000))); }
      const r=await fetcher(`${base}/${config.pageId}/photos`,{method:'POST',headers:{Authorization:`Bearer ${token}`},body:form,signal:AbortSignal.timeout(30000)});
      if(!r.ok) throw await metaError(r, 'Meta photo publish failed');
      const j=await r.json();
      if(typeof j.id!=='string' && typeof j.post_id!=='string') throw new Error('Unexpected Meta photo receipt');
      return j.post_id || j.id;
    },
    async readPost(postId) {
      const token=secrets.META_PAGE_PUBLISH_ACCESS_TOKEN || secrets.META_PAGE_ACCESS_TOKEN;
      const r=await fetcher(`${base}/${encodeURIComponent(postId)}?fields=id,permalink_url,created_time,message`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(10000)});
      if(!r.ok) throw new Error('Meta post readback failed');
      const j=await r.json();
      if(j.id!==postId || typeof j.permalink_url!=='string') throw new Error('Unexpected Meta post readback');
      return j;
    },
    // payload is {attachment_id} for an uploaded file or {url} for a public image.
    async sendImage(psid,payload) {
      const r=await fetcher(`${base}/${config.pageId}/messages`,{
        method:'POST',headers,signal:AbortSignal.timeout(20000),
        body:JSON.stringify({recipient:{id:psid},messaging_type:'RESPONSE',message:{attachment:{type:'image',payload}}})
      });
      if(!r.ok) throw new Error('Meta image send failed');
      const j=await r.json();
      if(j.recipient_id!==psid || typeof j.message_id!=='string') throw new Error('Unexpected Meta receipt');
      return j.message_id;
    }
  };
}

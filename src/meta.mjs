import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

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

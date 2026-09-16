export function metaClient(config,secrets,fetcher=fetch) {
  const base=`https://graph.facebook.com/${config.graphVersion}`;
  const headers={Authorization:`Bearer ${secrets.META_PAGE_ACCESS_TOKEN}`,'Content-Type':'application/json'};
  return {
    async probe() {
      const r=await fetcher(`${base}/me?fields=id`,{headers,signal:AbortSignal.timeout(10000)});
      if(!r.ok) throw new Error('Meta token probe failed');
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
    }
  };
}

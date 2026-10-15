import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { metaClient } from '../src/meta.mjs';
import { startAdmin } from '../src/admin.mjs';
import { createMarketing, scoreMarketingSeo, buildHashtags, selectPostImages, ensureMinMedia } from '../src/marketing.mjs';

function fixture(t,mode='live') {
  const dir=mkdtempSync(join(tmpdir(),'page-cskh-marketing-'));
  const c={
    pageId:'100',appId:'200',pageName:'Test Page',graphVersion:'v25.0',mode,agentId:'page-cskh',model:'provider/model',agentTimeoutMs:45000,adminPort:30000+Math.floor(Math.random()*10000),
    publicWebhookUrl:'https://example.test/webhooks/page-cskh',
    database:join(dir,'state.sqlite'),knowledgeFile:join(dir,'knowledge.json'),imageCatalogFile:join(dir,'images/catalog.json'),imageDir:join(dir,'images'),
    marketing:{enabled:true,approvalRequired:true,maxPostsPerDay:3,defaultTone:'thân thiện',timezone:'Asia/Ho_Chi_Minh',quietHours:'22:00-07:00',minScore:0,reviseAttempts:1,lowScoreAction:'warn'}
  };
  mkdirSync(c.imageDir,{recursive:true});
  writeFileSync(c.knowledgeFile,JSON.stringify({schemaVersion:1,documents:[{id:'product-salmon',title:'Cá hồi',keywords:['cá hồi'],content:'Cá hồi Na Uy cắt khúc, phù hợp gia đình.',approved:true,validUntil:null}]}));
  writeFileSync(c.imageCatalogFile,JSON.stringify({schemaVersion:1,images:[{id:'salmon-photo',title:'Ảnh cá hồi',keywords:['cá hồi'],file:'salmon.jpg',caption:'Ảnh cá hồi',approved:true}]}));
  const s=new Store(c.database,c.pageId);t.after(()=>s.close());
  return {dir,c,s};
}

const draft={topic:'cá hồi cuối tuần',title_internal:'Cá hồi cuối tuần',caption:'Cá hồi Na Uy cho bữa tối cuối tuần. Inbox để được tư vấn.',hashtags:['#TMFood'],cta:'Inbox để được tư vấn',media:[{type:'image',image_id:'salmon-photo'}],source_ids:['product-salmon'],risk_flags:[]};

test('marketing post state machine requires approval before publish reservation',t=>{
  const {s}=fixture(t);
  const post=s.createMarketingPost(draft);
  assert.equal(post.status,'pending_approval');
  assert.equal(s.reserveMarketingPublish(post.id),null);
  s.approveMarketingPost(post.id,'owner');
  const reserved=s.reserveMarketingPublish(post.id);
  assert.equal(reserved.status,'publishing');
  s.markMarketingFailed(post.id,new Error('temporary meta error'));
  assert.equal(s.marketingPost(post.id).status,'failed');
  assert.equal(s.reserveMarketingPublish(post.id).status,'publishing');
  s.markMarketingPublished(post.id,{facebookPostId:'100_1',facebookPermalink:'https://facebook.com/100_1',publishedAt:1234});
  const saved=s.marketingPost(post.id);
  assert.equal(saved.status,'published');
  assert.equal(saved.facebook_post_id,'100_1');
  assert.equal(saved.facebook_permalink,'https://facebook.com/100_1');
});

test('marketing scheduled due posts are reserved once and stale publishing becomes unknown',t=>{
  const {s}=fixture(t);
  const post=s.createMarketingPost(draft);
  s.scheduleMarketingPost(post.id,1000,'owner');
  assert.deepEqual(s.marketingPostsDue(999,10),[]);
  assert.equal(s.marketingPostsDue(1000,10)[0].id,post.id);
  assert.equal(s.reserveMarketingPublish(post.id).status,'publishing');
  assert.equal(s.reserveMarketingPublish(post.id),null);
  s.db.prepare('UPDATE fb_posts SET updated=0 WHERE id=?').run(post.id);
  assert.equal(s.markStaleMarketingPublishingUnknown(1001),1);
  assert.equal(s.marketingPost(post.id).status,'unknown');
});

test('Meta publisher uses publish token, posts feed, and reads permalink back',async()=>{
  const calls=[];
  const client=metaClient({graphVersion:'v25.0',pageId:'100',appId:'200'},{META_PAGE_ACCESS_TOKEN:'messenger-token',META_PAGE_PUBLISH_ACCESS_TOKEN:'publish-token',META_APP_SECRET:'app-secret'},async(url,opts={})=>{
    calls.push({url:String(url),opts});
    assert.equal(opts.headers?.Authorization,'Bearer publish-token');
    if(String(url).endsWith('/100/feed')) return {ok:true,json:async()=>({id:'100_1'})};
    if(String(url).includes('/100_1?')) return {ok:true,json:async()=>({id:'100_1',permalink_url:'https://facebook.com/100_1',message:'hello'})};
    throw new Error('unexpected '+url);
  });
  const id=await client.publishFeedPost({message:'hello'});
  assert.equal(id,'100_1');
  const post=await client.readPost(id);
  assert.equal(post.permalink_url,'https://facebook.com/100_1');
  assert.equal(calls.length,2);
});

test('Meta publisher includes Graph error details on feed failures',async()=>{
  const client=metaClient({graphVersion:'v25.0',pageId:'100',appId:'200'},{META_PAGE_ACCESS_TOKEN:'messenger-token',META_PAGE_PUBLISH_ACCESS_TOKEN:'publish-token',META_APP_SECRET:'app-secret'},async()=>({
    ok:false,
    json:async()=>({error:{message:'Invalid parameter',code:100,error_subcode:2018001,type:'OAuthException'}})
  }));
  await assert.rejects(()=>client.publishFeedPost({message:'hello'}),/Meta feed publish failed: Invalid parameter code=100 subcode=2018001 type=OAuthException/);
});

test('Meta publisher reads Page published_posts for style learning',async()=>{
  const calls=[];
  const client=metaClient({graphVersion:'v25.0',pageId:'100',appId:'200'},{META_PAGE_ACCESS_TOKEN:'messenger-token',META_PAGE_PUBLISH_ACCESS_TOKEN:'publish-token',META_APP_SECRET:'app-secret'},async(url,opts={})=>{
    calls.push({url:String(url),opts});
    assert.equal(opts.headers?.Authorization,'Bearer publish-token');
    assert.match(String(url),/\/100\/published_posts\?/);
    return {ok:true,json:async()=>({data:[{id:'100_9',created_time:'2026-10-12T00:00:00+0000',permalink_url:'https://facebook.com/p',message:'🥩 BẮP HOA BÒ - MẪU',attachments:{data:[{media_type:'photo',media:{image:{src:'x'}},url:'https://facebook.com/p'}]}}]})};
  });
  const posts=await client.listPublishedPosts({limit:5});
  assert.equal(posts.length,1);
  assert.equal(posts[0].message,'🥩 BẮP HOA BÒ - MẪU');
  assert.equal(posts[0].attachments[0].has_media,true);
  assert.equal(calls.length,1);
});

test('marketing module creates draft, blocks draft mode, then publishes approved post with readback',async t=>{
  const {c,s}=fixture(t,'draft');
  const meta={publishFeedPost:async()=>{throw new Error('draft mode must not publish');},readPost:async()=>({})};
  const complete=async()=>JSON.stringify({title_internal:'Cá hồi',caption:'Cá hồi Na Uy cho cuối tuần. Inbox để được tư vấn.',hashtags:['#TMFood'],cta:'Inbox',media:[{type:'image',image_id:'salmon-photo'}],source_ids:['product-salmon'],risk_flags:[],confidence:0.9});
  const marketing=createMarketing(c,s,complete,meta,{notifier:{notifyMarketingPreview:async()=>{throw new Error('telegram down');}}});
  const post=await marketing.createDraft({prompt:'viết bài cá hồi'});
  assert.equal(post.status,'pending_approval');
  s.approveMarketingPost(post.id,'owner');
  await assert.rejects(()=>marketing.publishNow(post.id),/draft mode/);

  c.mode='live';
  let publishedMessage='';
  const live=createMarketing(c,s,complete,{publishFeedPost:async ({message})=>{publishedMessage=message;return '100_1';},publishPhotoPost:async ({caption})=>{publishedMessage=caption;return '100_1';},readPost:async()=>({id:'100_1',permalink_url:'https://facebook.com/100_1',message:publishedMessage})});
  const result=await live.publishNow(post.id);
  assert.equal(result.status,'published');
  assert.equal(result.facebook_permalink,'https://facebook.com/100_1');
  assert.match(publishedMessage,/#TestPage/);
});

test('marketing auto-draft chooses a KB topic, learns Page style, then creates a draft',async t=>{
  const {c,s}=fixture(t,'live');
  writeFileSync(c.knowledgeFile,JSON.stringify({schemaVersion:1,documents:[
    {id:'usage-beef',title:'Công dụng sản phẩm bò',keywords:['bắp bò','bò','lẩu','nướng','nhà hàng'],content:'Bắp bò có xuất xứ Brazil, dùng làm lẩu, nướng; phù hợp nhà hàng, quán ăn, bếp ăn.',approved:true,validUntil:null},
    {id:'product-salmon',title:'Cá hồi',keywords:['cá hồi'],content:'Cá hồi Na Uy phù hợp gia đình.',approved:true,validUntil:null}
  ]}));
  const calls=[];
  const complete=async ({message})=>{
    calls.push(message);
    if(calls.length===1) return JSON.stringify({topic:'Bắp bò Brazil',prompt:'Viết bài bắp bò xuất xứ Brazil, dùng lẩu/nướng, cho nhà hàng/quán ăn/bếp ăn.',tone:'theo style bài đã đăng',source_ids:['usage-beef'],reason:'có facts rõ'});
    return JSON.stringify({title_internal:'Bắp bò Brazil',caption:'🥩 BẮP BÒ BRAZIL - GIÒN NGON, HỢP LẨU NƯỚNG\n\n🔥 Bắp bò xuất xứ Brazil, dùng được cho lẩu và nướng, phù hợp nhà hàng, quán ăn, bếp ăn.\n\n✅ Chế biến đa dạng:\n- 🍲 Lẩu bắp bò\n- 🍢 Bắp bò nướng\n\n💯 Test Page - Cung cấp bắp bò cho nhà hàng, quán ăn.\n\n✔ Xuất xứ Brazil\n✔ Dùng được cho lẩu, nướng\n\n💬 Inbox/comment để được tư vấn.',hashtags:['bap bo','brazil','nha hang'],cta:'Inbox/comment để được tư vấn',media:[],source_ids:['usage-beef'],risk_flags:['no_approved_image_available'],confidence:0.9});
  };
  const meta={listPublishedPosts:async()=>[{id:'100_1',created_time:'2026-10-12T00:00:00+0000',message:'🥩 BẮP HOA BÒ - GIÒN NGON\n\n✅ Chế biến đa dạng:\n- 🍲 Lẩu bò\n#TMfood #BapHoaBo',attachments:[{media_type:'photo',has_media:true}]}]};
  const post=await createMarketing(c,s,complete,meta).createAutoDraft({instruction:'tự chọn chủ đề'});
  assert.equal(post.status,'pending_approval');
  assert.equal(calls.length,2);
  assert.match(calls[0],/Candidate từ KB/);
  assert.match(calls[0],/BẮP HOA BÒ/);
  assert.match(calls[1],/Bài Page đã đăng để học style/);
  assert.match(post.topic,/AUTO_TOPIC: Bắp bò Brazil/);
  assert.match(post.caption,/BẮP BÒ BRAZIL/);
});

test('admin marketing endpoints require token and create/list/publish posts',async t=>{
  const {c,s}=fixture(t,'live');
  const secrets={CSKH_ADMIN_TOKEN:'a'.repeat(40)};
  let published=false;
  const marketing={
    createDraft:async body=>s.createMarketingPost({...draft,topic:body.prompt}),
    publishNow:async id=>{published=true;return s.markMarketingPublished(id,{facebookPostId:'100_1',facebookPermalink:'https://facebook.com/100_1'});},
    permissions:async()=>({granted:['pages_manage_posts'],missing:[]})
  };
  const server=await startAdmin(c,secrets,s,marketing);t.after(()=>new Promise(r=>server.close(r)));
  const url=`http://127.0.0.1:${c.adminPort}`;
  assert.equal((await fetch(url+'/marketing/posts')).status,401);
  const headers={Authorization:`Bearer ${secrets.CSKH_ADMIN_TOKEN}`,'Content-Type':'application/json'};
  const created=await (await fetch(url+'/marketing/draft',{method:'POST',headers,body:JSON.stringify({prompt:'cá hồi'})})).json();
  assert.equal(created.status,'pending_approval');
  const listed=(await (await fetch(url+'/marketing/posts',{headers})).json()).posts;
  assert.equal(listed.length,1);
  assert.equal(typeof listed[0].seo.score,'number');
  assert.match(listed[0].publish_body,/#TMFood/);
  assert.equal((await fetch(url+`/marketing/posts/${created.id}/approve`,{method:'POST',headers,body:'{}'})).status,200);
  const publishedPost=await (await fetch(url+`/marketing/posts/${created.id}/publish`,{method:'POST',headers,body:'{}'})).json();
  assert.equal(publishedPost.status,'published');
  assert.equal(published,true);
});

test('marketing scheduler publishes only due approved posts once',async t=>{
  const {c,s}=fixture(t,'live');
  c.marketing.quietHours='23:00-06:00';
  const post=s.createMarketingPost(draft);
  s.scheduleMarketingPost(post.id,1000,'owner');
  let calls=0;
  const marketing=createMarketing(c,s,async()=>'',{publishFeedPost:async()=>{calls++;return '100_1';},publishPhotoPost:async()=>{calls++;return '100_1';},readPost:async()=>({id:'100_1',permalink_url:'https://facebook.com/100_1'})});
  assert.equal(await marketing.tick(999),0);
  assert.equal(await marketing.tick(1000),1);
  assert.equal(await marketing.tick(1000),0);
  assert.equal(calls,1);
});

test('published post carries the hashtags, not just the caption',async t=>{
  const {c,s}=fixture(t,'live');
  const post=s.createMarketingPost({...draft,hashtags:['TMFood','  #CáHồi  ','#TMFood'],caption:'Cá hồi Na Uy cho bữa tối cuối tuần.',media:[]});
  s.approveMarketingPost(post.id,'owner');
  let publishedMessage='';
  const marketing=createMarketing(c,s,async()=>'',{publishFeedPost:async ({message})=>{publishedMessage=message;return '100_1';},readPost:async()=>({id:'100_1',permalink_url:'https://facebook.com/100_1'})});
  await marketing.publishNow(post.id);
  assert.match(publishedMessage,/Cá hồi Na Uy cho bữa tối cuối tuần\./);
  assert.match(publishedMessage,/#TMFood/);
  assert.match(publishedMessage,/#CáHồi/);
  assert.equal(publishedMessage.match(/#TMFood/g).length,1);
});

test('an approved image_id becomes a real photo publish against the public image URL',async t=>{
  const {c,s}=fixture(t,'live');
  const post=s.createMarketingPost(draft);
  s.approveMarketingPost(post.id,'owner');
  let photo=null, feed=0;
  const marketing=createMarketing(c,s,async()=>'',{
    publishFeedPost:async()=>{feed++;return '100_feed';},
    publishPhotoPost:async args=>{photo=args;return '100_photo';},
    readPost:async()=>({id:'100_photo',permalink_url:'https://facebook.com/100_photo'})
  });
  const result=await marketing.publishNow(post.id);
  assert.equal(feed,0);
  assert.equal(photo.imageUrl,'https://example.test/images/salmon.jpg');
  assert.match(photo.caption,/#TMFood/);
  assert.equal(result.facebook_post_id,'100_photo');
});

test('a draft pointing at a non-approved image falls back to a text post',async t=>{
  const {c,s}=fixture(t,'live');
  writeFileSync(c.imageCatalogFile,JSON.stringify({schemaVersion:1,images:[{id:'salmon-photo',title:'Ảnh cá hồi',keywords:['cá hồi'],file:'salmon.jpg',approved:false}]}));
  const post=s.createMarketingPost({...draft,media:[{type:'image',image_id:'salmon-photo'}]});
  s.approveMarketingPost(post.id,'owner');
  let photo=0, message='';
  const marketing=createMarketing(c,s,async()=>'',{
    publishFeedPost:async args=>{message=args.message;return '100_feed';},
    publishPhotoPost:async()=>{photo++;return '100_photo';},
    readPost:async()=>({id:'100_feed',permalink_url:'https://facebook.com/100_feed'})
  });
  await marketing.publishNow(post.id);
  assert.equal(photo,0);
  assert.match(message,/#TMFood/);
});

const weakDraft='{"title_internal":"Cá hồi","caption":"Nâng tầm bữa ăn gia đình cùng sản phẩm chất lượng vượt trội.","hashtags":[],"cta":"","media":[],"source_ids":["product-salmon"],"risk_flags":[]}';
const strongDraft='{"title_internal":"Cá hồi","caption":"Cá hồi Na Uy, Chile, Úc cho bữa cơm gia đình tại Thái Bình. Nướng hay áp chảo đều được. Inbox em để chọn loại phù hợp.","hashtags":["#TMFood","#CaHoi","#ThaiBinh"],"cta":"Inbox","media":[{"type":"image","image_id":"salmon-photo"}],"source_ids":["product-salmon"],"risk_flags":[]}';

test('below the score gate the model is asked to rewrite and the better draft wins',async t=>{
  const {c,s}=fixture(t,'live');
  c.marketing.minScore=7;
  const calls=[];
  const complete=async ({message})=>{calls.push(message);return calls.length===1?weakDraft:strongDraft;};
  const marketing=createMarketing(c,s,complete,{});
  const post=await marketing.createDraft({prompt:'cá hồi'});
  assert.equal(calls.length,2);
  assert.match(calls[1],/BẢN TRƯỚC CHƯA ĐẠT/);
  assert.match(calls[1],/dưới ngưỡng 7\/10/);
  assert.equal(post.caption.includes('vượt trội'),false);
});

test('a post still below the gate is flagged, and lowScoreAction=hold stops the Telegram preview',async t=>{
  const {c,s}=fixture(t,'live');
  c.marketing.minScore=9;
  c.marketing.reviseAttempts=1;
  let previews=0;
  const marketing=createMarketing(c,s,async()=>weakDraft,{},{notifier:{notifyMarketingPreview:async()=>{previews++;}}});
  const warned=await marketing.createDraft({prompt:'cá hồi'});
  assert.equal(warned.status,'pending_approval');
  assert.match(warned.risk_flags,/low_seo_score_/);
  assert.equal(previews,1);

  previews=0;
  c.marketing.lowScoreAction='hold';
  const held=await createMarketing(c,s,async()=>weakDraft,{},{notifier:{notifyMarketingPreview:async()=>{previews++;}}}).createDraft({prompt:'cá hồi'});
  assert.equal(held.held,true);
  assert.equal(previews,0);
});

test('at or above the gate the first draft is kept and no rewrite happens',async t=>{
  const {c,s}=fixture(t,'live');
  c.marketing.minScore=6;
  let calls=0;
  const marketing=createMarketing(c,s,async()=>{calls++;return strongDraft;},{});
  const post=await marketing.createDraft({prompt:'cá hồi'});
  assert.equal(calls,1);
  assert.equal(post.risk_flags.includes('low_seo_score_6'),false);
});

test('TM Food sample-style emoji bullet layout is not treated as AI copy',async()=>{
  const caption=`🥩 BẮP HOA BÒ - GIÒN NGON SẦN SẬT, ĐA DẠNG MÓN NGON
🔥 Bắp hoa bò nổi bật với những đường gân xen kẽ đẹp mắt, thịt chắc, vị ngọt tự nhiên.

✅ Chế biến đa dạng:
- 🍲 Bắp bò luộc, bắp bò ngâm mắm
- 🍛 Bắp bò hầm tiêu xanh, hầm thuốc bắc
- 🍜 Phở bò, bún bò, lẩu bò

💯 TMFood - Chuyên thực phẩm đông lạnh cho nhà hàng, quán ăn và đại lý.
✔ Hàng hóa rõ nguồn gốc
✔ Hỗ trợ sơ chế, chia cắt theo nhu cầu

📞 Liên hệ TMfood để được tư vấn theo nhu cầu.`;
  const seo=scoreMarketingSeo({caption,hashtags:['#TMFood','#BapHoaBo','#ThitBoNhapKhau','#ThucPhamDongLanh'],media:[{type:'image',image_id:'beef'}]});
  assert.equal(seo.aiTells.length,0);
  assert.equal(seo.notes.some(n=>/emoji|mùi AI/i.test(n)),false);
  assert.equal(seo.score>=8,true);
});

test('AI-sounding copy loses the naturalness point and is named in the notes',async t=>{
  const {s}=fixture(t,'live');
  const post=s.createMarketingPost({...draft,caption:'Nâng tầm bữa ăn gia đình — giải pháp tuyệt vời cho mọi nhà. Inbox ngay nhé!'});
  const seo=scoreMarketingSeo({...post,hashtags:['#TMFood'],media:[]});
  assert.match(seo.notes.join(';'),/mùi AI/);
  assert.match(seo.aiTells.join(';'),/gạch dài/);
  assert.match(seo.aiTells.join(';'),/Từ quảng cáo sáo/);
  const questionHook=scoreMarketingSeo({...post,caption:'Quán ăn ở Thái Bình đang cần cá hồi cho thực đơn cuối tuần? Bên em có cá hồi Na Uy. Inbox nhé.',hashtags:['#TMFood'],media:[]});
  assert.match(questionHook.aiTells.join(';'),/câu hỏi/);
  const clean=scoreMarketingSeo({...post,caption:'Cá hồi Na Uy cắt khúc cho bữa tối gia đình ở Thái Bình. Inbox em tư vấn loại phù hợp.',hashtags:['#TMFood','#CaHoi','#ThaiBinh'],media:[]});
  assert.equal(clean.aiTells.length,0);
});

test('hashtags are rebuilt into clean ASCII tags instead of the model formatting',async t=>{
  const {c,s}=fixture(t,'live');
  const tags=buildHashtags(c,{prompt:'bài về cá hồi cho nhà hàng ở Thái Bình',caption:'Cá hồi Na Uy cho bữa cơm gia đình ở Thái Bình.',modelTags:['#thananh','cá hồi','quá dài '.repeat(10)]});
  assert.equal(tags.every(x=>/^#[A-Za-z0-9]+$/.test(x)),true);
  assert.equal(tags.includes('#CaHoi'),true);
  assert.equal(tags.includes('#ThaiBinh'),true);
  assert.equal(tags.includes('#TestPage'),true);
  assert.equal(tags.length>=3&&tags.length<=6,true);
  const draftJson=JSON.stringify({...JSON.parse(strongDraft),hashtags:['#thananh']});
  const marketing=createMarketing(c,s,async()=>draftJson,{});
  const post=await marketing.createDraft({prompt:'cá hồi Thái Bình'});
  const stored=JSON.parse(post.hashtags);
  assert.equal(stored.every(x=>/^#[A-Za-z0-9]+$/.test(x)),true);
});

test('missing CTA or fewer than 3 hashtags keeps a post under a 6-point gate',async t=>{
  const {s}=fixture(t,'live');
  const base={...draft,media:[],hashtags:['#TMFood','#CaHoi','#ThaiBinh'],caption:'Cá hồi Na Uy cắt khúc cho bữa tối gia đình ở Thái Bình.'};
  const noCta=scoreMarketingSeo({...base,source_ids:['product-salmon']});
  assert.equal(noCta.score,5);
  assert.match(noCta.notes.join(';'),/Thiếu CTA/);
  const fewTags=scoreMarketingSeo({...base,hashtags:['#TMFood'],caption:'Cá hồi Na Uy cắt khúc cho bữa tối gia đình ở Thái Bình. Inbox em tư vấn nhé.'});
  assert.equal(fewTags.score,6);
  assert.match(fewTags.notes.join(';'),/Hashtag/);
});

const gaCatalog={schemaVersion:1,images:[
  {id:'ga-1',title:'Gà nguyên con 1',keywords:['gà nguyên con'],file:'ga-1.jpg',caption:'Gà nguyên con túi vàng',approved:true},
  {id:'ga-2',title:'Gà nguyên con 2',keywords:['gà nguyên con'],file:'ga-2.jpg',caption:'Gà nguyên con góc khác',approved:true},
  {id:'ga-3',title:'Gà nguyên con 3',keywords:['gà nguyên con'],file:'ga-3.jpg',caption:'Gà nguyên con túi xanh',approved:true},
  {id:'ga-4',title:'Gà nguyên con 4',keywords:['gà nguyên con'],file:'ga-4.jpg',caption:'Gà nguyên con thùng Shinwoo',approved:true},
  {id:'ga-goc-1',title:'Gà nguyên con quay',keywords:['gà nguyên con quay'],file:'ga-goc-1.jpg',caption:'Gà nguyên con quay chín',approved:false},
  {id:'salmon-photo',title:'Ảnh cá hồi',keywords:['cá hồi'],file:'salmon.jpg',caption:'Ảnh cá hồi',approved:true}
]};

test('selectPostImages keeps only images matching the topic and ensureMinMedia tops media up to the minimum',t=>{
  const {c}=fixture(t);
  writeFileSync(c.imageCatalogFile,JSON.stringify(gaCatalog));
  const shortlist=selectPostImages(c,{query:'gà nguyên con'});
  assert.ok(shortlist.length>=3);
  assert.deepEqual(shortlist.map(i=>i.id).slice(0,3),['ga-1','ga-2','ga-3']);
  assert.equal(shortlist.some(i=>i.id==='salmon-photo'),false);
  assert.equal(shortlist.some(i=>i.id==='ga-goc-1'),false,'ảnh chưa duyệt không được vào danh sách');
  const filled=ensureMinMedia([],shortlist,{min:3,max:6});
  assert.equal(filled.enough,true);
  assert.deepEqual(filled.media.map(m=>m.image_id),['ga-1','ga-2','ga-3']);
  const kept=ensureMinMedia([{type:'image',image_id:'ga-4'}],shortlist,{min:2,max:6});
  assert.deepEqual(kept.media.map(m=>m.image_id),['ga-4','ga-1']);
  const capped=ensureMinMedia([],shortlist,{min:5,max:6});
  assert.equal(capped.media.length,4,'chỉ có 4 ảnh gà đã duyệt trong kho nên không thể đủ 5');
});

test('a marketing post keeps at least three topic images and publishes them as one album',async t=>{
  const {c,s}=fixture(t,'live');
  writeFileSync(c.imageCatalogFile,JSON.stringify(gaCatalog));
  writeFileSync(c.knowledgeFile,JSON.stringify({schemaVersion:1,documents:[{id:'product-ga',title:'Gà nguyên con',keywords:['gà nguyên con'],content:'Gà nguyên con không đầu nhập khẩu Hàn Quốc, thùng 15kg, bán buôn theo thùng.',approved:true,validUntil:null}]}));
  const complete=async()=>JSON.stringify({title_internal:'Gà nguyên con',caption:'🐔 GÀ NGUYÊN CON KHÔNG ĐẦU - NHẬP KHẨU HÀN QUỐC\n\n🔥 Gà nguyên con không đầu, quy cách thùng 15kg.\n\n✔ Bán buôn theo thùng\n\n💬 Inbox để được tư vấn',hashtags:['ga nguyen con'],cta:'Inbox',media:[],source_ids:['product-ga'],risk_flags:['no_approved_image_available']});
  let album=null,single=0,feed=0;
  const marketing=createMarketing(c,s,complete,{
    publishMultiPhotoPost:async args=>{album=args;return '100_album';},
    publishPhotoPost:async()=>{single++;return '100_photo';},
    publishFeedPost:async()=>{feed++;return '100_feed';},
    readPost:async()=>({id:'100_album',permalink_url:'https://facebook.com/100_album'})
  });
  const post=await marketing.createDraft({prompt:'gà nguyên con'});
  const media=JSON.parse(post.media), flags=JSON.parse(post.risk_flags);
  assert.equal(media.length,3,'bài phải có ít nhất 3 ảnh dù model trả media rỗng');
  assert.ok(media.every(m=>String(m.image_id).startsWith('ga-')),'ảnh phải đúng chủ đề');
  assert.equal(flags.includes('no_approved_image_available'),false);
  assert.equal(flags.includes('fewer_images_than_min'),false);
  s.approveMarketingPost(post.id,'owner');
  const result=await marketing.publishNow(post.id);
  assert.equal(single,0);
  assert.equal(feed,0);
  assert.equal(album.images.length,3);
  assert.match(album.caption,/#TestPage/,'album phải giữ hashtag của Page');
  assert.equal(album.images[0].url,'https://example.test/images/ga-1.jpg');
  assert.equal(result.facebook_post_id,'100_album');
});

test('a marketed post flags fewer_images_than_min when the topic has too few approved photos',async t=>{
  const {c,s}=fixture(t,'live');
  writeFileSync(c.imageCatalogFile,JSON.stringify({schemaVersion:1,images:[{id:'ga-1',title:'Gà',keywords:['gà nguyên con'],file:'ga-1.jpg',caption:'Gà',approved:true}]}));
  writeFileSync(c.knowledgeFile,JSON.stringify({schemaVersion:1,documents:[{id:'product-ga',title:'Gà nguyên con',keywords:['gà nguyên con'],content:'Gà nguyên con thùng 15kg.',approved:true,validUntil:null}]}));
  const complete=async()=>JSON.stringify({title_internal:'Gà',caption:'🐔 GÀ NGUYÊN CON\n\n🔥 Gà nguyên con thùng 15kg.\n\n💬 Inbox để được tư vấn',hashtags:['ga nguyen con'],cta:'Inbox',media:[],source_ids:['product-ga'],risk_flags:[]});
  const marketing=createMarketing(c,s,complete,{});
  const post=await marketing.createDraft({prompt:'gà nguyên con'});
  assert.equal(JSON.parse(post.media).length,1);
  assert.equal(JSON.parse(post.risk_flags).includes('fewer_images_than_min'),true);
});

test('Meta multi-photo publisher uploads unpublished photos then attaches them to one album post',async()=>{
  const calls=[];
  const client=metaClient({graphVersion:'v25.0',pageId:'100',appId:'200'},{META_PAGE_ACCESS_TOKEN:'messenger-token',META_PAGE_PUBLISH_ACCESS_TOKEN:'publish-token',META_APP_SECRET:'app-secret'},async(url,opts={})=>{
    calls.push({url:String(url),opts});
    assert.equal(opts.headers?.Authorization,'Bearer publish-token');
    if(String(url).endsWith('/100/photos')) {
      assert.equal(opts.body.get('published'),'false');
      return {ok:true,json:async()=>({id:`photo_${calls.length}`})};
    }
    if(String(url).endsWith('/100/feed')) return {ok:true,json:async()=>({id:'100_album'})};
    throw new Error('unexpected '+url);
  });
  const id=await client.publishMultiPhotoPost({caption:'Gà nguyên con',images:[
    {imageUrl:'https://example.test/images/ga-1.jpg'},
    {imageUrl:'https://example.test/images/ga-2.jpg'},
    {imageUrl:'https://example.test/images/ga-3.jpg'}
  ]});
  assert.equal(id,'100_album');
  assert.equal(calls.length,4);
  const feed=JSON.parse(calls[3].opts.body);
  assert.equal(feed.message,'Gà nguyên con');
  assert.deepEqual(feed.attached_media,[{media_fbid:'photo_1'},{media_fbid:'photo_2'},{media_fbid:'photo_3'}]);
  assert.equal(feed.published,undefined);
  await assert.rejects(()=>client.publishMultiPhotoPost({caption:'x',images:[{imageUrl:'https://example.test/one.jpg'}]}),/at least 2 images/);
});

test('ảnh mà tài liệu KB gán cho mặt hàng được xếp trước ảnh khớp từ khoá',t=>{
  const {c}=fixture(t);
  writeFileSync(c.imageCatalogFile,JSON.stringify({schemaVersion:1,images:[
    {id:'ga-1',title:'Gà 1',keywords:['gà nguyên con'],file:'ga-1.jpg',caption:'Gà 1',approved:true},
    {id:'gau-bo-1',title:'Gấu bò 1',keywords:['gấu bò'],file:'gau-bo-1.jpg',caption:'Gấu bò 1',approved:true},
    {id:'gau-bo-2',title:'Gấu bò 2',keywords:['gấu bò'],file:'gau-bo-2.jpg',caption:'Gấu bò 2',approved:true}
  ]}));
  const docs=[{id:'product-gau-bo',title:'Gấu bò',keywords:['gấu bò'],content:'Tên sản phẩm: Gấu bò\nẢnh: gau-bo-2, gau-bo-1'}];
  const list=selectPostImages(c,{query:'bài hôm nay viết về mặt hàng mới trong kho',docs,limit:3});
  assert.equal(list[0].id,'gau-bo-2');
  assert.equal(list[1].id,'gau-bo-1');
  assert.ok(list.length>=2);
});

test('id ảnh ngoài danh sách bị loại kèm cờ, bài vẫn tạo được với ảnh đúng chủ đề',async t=>{
  const {c,s}=fixture(t,'live');
  writeFileSync(c.imageCatalogFile,JSON.stringify({schemaVersion:1,images:[
    {id:'ga-1',title:'Gà 1',keywords:['gà nguyên con'],file:'ga-1.jpg',caption:'Gà 1',approved:true},
    {id:'ga-2',title:'Gà 2',keywords:['gà nguyên con'],file:'ga-2.jpg',caption:'Gà 2',approved:true},
    {id:'ga-3',title:'Gà 3',keywords:['gà nguyên con'],file:'ga-3.jpg',caption:'Gà 3',approved:true},
    {id:'salmon-photo',title:'Ảnh cá hồi',keywords:['cá hồi'],file:'salmon.jpg',caption:'Ảnh cá hồi',approved:true}
  ]}));
  const complete=async()=>JSON.stringify({title_internal:'Gà nguyên con',caption:'🐔 GÀ NGUYÊN CON NHẬP KHẨU\n\n🔥 Gà nguyên con không đầu, thùng 15kg.\n\n✔ Bán buôn theo thùng\n\n💬 Inbox để được tư vấn',hashtags:['ga nguyen con'],cta:'Inbox',media:[{type:'image',image_id:'gau-bo-1'}],source_ids:['product-salmon'],risk_flags:[]});
  const marketing=createMarketing(c,s,complete,{});
  const post=await marketing.createDraft({prompt:'gà nguyên con'});
  const media=JSON.parse(post.media), flags=JSON.parse(post.risk_flags);
  assert.equal(media.some(m=>m.image_id==='gau-bo-1'),false);
  assert.ok(flags.includes('image_id_not_in_shortlist'));
  assert.ok(media.length>=3);
  assert.ok(media.every(m=>m.image_id.startsWith('ga-')));
});

test('bộ chọn chủ đề thấy mọi sản phẩm KB, kể cả sản phẩm/ảnh thêm sau',async t=>{
  const {c,s}=fixture(t,'live');
  const docs=[];
  for(let i=1;i<=45;i++) docs.push({id:`product-p${String(i).padStart(2,'0')}`,title:`Sản phẩm ${i}`,keywords:[`sp${i}`],content:`Tên sản phẩm: Sản phẩm ${i}\nNhóm: test\nẢnh: anh-sp${i}-1`,approved:true,validUntil:null});
  writeFileSync(c.knowledgeFile,JSON.stringify({schemaVersion:1,documents:docs}));
  const images=[];
  for(let i=1;i<=60;i++) images.push({id:`img-${i}`,title:`Ảnh ${i}`,keywords:[`sp${i}`],file:`img-${i}.jpg`,caption:'',approved:true});
  // Ảnh của sản phẩm cuối nằm ngoài 50 ảnh đầu: bộ chọn chủ đề vẫn phải thấy.
  images.push({id:'anh-sp45-1',title:'Ảnh sản phẩm 45',keywords:['sp45'],file:'anh-sp45-1.jpg',caption:'',approved:true});
  writeFileSync(c.imageCatalogFile,JSON.stringify({schemaVersion:1,images}));
  const calls=[];
  const complete=async ({message})=>{
    calls.push(message);
    if(calls.length===1) return JSON.stringify({topic:'Sản phẩm 45',prompt:'Viết bài sản phẩm 45',source_ids:['product-p45'],reason:'có ảnh'});
    return JSON.stringify({title_internal:'Sản phẩm 45',caption:'🔥 Sản phẩm 45 phù hợp nhà hàng, quán ăn, bếp ăn.\n\n💬 Inbox để được tư vấn.',hashtags:['tmfood'],cta:'Inbox để được tư vấn',media:[],source_ids:['product-p45'],risk_flags:[]});
  };
  const post=await createMarketing(c,s,complete,{listPublishedPosts:async()=>[]}).createAutoDraft({instruction:'test'});
  assert.match(calls[0],/"id":"product-p45"/);
  assert.match(calls[0],/"id":"product-p45"[^}]*"hasImage":true/);
  assert.match(post.topic,/Sản phẩm 45/);
});

test('trần tài liệu 80: sản phẩm thứ 60 vẫn vào được prompt chọn chủ đề và prompt viết bài',async t=>{
  const {c,s}=fixture(t,'live');
  const docs=[];
  for(let i=1;i<=60;i++) docs.push({id:`product-p${String(i).padStart(2,'0')}`,title:`Sản phẩm ${i}`,keywords:[`sp${i}`],content:`Tên sản phẩm: Sản phẩm ${i}\nNhóm: test\nẢnh: anh-sp${i}-1`,approved:true,validUntil:null});
  docs.push({id:'category-test',title:'Nhóm test',keywords:['test'],content:'Nhóm test.',approved:true,validUntil:null});
  writeFileSync(c.knowledgeFile,JSON.stringify({schemaVersion:1,documents:docs}));
  writeFileSync(c.imageCatalogFile,JSON.stringify({schemaVersion:1,images:[{id:'anh-sp60-1',title:'Ảnh sản phẩm 60',keywords:['sp60'],file:'anh-sp60-1.jpg',caption:'',approved:true}]}));
  const calls=[];
  const complete=async ({message})=>{
    calls.push(message);
    if(calls.length===1) return JSON.stringify({topic:'Sản phẩm 60',prompt:'Viết bài sản phẩm 60',source_ids:['product-p60'],reason:'có ảnh'});
    return JSON.stringify({title_internal:'Sản phẩm 60',caption:'🔥 Sản phẩm 60 phù hợp nhà hàng, quán ăn, bếp ăn.\n\n💬 Inbox để được tư vấn.',hashtags:['tmfood'],cta:'Inbox để được tư vấn',media:[],source_ids:['product-p60'],risk_flags:[]});
  };
  const post=await createMarketing(c,s,complete,{listPublishedPosts:async()=>[]}).createAutoDraft({instruction:'test'});
  assert.match(calls[0],/"id":"product-p60"/);
  assert.match(calls[1],/"id":"product-p60"/);
  assert.ok(calls[1].length<40000, 'prompt viết bài phải nằm trong ngân sách ký tự');
  assert.match(post.topic,/Sản phẩm 60/);
});

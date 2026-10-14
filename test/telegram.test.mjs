import test from 'node:test';
import assert from 'node:assert/strict';
import { telegramNotifier,formatHandoffMessage,formatOrderMessage,formatMarketingPreviewMessage,handleTelegramMarketingUpdate,scoreMarketingSeo } from '../src/telegram.mjs';

function config(overrides={}) {
  return {pageName:'TM Food',orderTelegramChatIds:['111','222'],adminTelegramAllowedUsers:['999'],...overrides};
}
function spy() {
  const calls=[];
  const fetcher=async (url,opts)=>{calls.push({url,body:JSON.parse(opts.body)});return {ok:true,json:async()=>({ok:true})};};
  return {calls,fetcher};
}

test('handoff alert reaches every configured chat id',async()=>{
  const {calls,fetcher}=spy();
  const n=telegramNotifier(config(),{TELEGRAM_BOT_TOKEN:'tkn'},fetcher);
  const sent=await n.notifyHandoff({psid:'123',reason:'missing_safety_data',customerName:'Nam',phone:'0912345678',messages:['chân gà có ngâm hóa chất k']});
  assert.equal(sent,2);
  assert.deepEqual(calls.map(x=>x.body.chat_id),['111','222']);
  assert.match(calls[0].url,/^https:\/\/api\.telegram\.org\/bottkn\/sendMessage$/);
  assert.equal(calls[0].body.disable_web_page_preview,true);
  assert.match(calls[0].body.text,/Cần tư vấn viên hỗ trợ/);
  assert.match(calls[0].body.text,/Nam/);
  assert.match(calls[0].body.text,/missing_safety_data/);
  assert.match(calls[0].body.text,/chân gà có ngâm hóa chất k/);
  assert.match(calls[0].body.text,/PSID: 123/);
});

test('handoff alert stays off without a token or chat ids',async()=>{
  const {calls,fetcher}=spy();
  const noToken=telegramNotifier(config(),{},fetcher);
  const noChats=telegramNotifier(config({orderTelegramChatIds:[]}),{TELEGRAM_BOT_TOKEN:'tkn'},fetcher);
  assert.equal(noToken.enabled,false);
  assert.equal(noChats.enabled,false);
  assert.equal(await noToken.notifyHandoff({psid:'1',reason:'x'}),0);
  assert.equal(await noChats.notifyHandoff({psid:'1',reason:'x'}),0);
  assert.equal(calls.length,0);
});

test('marketing preview uses the admin bot and survives one unreachable chat',async()=>{
  const calls=[];
  const fetcher=async(url,opts)=>{
    const body=JSON.parse(opts.body);
    calls.push({url,body});
    if(body.chat_id==='999') return {ok:true,json:async()=>({ok:true})};
    return {ok:false,status:400,json:async()=>({ok:false,description:'chat not found'})};
  };
  const n=telegramNotifier(config({adminTelegramAllowedUsers:['999','888']}),{TELEGRAM_BOT_TOKEN:'svc',PAGE_CSKH_ADMIN_TELEGRAM_BOT_TOKEN:'adm'},fetcher);
  const sent=await n.notifyMarketingPreview({id:'p1',caption:'Cá hồi Na Uy cho nhà hàng ở Thái Bình. Inbox TM Food.',hashtags:['#TMFood'],media:[]});
  assert.equal(sent,1);
  assert.equal(calls.length,2);
  assert.ok(calls.every(c=>/\/botadm\//.test(c.url)));
  assert.equal(calls[1].body.reply_markup.inline_keyboard[0][0].callback_data,'mk:approve:p1');
});

test('a rejected chat id surfaces instead of dropping the alert silently',async()=>{
  const fetcher=async()=>({ok:false,status:400});
  const n=telegramNotifier(config({orderTelegramChatIds:['111']}),{TELEGRAM_BOT_TOKEN:'tkn'},fetcher);
  await assert.rejects(()=>n.notifyHandoff({psid:'1',reason:'r'}),/Telegram sendMessage failed/);
});

test('handoff message falls back to placeholder text for unknown fields',()=>{
  const text=formatHandoffMessage(config(),{psid:'9',reason:'',messages:[]});
  assert.match(text,/Chưa rõ tên/);
  assert.match(text,/Chưa rõ/);
  assert.match(text,/https:\/\/www\.facebook\.com\/messages\/t\/9/);
});

test('order message format is unchanged by the shared broadcast helper',()=>{
  const text=formatOrderMessage(config(),{psid:'9',customer_name:'Nam',customer_type:'store',phone:'0912',address:'12 Láng Hạ',products:['2kg ba chỉ bò']});
  assert.match(text,/Đơn hàng mới - TM Food/);
  assert.match(text,/Cửa hàng\/đại lý\/quán/);
  assert.match(text,/- 2kg ba chỉ bò/);
});

test('preview parses hashtags/media stored as JSON strings from SQLite rows',async()=>{
  const caption='Cá hồi Na Uy cắt khúc cho bữa tối gia đình ở Thái Bình. Inbox TM Food để em tư vấn loại phù hợp cho nhà hàng, quán ăn.';
  const row={id:'p9',status:'pending_approval',caption,hashtags:'["#TMFood","#CaHoi","#ThaiBinh"]',media:''};
  const text=formatMarketingPreviewMessage(config(),row);
  assert.match(text,/Hashtag \(gắn vào cuối bài khi đăng\): #TMFood #CaHoi #ThaiBinh/);
  assert.doesNotMatch(text,/Hashtag: CHƯA CÓ/);
  assert.doesNotMatch(text,/Hashtag nên có 3-6 tag/);
  const parsed=scoreMarketingSeo({...row,hashtags:JSON.parse(row.hashtags),media:[]});
  assert.equal(scoreMarketingSeo({...row,hashtags:JSON.parse(row.hashtags),media:[]}).score,parsed.score);
  const mediaRow={...row,id:'p10',media:'[{"type":"image","image_id":"salmon-1"}]'};
  assert.match(formatMarketingPreviewMessage(config(),mediaRow),/Ảnh: salmon-1/);
});

test('marketing preview includes score, edit instruction, and approval menu',async()=>{
  const post={id:'p1',status:'pending_approval',caption:'Cá hồi Na Uy, Chile, Úc phù hợp áp chảo, nướng, salad. Inbox TM Food để em tư vấn loại phù hợp cho gia đình, nhà hàng hoặc quán ăn tại Thái Bình nhé.',hashtags:['#TMFood','#CaHoi','#ThucPhamDongLanh'],media:[]};
  const seo=scoreMarketingSeo(post);
  assert.equal(seo.score,6);
  assert.match(seo.notes.join(';'),/Chưa có ảnh/);
  const withImage=scoreMarketingSeo({...post,media:[{type:'image',image_id:'salmon-1'}]});
  assert.equal(withImage.score,10);
  const text=formatMarketingPreviewMessage(config(),post);
  assert.match(text,/SEO\/social score:/);
  assert.match(text,/\/editpost p1/);
  const {calls,fetcher}=spy();
  const n=telegramNotifier(config(),{TELEGRAM_BOT_TOKEN:'tkn'},fetcher);
  assert.equal(await n.notifyMarketingPreview(post),1);
  assert.equal(calls[0].body.chat_id,'999');
  assert.equal(calls[0].body.reply_markup.inline_keyboard[0][0].text,'Duyệt');
});

test('telegram marketing update approves and edits posts for allowed admin only',async()=>{
  const actions=[];
  const store={
    marketingPost:(id)=>({id,status:'pending_approval',caption:'Cá hồi Na Uy cho bữa gia đình tại Thái Bình.',hashtags:'["#TMFood"]',media:'[]'}),
    approveMarketingPost:(id,by)=>{actions.push(['approve',id,by]);return {id,status:'approved'};},
    updateMarketingPost:(id,patch)=>{actions.push(['edit',id,patch.caption]);return {id,status:'pending_approval',caption:patch.caption,hashtags:[],media:[]};}
  };
  const {calls,fetcher}=spy();
  assert.deepEqual(await handleTelegramMarketingUpdate(config(),{TELEGRAM_BOT_TOKEN:'tkn'},store,{},{callback_query:{id:'cb1',from:{id:999},message:{chat:{id:'999'},message_id:11},data:'mk:approve:p1'}},fetcher),{ok:true,action:'approve'});
  assert.deepEqual(actions[0],['approve','p1','999']);
  assert.equal(calls[0].url.endsWith('/answerCallbackQuery'),true);
  const confirm=calls.find(c=>c.url.endsWith('/sendMessage'));
  assert.match(confirm.body.text,/Đã duyệt nháp p1/);
  assert.match(confirm.body.text,/Trạng thái: approved/);
  const markup=calls.find(c=>c.url.endsWith('/editMessageReplyMarkup'));
  assert.deepEqual(markup.body.reply_markup.inline_keyboard.flat().map(b=>b.text),['Đăng ngay','Hủy']);
  const edited=await handleTelegramMarketingUpdate(config(),{TELEGRAM_BOT_TOKEN:'tkn'},store,{},{message:{from:{id:999},chat:{id:'999'},text:'/editpost p1 Nội dung mới đủ dài để được hệ thống chấp nhận và gửi lại preview.'}},fetcher);
  assert.equal(edited.action,'edit');
  assert.deepEqual(actions[1],['edit','p1','Nội dung mới đủ dài để được hệ thống chấp nhận và gửi lại preview.']);
  assert.equal(calls.at(-1).url.endsWith('/sendMessage'),true);
  assert.equal((await handleTelegramMarketingUpdate(config(),{TELEGRAM_BOT_TOKEN:'tkn'},store,{},{callback_query:{id:'cb2',from:{id:123},data:'mk:approve:p1'}},fetcher)).reason,'forbidden');
});

test('publish button warns when the draft is not approved yet',async()=>{
  let published=0;
  const store={marketingPost:(id)=>({id,status:'pending_approval',caption:'Cá hồi Na Uy cho nhà hàng ở Thái Bình.',hashtags:'[]',media:'[]'})};
  const {calls,fetcher}=spy();
  const res=await handleTelegramMarketingUpdate(config(),{TELEGRAM_BOT_TOKEN:'tkn'},store,{publishNow:async()=>{published++;}},{callback_query:{id:'cb4',from:{id:999},message:{chat:{id:'999'},message_id:12},data:'mk:publish:p2'}},fetcher);
  assert.deepEqual(res,{ok:true,action:'publish'});
  assert.equal(published,0);
  const msg=calls.find(c=>c.url.endsWith('/sendMessage'));
  assert.match(msg.body.text,/đang ở trạng thái pending_approval, chưa duyệt nên em không đăng/);
});

test('publish button reports success with permalink and failure with the reason',async()=>{
  const row={id:'p3',status:'approved',approved_at:123,caption:'Cá hồi Na Uy cho nhà hàng ở Thái Bình.',hashtags:'[]',media:'[]'};
  const store={marketingPost:()=>({...row,facebook_post_id:'100_200',permalink_url:'https://www.facebook.com/1/posts/2'})};
  const {calls,fetcher}=spy();
  await handleTelegramMarketingUpdate(config(),{TELEGRAM_BOT_TOKEN:'tkn'},store,{publishNow:async()=>{}},{callback_query:{id:'cb5',from:{id:999},message:{chat:{id:'999'},message_id:13},data:'mk:publish:p3'}},fetcher);
  const ok=calls.find(c=>c.url.endsWith('/sendMessage'));
  assert.match(ok.body.text,/Đã đăng lên Facebook Page \(100_200\)/);
  assert.match(ok.body.text,/https:\/\/www\.facebook\.com\/1\/posts\/2/);

  const failCalls=[];
  const failFetcher=async(url,opts)=>{failCalls.push({url,body:JSON.parse(opts.body)});return {ok:true,json:async()=>({ok:true})};};
  const res=await handleTelegramMarketingUpdate(config(),{TELEGRAM_BOT_TOKEN:'tkn'},store,{publishNow:async()=>{throw new Error('Meta 400: quiet hours');}},{callback_query:{id:'cb6',from:{id:999},message:{chat:{id:'999'},message_id:14},data:'mk:publish:p3'}},failFetcher);
  assert.deepEqual(res,{ok:true,action:'publish'});
  const failMsg=failCalls.find(c=>c.url.endsWith('/sendMessage'));
  assert.match(failMsg.body.text,/Đăng không thành công: Meta 400: quiet hours/);
  assert.equal(failMsg.body.reply_markup.inline_keyboard.flat().some(b=>b.text==='Đăng ngay'),true);
});

test('a button for a deleted draft answers with a warning instead of silence',async()=>{
  const store={marketingPost:()=>null};
  const {calls,fetcher}=spy();
  const res=await handleTelegramMarketingUpdate(config(),{TELEGRAM_BOT_TOKEN:'tkn'},store,{},{callback_query:{id:'cb7',from:{id:999},message:{chat:{id:'999'},message_id:15},data:'mk:approve:gone'}},fetcher);
  assert.deepEqual(res,{ok:true,action:'approve'});
  assert.match(calls.find(c=>c.url.endsWith('/sendMessage')).body.text,/Không tìm thấy nháp gone/);
  assert.deepEqual(await handleTelegramMarketingUpdate(config(),{TELEGRAM_BOT_TOKEN:'tkn'},store,{},{callback_query:{id:'cb8',from:{id:999},data:'mk:frobnicate:p1'}},fetcher),{ok:true,action:'frobnicate'});
});

test('edit button sends a copyable instruction with the current caption',async()=>{
  const store={
    marketingPost:(id)=>({id,status:'pending_approval',caption:'Cá hồi Na Uy cho bữa gia đình tại Thái Bình.',hashtags:[],media:[]})
  };
  const {calls,fetcher}=spy();
  const res=await handleTelegramMarketingUpdate(config(),{TELEGRAM_BOT_TOKEN:'tkn'},store,{},{callback_query:{id:'cb9',from:{id:999},message:{chat:{id:'999'}},data:'mk:edit:p1'}},fetcher);
  assert.deepEqual(res,{ok:true,action:'edit'});
  const sent=calls.find(c=>c.url.endsWith('/sendMessage'));
  assert.match(sent.body.text,/\/editpost p1 nội dung mới/);
  assert.match(sent.body.text,/Cá hồi Na Uy cho bữa gia đình tại Thái Bình\./);
});

test('hook is judged on the first sentence, not the first whole line',async()=>{
  const caption='Cá hồi Na Uy, Chile, Úc đang là lựa chọn của nhiều quán ăn, nhà hàng và gia đình tại Thái Bình. Cá hồi phù hợp chế biến cho nhà hàng, tiệc và sự kiện. Inbox TM Food để được tư vấn loại phù hợp.';
  const seo=scoreMarketingSeo({caption,hashtags:['#a','#b','#c'],media:[{type:'image',image_id:'salmon'}]});
  assert.equal(seo.notes.some(n=>/Câu mở đầu/.test(n)),false);
  const generic=scoreMarketingSeo({caption:'Nâng tầm bữa ăn gia đình cùng thực phẩm sạch. Inbox nhé.',hashtags:['#a','#b','#c'],media:[{type:'image',image_id:'x'}]});
  assert.equal(generic.notes.some(n=>/Câu mở đầu/.test(n)),true);
});

test('a failed callback toast does not fail the approval itself',async()=>{
  let approved=null;
  const store={
    marketingPost:(id)=>({id,status:'pending_approval',caption:'Cá hồi Na Uy cho nhà hàng ở Thái Bình.',hashtags:'[]',media:'[]'}),
    approveMarketingPost:(id,by)=>{approved=[id,by];return {id,status:'approved'};}
  };
  const fetcher=async (url)=>({ok:url.endsWith('/answerCallbackQuery')?false:true,json:async()=>({ok:true})});
  const res=await handleTelegramMarketingUpdate(config(),{TELEGRAM_BOT_TOKEN:'tkn'},store,{},{callback_query:{id:'cb3',from:{id:999},data:'mk:approve:p7'}},fetcher);
  assert.deepEqual(res,{ok:true,action:'approve'});
  assert.deepEqual(approved,['p7','999']);
});

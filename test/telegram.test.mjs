import test from 'node:test';
import assert from 'node:assert/strict';
import { telegramNotifier,formatHandoffMessage,formatOrderMessage } from '../src/telegram.mjs';

function config(overrides={}) {
  return {pageName:'TM Food',orderTelegramChatIds:['111','222'],...overrides};
}
function spy() {
  const calls=[];
  const fetcher=async (url,opts)=>{calls.push({url,body:JSON.parse(opts.body)});return {ok:true};};
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

test('a rejected chat id surfaces instead of dropping the alert silently',async()=>{
  const fetcher=async()=>({ok:false,status:400});
  const n=telegramNotifier(config({orderTelegramChatIds:['111']}),{TELEGRAM_BOT_TOKEN:'tkn'},fetcher);
  await assert.rejects(()=>n.notifyHandoff({psid:'1',reason:'r'}),/Telegram notify failed for chat 111/);
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

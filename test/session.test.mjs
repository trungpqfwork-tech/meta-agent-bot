import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.mjs';
import { applyEnvOverrides,loadConfig,runtimeConfigFromEnv } from '../src/config.mjs';

const TTL=6*3600;                       // 6 giờ, đúng giá trị trong .env production
const HOUR=3600*1000;

function fixture(t,{ttl=TTL}={}) {
  const dir=mkdtempSync(join(tmpdir(),'page-cskh-session-'));
  const c={...JSON.parse(readFileSync(new URL('../config.example.json',import.meta.url))),pageId:'100',appId:'200',model:'provider/model',mode:'draft',
    workspace:join(dir,'agent'),envFile:join(dir,'.env'),database:join(dir,'data/state.sqlite'),knowledgeFile:join(dir,'knowledge.json'),
    messageDebounceSeconds:0,sessionTtlSeconds:ttl};
  mkdirSync(c.workspace);
  writeFileSync(c.envFile,'META_PAGE_ACCESS_TOKEN=placeholder\n',{mode:0o600});
  const s=new Store(c.database,c.pageId,{sessionTtlSeconds:ttl});
  t.after(()=>s.close());
  return {c,s,dir};
}
const inbound=(psid,id,text,at)=>({psid,id,kind:'customer',text,at});
const sessionsOf=(s,psid)=>s.db.prepare('SELECT id,session_id FROM events WHERE psid=? ORDER BY at').all(psid);

test('tin khách cách nhau dưới TTL ở cùng một phiên',t=>{
  const {s,c}=fixture(t);
  const base=1700000000000;
  s.ingest([inbound('111','a','Cho anh giá cá hồi',base)],c);
  s.ingest([inbound('111','b','Gia đình đi',base+5*60*1000)],c);
  const session=s.session('111');
  assert.ok(session.sessionId,'phiên phải có id');
  assert.equal(session.sessionStarted,base);
  assert.equal(new Set(sessionsOf(s,'111').map(e=>e.session_id)).size,1,'hai tin gần nhau phải chung một phiên');
});

test('tin khách cách nhau quá TTL mở phiên mới, xoá topic, đánh dấu cần nén',t=>{
  const {s,c}=fixture(t);
  const base=1700000000000;
  const next=base+TTL*1000+60*1000;
  s.ingest([inbound('111','a','Cho anh giá cá hồi',base)],c);
  s.saveTopic('111',{san_pham:['Cá hồi'],y_dinh:'hỏi giá'},base);
  s.ingest([inbound('111','b','chào b',next)],c);
  const session=s.session('111');
  assert.equal(session.sessionId,`111|${next}`,'phiên phải mới');
  assert.equal(session.topic,null,'topic của phiên cũ phải bị xoá');
  assert.equal(session.summaryPending,true,'phiên cũ phải được xếp hàng chờ nén');
  assert.equal(new Set(sessionsOf(s,'111').map(e=>e.session_id)).size,2);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM events').get().n,2,'không được mất event nào');
  assert.equal(s.summaryQueue().length,1);
});

test('TTL=0 giữ một phiên duy nhất như hành vi cũ',t=>{
  const {s,c}=fixture(t,{ttl:0});
  const base=1700000000000;
  s.ingest([inbound('111','a','tin 1',base)],c);
  s.ingest([inbound('111','b','tin 2',base+30*24*HOUR)],c);
  assert.equal(new Set(sessionsOf(s,'111').map(e=>e.session_id)).size,1);
});

test('historyInSession chỉ trả tin trong phiên hiện tại, transcript vẫn đủ',t=>{
  const {s,c}=fixture(t);
  const base=1700000000000;
  s.ingest([inbound('111','a','Cho anh giá cá hồi',base)],c);
  s.ingest([inbound('111','b','Gia đình đi',base+60*1000)],c);
  assert.equal(s.historyInSession('111').length,2);
  s.ingest([inbound('111','c','chào b',base+TTL*1000+120*1000)],c);
  assert.deepEqual(s.historyInSession('111').map(e=>e.text),['chào b'],'phiên mới chỉ có tin mới');
  assert.equal(s.history('111').length,3,'transcript đầy đủ vẫn còn nguyên');
});

test('backfill chia phiên cho event cũ mà không mất dòng nào',t=>{
  const {c,dir}=fixture(t);
  const base=1700000000000;
  const second=base+TTL*1000+120*1000;
  // DB "cũ": bảng events chưa có cột session_id, đúng trạng thái trước khi nâng cấp
  const legacy=join(dir,'legacy/state.sqlite');
  mkdirSync(join(dir,'legacy'),{recursive:true});
  const raw=new DatabaseSync(legacy);
  raw.exec("CREATE TABLE conversations(psid TEXT PRIMARY KEY,state TEXT NOT NULL DEFAULT 'BOT',version INTEGER NOT NULL DEFAULT 0,last_customer INTEGER NOT NULL DEFAULT 0,reason TEXT NOT NULL DEFAULT '');");
  raw.exec('CREATE TABLE events(id TEXT PRIMARY KEY,psid TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,at INTEGER NOT NULL);');
  raw.prepare('INSERT INTO conversations(psid,last_customer) VALUES (?,?)').run('111',second+180*1000);
  const rows=[[base,'Cho anh giá cá hồi'],[base+60000,'Gia đình đi'],[second,'chào b'],[second+180*1000,'t muốn mua thịt heo']];
  for(const [i,[at,text]] of rows.entries()) raw.prepare('INSERT INTO events VALUES (?,?,?,?,?)').run(`111:c${i}`,'111','customer',text,at);
  raw.close();
  const s=new Store(legacy,'100',{sessionTtlSeconds:TTL});
  t.after(()=>s.close());
  const events=sessionsOf(s,'111');
  assert.equal(events.length,4,'không mất dòng nào');
  assert.equal(new Set(events.map(e=>e.session_id)).size,2,'2 phiên theo khoảng cách TTL');
  assert.equal(s.session('111').sessionId,`111|${second}`,'phiên hiện tại là phiên mới nhất');
  assert.equal(s.summaryQueue().length,1,'DB cũ nhiều phiên phải được xếp hàng chờ nén');
  assert.equal(s.backfillSessions(),0,'backfill phải idempotent');
});

test('PAGE_CSKH_SESSION_TTL_SECONDS đọc được và chặn giá trị sai',t=>{
  const {c}=fixture(t);
  assert.equal(c.sessionTtlSeconds,TTL);
  assert.equal(applyEnvOverrides(c,{PAGE_CSKH_SESSION_TTL_SECONDS:'21600'}).sessionTtlSeconds,21600);
  assert.throws(()=>applyEnvOverrides(c,{PAGE_CSKH_SESSION_TTL_SECONDS:'6h'}),/must be an integer/);
  assert.throws(()=>applyEnvOverrides(c,{PAGE_CSKH_SESSION_TTL_SECONDS:'99999999'}),/0\.\.604800/);
  const runtime=runtimeConfigFromEnv({PAGE_CSKH_PAGE_ID:'1',PAGE_CSKH_APP_ID:'2',PAGE_CSKH_PAGE_NAME:'P',PAGE_CSKH_MODEL:'m',PAGE_CSKH_PUBLIC_WEBHOOK_URL:'https://x.test/webhooks/page-cskh'});
  assert.equal(runtime.sessionTtlSeconds,21600,'mặc định 6 giờ');
});

test('summary lưu được và gỡ khỏi hàng đợi nén',t=>{
  const {s,c}=fixture(t);
  const base=1700000000000;
  s.ingest([inbound('111','a','tin 1',base)],c);
  s.ingest([inbound('111','b','tin 2',base+TTL*1000+60*1000)],c);
  assert.equal(s.summaryQueue().length,1);
  s.saveSummary('111','Phiên trước: khách hỏi giá cá hồi cho gia đình, đã báo 250.000đ/kg.',base+TTL*1000+120*1000);
  assert.equal(s.summaryQueue().length,0);
  assert.match(s.session('111').summary,/250\.000đ\/kg/);
});

test('loadConfig nhận sessionTtlSeconds và từ chối giá trị ngoài 0..604800',t=>{
  const {c,dir}=fixture(t);
  const file=join(dir,'config.json');
  writeFileSync(file,JSON.stringify(c));
  assert.equal(loadConfig(file).sessionTtlSeconds,TTL);
  writeFileSync(file,JSON.stringify({...c,sessionTtlSeconds:-1}));
  assert.throws(()=>loadConfig(file),/Invalid sessionTtlSeconds/);
});

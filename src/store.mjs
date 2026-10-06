import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { assert } from './config.mjs';

export class Store {
  constructor(file, pageId, { sessionTtlSeconds = 21600 } = {}) {
    this.pageId = pageId;
    this.sessionTtlSeconds = Number.isInteger(sessionTtlSeconds) && sessionTtlSeconds >= 0 ? sessionTtlSeconds : 21600;
    this.lock = `${file}.lock`;
    mkdirSync(dirname(file), {recursive:true,mode:0o700});
    try { writeFileSync(this.lock, String(process.pid), {flag:'wx',mode:0o600}); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(readFileSync(this.lock,'utf8'));
      assert(Number.isInteger(pid) && pid > 0, 'Invalid DB lock; inspect manually');
      let alive = true;
      try { process.kill(pid,0); } catch (x) { if (x.code === 'ESRCH') alive = false; }
      assert(!alive, 'Database already owned by another runtime');
      unlinkSync(this.lock); writeFileSync(this.lock, String(process.pid), {flag:'wx',mode:0o600});
    }
    try {
      this.db = new DatabaseSync(file); chmodSync(file,0o600);
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS conversations(psid TEXT PRIMARY KEY,state TEXT NOT NULL DEFAULT 'BOT',version INTEGER NOT NULL DEFAULT 0,last_customer INTEGER NOT NULL DEFAULT 0,reason TEXT NOT NULL DEFAULT '');
        CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,psid TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,event_id TEXT UNIQUE,psid TEXT NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,created INTEGER NOT NULL,reason TEXT NOT NULL DEFAULT '');
        CREATE TABLE IF NOT EXISTS outbox(job_id TEXT PRIMARY KEY,psid TEXT NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL,mid TEXT,source_ids TEXT NOT NULL DEFAULT '[]');
        CREATE TABLE IF NOT EXISTS orders(psid TEXT PRIMARY KEY,status TEXT NOT NULL DEFAULT 'collecting',customer_type TEXT NOT NULL DEFAULT '',customer_name TEXT NOT NULL DEFAULT '',phone TEXT NOT NULL DEFAULT '',address TEXT NOT NULL DEFAULT '',products TEXT NOT NULL DEFAULT '[]',fb_name TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',raw TEXT NOT NULL DEFAULT '{}',notified_at INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL,updated INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,psid TEXT,action TEXT NOT NULL,at INTEGER NOT NULL,detail TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY,psid TEXT NOT NULL,at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS events_conversation ON events(psid,at);
        CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status,created);`);
      const owner = this.db.prepare('SELECT value FROM meta WHERE key=?').get('pageId');
      this.ensureColumn('orders','notified_at','INTEGER NOT NULL DEFAULT 0');
      // Session segmentation + per-customer topic/summary. ADD COLUMN preserves
      // every existing row, so old customer history is never dropped.
      for (const [column, definition] of [
        ['session_id', "TEXT NOT NULL DEFAULT ''"],
        ['session_started', 'INTEGER NOT NULL DEFAULT 0'],
        ['topic', "TEXT NOT NULL DEFAULT ''"],
        ['topic_at', 'INTEGER NOT NULL DEFAULT 0'],
        ['summary', "TEXT NOT NULL DEFAULT ''"],
        ['summary_at', 'INTEGER NOT NULL DEFAULT 0'],
        ['summary_pending', 'INTEGER NOT NULL DEFAULT 0']
      ]) this.ensureColumn('conversations', column, definition);
      this.ensureColumn('events', 'session_id', "TEXT NOT NULL DEFAULT ''");
      this.ensureColumn('jobs', 'attempts', 'INTEGER NOT NULL DEFAULT 0');
      this.backfillSessions();
      assert(!owner || owner.value === pageId, 'Database belongs to another Page');
      this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run('pageId',pageId);
      this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run('schemaVersion','1');
      assert(this.db.prepare('SELECT value FROM meta WHERE key=?').get('schemaVersion').value === '1', 'Unsupported DB schema');
      // Never replay model calls or sends whose completion was interrupted.
      for (const j of this.db.prepare("SELECT * FROM jobs WHERE status IN ('processing','sending')").all()) {
        this.hold(j.psid,'WAITING','runtime_interrupted');
        this.finish(j.id,'interrupted','Inspect history before resuming');
      }
      this.db.exec("UPDATE outbox SET status='unknown' WHERE status='sending'");
    } catch(e) { this.db?.close(); unlinkSync(this.lock); throw e; }
  }
  // A customer message that lands more than sessionTtlSeconds after the previous
  // one starts a new session: the topic is cleared and the finished session is
  // queued for summarisation so nothing is forgotten, it is only compacted.
  sessionForIncoming(previous,event,kind) {
    const current=previous?.session_id || '';
    if(kind!=='customer') return current;
    const ttlMs=Math.max(0,Math.trunc(this.sessionTtlSeconds))*1000;
    const lastCustomer=Number(previous?.last_customer ?? 0);
    const rollover=!current || (ttlMs>0 && lastCustomer>0 && event.at-lastCustomer>ttlMs);
    if(!rollover) return current;
    const sessionId=`${event.psid}|${event.at}`;
    this.db.prepare("UPDATE conversations SET session_id=?,session_started=?,topic='',topic_at=0,summary_pending=? WHERE psid=?")
      .run(sessionId,event.at,current?1:0,event.psid);
    if(current) this.audit(event.psid,'session_closed',`session_ttl:${this.sessionTtlSeconds}s`);
    return sessionId;
  }
  // Legacy rows have no session_id; assign them by the same TTL rule so old
  // conversations can be split without losing a single event.
  backfillSessions() {
    const missing=this.db.prepare("SELECT COUNT(*) AS n FROM events WHERE session_id=''").get().n;
    if(!missing) return 0;
    const ttlMs=Math.max(0,Math.trunc(this.sessionTtlSeconds))*1000;
    let assigned=0;
    this.tx(()=> {
      for(const {psid} of this.db.prepare("SELECT DISTINCT psid FROM events WHERE session_id=''").all()) {
        const rows=this.db.prepare("SELECT id,at FROM events WHERE psid=? ORDER BY at,rowid").all(psid);
        let sessionId='', started=0, previous=0;
        for(const row of rows) {
          if(!sessionId || (ttlMs>0 && previous>0 && row.at-previous>ttlMs)) { sessionId=`${psid}|${row.at}`; started=row.at; }
          previous=row.at;
          const r=this.db.prepare("UPDATE events SET session_id=? WHERE id=? AND session_id=''").run(sessionId,row.id);
          assigned+=Number(r.changes ?? 0);
        }
        if(sessionId) this.db.prepare('UPDATE conversations SET session_id=?,session_started=? WHERE psid=? AND (session_id IS NULL OR session_id=?)').run(sessionId,started,psid,'');
        // More than one session means earlier sessions exist outside the current
        // context: queue them for compaction so the history is summarised once.
        const sessions=this.db.prepare("SELECT COUNT(DISTINCT session_id) AS n FROM events WHERE psid=? AND session_id<>''").get(psid).n;
        const c=this.conversation(psid);
        if(sessions>1 && Number(c?.summary_at ?? 0) < started) this.db.prepare('UPDATE conversations SET summary_pending=1 WHERE psid=?').run(psid);
      }
      return assigned;
    });
    return assigned;
  }
  ensureColumn(table,column,definition) {
    const exists = this.db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
    if(!exists) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  tx(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const v=fn(); this.db.exec('COMMIT'); return v; } catch(e) { this.db.exec('ROLLBACK'); throw e; } }
  audit(psid,action,detail='') { this.db.prepare('INSERT INTO audit(psid,action,at,detail) VALUES (?,?,?,?)').run(psid,action,Date.now(),detail); }
  conversation(psid) { return this.db.prepare('SELECT * FROM conversations WHERE psid=?').get(psid); }
  hold(psid,state,reason) {
    this.db.prepare('UPDATE conversations SET state=?,version=version+1,reason=? WHERE psid=?').run(state,reason,psid);
    this.db.prepare("UPDATE jobs SET status='cancelled',reason=? WHERE psid=? AND status='pending'").run(reason,psid);
    this.audit(psid,state,reason);
  }
  takeover(psid) { assert(this.conversation(psid),'Unknown conversation'); this.tx(()=>this.hold(psid,'HUMAN','operator_takeover')); }
  resume(psid) {
    assert(this.conversation(psid),'Unknown conversation');
    assert(!this.db.prepare("SELECT 1 FROM outbox WHERE psid=? AND status IN ('sending','unknown')").get(psid),'Resolve ambiguous send before resuming');
    this.tx(()=>this.hold(psid,'BOT','operator_resume; old jobs not replayed'));
  }
  autoResumeExpiredWaiting(seconds) {
    if(!Number.isInteger(seconds) || seconds <= 0) return 0;
    const cutoff=Date.now()-seconds*1000;
    return this.tx(()=> {
      const rows=this.db.prepare(`
        SELECT c.psid
        FROM conversations c
        JOIN (
          SELECT psid,MAX(at) AS waiting_at
          FROM audit
          WHERE action='WAITING'
          GROUP BY psid
        ) a ON a.psid=c.psid
        WHERE c.state='WAITING' AND a.waiting_at<?
      `).all(cutoff);
      for(const r of rows) this.hold(r.psid,'BOT','auto_waiting_reset');
      return rows.length;
    });
  }
  ingest(events, config={}) {
    return this.tx(()=> {
      let accepted=0;
      const debounceMs=Math.max(0,Math.trunc(config.messageDebounceSeconds??0)*1000);
      for (const e of events) {
        const id = `${this.pageId}:${e.id}`;
        if(this.db.prepare('SELECT 1 FROM events WHERE id=?').get(id)) continue;
        this.db.prepare('INSERT OR IGNORE INTO conversations(psid) VALUES (?)').run(e.psid);
        let kind=e.kind;
        if(kind==='echo') {
          const sent=this.db.prepare('SELECT 1 FROM outbox WHERE mid=? AND psid=?').get(e.mid,e.psid);
          kind=sent ? 'bot_echo' : 'page_external';
        }
        const previous=this.conversation(e.psid);
        const sessionId=this.sessionForIncoming(previous,e,kind);
        this.db.prepare('INSERT INTO events(id,psid,kind,text,at,session_id) VALUES (?,?,?,?,?,?)').run(id,e.psid,kind,e.text,e.at,sessionId);
        if(kind==='page_external') { this.hold(e.psid,'HUMAN','external_page_message'); continue; }
        if(kind!=='customer') continue;
        this.db.prepare('UPDATE conversations SET last_customer=MAX(last_customer,?) WHERE psid=?').run(Math.min(e.at,Date.now()),e.psid);
        const c=this.conversation(e.psid);
        if(c.state!=='BOT') continue;
        let text=e.text;
        const pending=this.db.prepare("SELECT * FROM jobs WHERE psid=? AND status='pending' ORDER BY created,rowid").all(e.psid);
        if(pending.length) {
          text=[...pending.map(j=>j.text),e.text].filter(Boolean).join('\n');
          this.db.prepare("UPDATE jobs SET status='superseded',reason=? WHERE psid=? AND status='pending'").run('message_debounce_superseded',e.psid);
        }
        const job=randomUUID();
        this.db.prepare('INSERT INTO jobs(id,event_id,psid,text,status,version,created) VALUES (?,?,?,?,?,?,?)').run(job,id,e.psid,text,'pending',c.version,Date.now()+debounceMs);
        accepted++;
      }
      return accepted;
    });
  }
  next(now=Date.now()) {
    return this.tx(()=> {
      const j=this.db.prepare("SELECT * FROM jobs WHERE status='pending' AND created<=? ORDER BY created,rowid LIMIT 1").get(now);
      if(!j) return null;
      this.db.prepare("UPDATE jobs SET status='processing' WHERE id=?").run(j.id);
      return {...j,status:'processing'};
    });
  }
  allowed(j) { const c=this.conversation(j.psid); return c?.state==='BOT' && c.version===j.version; }
  hasNewerCustomerMessage(j) {
    const current=this.db.prepare('SELECT at FROM events WHERE id=? AND psid=? AND kind=?').get(j.event_id,j.psid,'customer');
    if(!current) return false;
    return !!this.db.prepare("SELECT 1 FROM events WHERE psid=? AND kind='customer' AND at>? AND id<>? LIMIT 1").get(j.psid,current.at,j.event_id);
  }
  finish(id,status,reason='') { this.db.prepare('UPDATE jobs SET status=?,reason=? WHERE id=?').run(status,reason,id); }
  // Lỗi hạ tầng (timeout / Hermes completion failed) không phải quyết định nghiệp
  // vụ: đưa job về hàng đợi kèm backoff thay vì handoff, có trần để không lặp vô hạn.
  requeue(id,delayMs=60000,reason='infra_retry',maxAttempts=2) {
    const j=this.db.prepare('SELECT id,psid,attempts FROM jobs WHERE id=?').get(id);
    if(!j) return false;
    const attempts=Number(j.attempts ?? 0)+1;
    if(attempts>maxAttempts) return false;
    this.db.prepare("UPDATE jobs SET status='pending',created=?,attempts=?,reason=? WHERE id=?")
      .run(Date.now()+Math.max(0,delayMs),attempts,reason,id);
    this.audit(j.psid,'job_requeue',`${id}:${reason}:attempt${attempts}`);
    return true;
  }
  history(psid) { return this.db.prepare("SELECT kind,text,at FROM events WHERE psid=? AND kind!='bot_echo' ORDER BY at DESC,rowid DESC LIMIT 16").all(psid).reverse(); }
  currentSessionId(psid) { return this.conversation(psid)?.session_id || ''; }
  // Only the messages of the current session go to the model verbatim; earlier
  // sessions are represented by the compaction summary instead.
  historyInSession(psid,sessionId=null,limit=16) {
    const sid=sessionId ?? this.currentSessionId(psid);
    if(!sid) return this.history(psid);
    return this.db.prepare("SELECT kind,text,at FROM events WHERE psid=? AND session_id=? AND kind!='bot_echo' ORDER BY at DESC,rowid DESC LIMIT ?").all(psid,sid,limit).reverse();
  }
  session(psid) {
    const c=this.conversation(psid);
    if(!c) return null;
    let topic=null;
    try { topic=c.topic ? JSON.parse(c.topic) : null; } catch { topic=null; }
    return {
      psid,
      sessionId:c.session_id || '',
      sessionStarted:c.session_started || 0,
      topic,
      topicAt:c.topic_at || 0,
      summary:c.summary || '',
      summaryAt:c.summary_at || 0,
      summaryPending:Boolean(c.summary_pending)
    };
  }
  saveTopic(psid,topic,at=Date.now()) {
    assert(this.conversation(psid),'Unknown conversation');
    this.db.prepare('UPDATE conversations SET topic=?,topic_at=? WHERE psid=?').run(JSON.stringify(topic??{}).slice(0,4000),at,psid);
    return this.session(psid);
  }
  saveSummary(psid,summary,upToAt=Date.now()) {
    assert(this.conversation(psid),'Unknown conversation');
    this.db.prepare('UPDATE conversations SET summary=?,summary_at=?,summary_pending=0 WHERE psid=?').run(String(summary??'').slice(0,4000),upToAt,psid);
    this.audit(psid,'summary_saved',String(upToAt));
    return this.session(psid);
  }
  summaryQueue(limit=10) {
    return this.db.prepare('SELECT psid,session_id,summary,summary_at,last_customer FROM conversations WHERE summary_pending=1 ORDER BY last_customer LIMIT ?').all(limit);
  }
  order(psid) {
    const o=this.db.prepare('SELECT * FROM orders WHERE psid=?').get(psid);
    if(!o) return null;
    let products=[];
    try { products=JSON.parse(o.products); } catch {}
    let raw={};
    try { raw=JSON.parse(o.raw); } catch {}
    return {...o,products,raw,missing:this.orderMissing(o)};
  }
  orderMissing(o) {
    const products=Array.isArray(o.products) ? o.products : (()=>{try{return JSON.parse(o.products)}catch{return []}})();
    return [
      ['customerType',o.customer_type],
      ['customerName',o.customer_name],
      ['phone',o.phone],
      ['address',o.address],
      ['products',products.length ? 'yes' : '']
    ].filter(([,v])=>!String(v??'').trim()).map(([k])=>k);
  }
  saveOrder(psid,patch={}) {
    const now=Date.now(), current=this.order(psid);
    const clean=s=>String(s??'').trim().slice(0,500);
    const customerType=['store','personal'].includes(patch.customerType) ? patch.customerType : '';
    const incomingProducts=Array.isArray(patch.products) ? patch.products.map(clean).filter(Boolean).slice(0,20) : [];
    const oldProducts=current?.products ?? [];
    const products=[...oldProducts];
    for(const p of incomingProducts) if(!products.some(x=>x.toLowerCase()===p.toLowerCase())) products.push(p);
    const merged={
      customer_type: customerType || current?.customer_type || '',
      customer_name: clean(patch.customerName) || current?.customer_name || '',
      phone: clean(patch.phone) || current?.phone || '',
      address: clean(patch.address) || current?.address || '',
      products,
      fb_name: clean(patch.fbName) || current?.fb_name || '',
      notes: [current?.notes,clean(patch.notes)].filter(Boolean).join('\n').slice(0,1000),
      raw: {...(current?.raw??{}),lastPatch:patch}
    };
    const missing=this.orderMissing({...merged,products:merged.products});
    const status=missing.length ? 'collecting' : 'ready';
    this.db.prepare(`
      INSERT INTO orders(psid,status,customer_type,customer_name,phone,address,products,fb_name,notes,raw,created,updated)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(psid) DO UPDATE SET status=excluded.status,customer_type=excluded.customer_type,customer_name=excluded.customer_name,phone=excluded.phone,address=excluded.address,products=excluded.products,fb_name=excluded.fb_name,notes=excluded.notes,raw=excluded.raw,updated=excluded.updated
    `).run(psid,status,merged.customer_type,merged.customer_name,merged.phone,merged.address,JSON.stringify(merged.products),merged.fb_name,merged.notes,JSON.stringify(merged.raw),current?.created??now,now);
    this.audit(psid,status==='ready'?'order_ready':'order_update',JSON.stringify({missing,products:merged.products}).slice(0,1000));
    return this.order(psid);
  }
  markOrderNotified(psid) {
    this.db.prepare('UPDATE orders SET notified_at=? WHERE psid=?').run(Date.now(),psid);
    this.audit(psid,'order_notified','telegram');
    return this.order(psid);
  }
  // Handoff alerts are deduplicated per job: a retried job must not ping the
  // consultant twice, while a later handoff in the same conversation still does.
  handoffNotified(jobId) {
    return Boolean(this.db.prepare("SELECT 1 FROM audit WHERE action='handoff_notified' AND detail=? LIMIT 1").get(String(jobId)));
  }
  markHandoffNotified(psid,jobId) {
    this.audit(psid,'handoff_notified',String(jobId));
  }
  reserveCall(j,c) {
    const now=Date.now(), day=now-now%86400000;
    const total=this.db.prepare('SELECT COUNT(*) AS n FROM calls WHERE at>=?').get(day).n;
    const local=this.db.prepare('SELECT COUNT(*) AS n FROM calls WHERE psid=? AND at>=?').get(j.psid,now-3600000).n;
    if(total>=c.maxDailyAgentCalls || local>=c.maxCustomerCallsPerHour) return false;
    this.db.prepare('INSERT INTO calls VALUES (?,?,?)').run(randomUUID(),j.psid,now); return true;
  }
  prepare(j,text,sources,status='ready') {
    this.db.prepare('INSERT INTO outbox(job_id,psid,text,status,source_ids) VALUES (?,?,?,?,?)').run(j.id,j.psid,text,status,JSON.stringify(sources));
  }
  sent(j,mid,text) {
    this.tx(()=> {
      this.db.prepare("UPDATE outbox SET status='sent',mid=? WHERE job_id=?").run(mid,j.id);
      this.finish(j.id,'sent');
      this.db.prepare('INSERT OR IGNORE INTO events(id,psid,kind,text,at,session_id) VALUES (?,?,?,?,?,?)').run(`${this.pageId}:sent:${mid}`,j.psid,'bot',text,Date.now(),this.currentSessionId(j.psid));
      this.audit(j.psid,'sent',j.id);
    });
  }
  reconcile(jobId,delivered) {
    const o=this.db.prepare("SELECT * FROM outbox WHERE job_id=? AND status='unknown'").get(jobId);
    assert(o,'No ambiguous send for job');
    this.db.prepare('UPDATE outbox SET status=? WHERE job_id=?').run(delivered?'confirmed_sent':'confirmed_not_sent',jobId);
    this.audit(o.psid,'operator_reconcile',`${jobId}:${delivered}`);
    if(delivered) this.db.prepare('INSERT OR IGNORE INTO events(id,psid,kind,text,at,session_id) VALUES (?,?,?,?,?,?)').run(`reconciled:${jobId}`,o.psid,'bot',o.text,Date.now(),this.currentSessionId(o.psid));
  }
  snapshot() {
    return { pageId:this.pageId, conversations:this.db.prepare('SELECT * FROM conversations ORDER BY last_customer DESC LIMIT 200').all(),
      jobs:this.db.prepare('SELECT j.*,o.text AS reply,o.status AS delivery,o.mid,o.source_ids FROM jobs j LEFT JOIN outbox o ON o.job_id=j.id ORDER BY j.created DESC LIMIT 100').all(),
      orders:this.db.prepare('SELECT * FROM orders ORDER BY updated DESC LIMIT 100').all(),
      audit:this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 100').all() };
  }
  close() { this.db.close(); unlinkSync(this.lock); }
}
export function eventHash(e) { return createHash('sha256').update(JSON.stringify(e)).digest('hex'); }

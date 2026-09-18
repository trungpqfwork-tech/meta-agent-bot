import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { assert } from './config.mjs';

export class Store {
  constructor(file, pageId) {
    this.pageId = pageId; this.lock = `${file}.lock`;
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
        CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,psid TEXT,action TEXT NOT NULL,at INTEGER NOT NULL,detail TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY,psid TEXT NOT NULL,at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS events_conversation ON events(psid,at);
        CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status,created);`);
      const owner = this.db.prepare('SELECT value FROM meta WHERE key=?').get('pageId');
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
        this.db.prepare('INSERT INTO events VALUES (?,?,?,?,?)').run(id,e.psid,kind,e.text,e.at);
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
  history(psid) { return this.db.prepare("SELECT kind,text,at FROM events WHERE psid=? AND kind!='bot_echo' ORDER BY at DESC,rowid DESC LIMIT 16").all(psid).reverse(); }
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
      this.db.prepare('INSERT OR IGNORE INTO events VALUES (?,?,?,?,?)').run(`${this.pageId}:sent:${mid}`,j.psid,'bot',text,Date.now());
      this.audit(j.psid,'sent',j.id);
    });
  }
  reconcile(jobId,delivered) {
    const o=this.db.prepare("SELECT * FROM outbox WHERE job_id=? AND status='unknown'").get(jobId);
    assert(o,'No ambiguous send for job');
    this.db.prepare('UPDATE outbox SET status=? WHERE job_id=?').run(delivered?'confirmed_sent':'confirmed_not_sent',jobId);
    this.audit(o.psid,'operator_reconcile',`${jobId}:${delivered}`);
    if(delivered) this.db.prepare('INSERT OR IGNORE INTO events VALUES (?,?,?,?,?)').run(`reconciled:${jobId}`,o.psid,'bot',o.text,Date.now());
  }
  snapshot() {
    return { pageId:this.pageId, conversations:this.db.prepare('SELECT * FROM conversations ORDER BY last_customer DESC LIMIT 200').all(),
      jobs:this.db.prepare('SELECT j.*,o.text AS reply,o.status AS delivery,o.mid,o.source_ids FROM jobs j LEFT JOIN outbox o ON o.job_id=j.id ORDER BY j.created DESC LIMIT 100').all(),
      audit:this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 100').all() };
  }
  close() { this.db.close(); unlinkSync(this.lock); }
}
export function eventHash(e) { return createHash('sha256').update(JSON.stringify(e)).digest('hex'); }

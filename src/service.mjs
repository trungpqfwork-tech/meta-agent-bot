import { createServer } from 'node:http';
import { realpathSync, createReadStream, existsSync, statSync } from 'node:fs';
import { basename, extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig,loadSecrets,applyEnvOverrides } from './config.mjs';
import { Store } from './store.mjs';
import { makeWebhook } from './webhook.mjs';
import { Worker } from './worker.mjs';
import { metaClient } from './meta.mjs';
import { telegramNotifier } from './telegram.mjs';
import { startAdmin } from './admin.mjs';
import { loadKnowledge } from './knowledge.mjs';
import { createHermesCompletion } from './hermes.mjs';
import { approvedImageNames } from './images.mjs';

const IMAGE_TYPES={'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp'};
// Meta tải ảnh về theo URL công khai, nên edge phải phục vụ được /images/<tên file>.
// Chỉ những file nằm trong bản ghi ĐÃ DUYỆT mới được trả về: route này không cho
// phép dò file trong runtime. Không có route này thì phải tải ảnh lên Meta, mà API
// tải lên (/message_attachments) hiện trả 400 (#-1) nên không dùng được.
export function servePublicImage(config,req,res){
  if(req.method!=='GET' && req.method!=='HEAD') return false;
  let pathname;
  try { pathname=new URL(req.url,'http://localhost').pathname; } catch { return false; }
  if(!pathname.startsWith('/images/')) return false;
  const name=basename(decodeURIComponent(pathname.slice('/images/'.length)));
  const type=IMAGE_TYPES[extname(name).toLowerCase()];
  if(!name || name.startsWith('.') || !type) { res.writeHead(404,{'Content-Type':'text/plain'}).end('Not found'); return true; }
  let allowed=false;
  try { allowed=approvedImageNames(config.imageCatalogFile).has(name); } catch { allowed=false; }
  const file=join(dirname(config.imageCatalogFile),name);
  if(!allowed || !existsSync(file)) { res.writeHead(404,{'Content-Type':'text/plain'}).end('Not found'); return true; }
  res.writeHead(200,{'Content-Type':type,'Content-Length':statSync(file).size,'Cache-Control':'public, max-age=86400'});
  if(req.method==='HEAD') { res.end(); return true; }
  createReadStream(file).on('error',()=>res.destroy()).pipe(res);
  return true;
}

export function createPageCskhService({
  configFile,
  complete,
  meta,
  notifier,
  startHttp=true,
  startAdmin: shouldStartAdmin=true,
  logger=console
}={}) {
  if(!configFile) throw new Error('configFile required');
  let config,secrets,store,worker,adminServer,httpServer,handler,started=false;
  return {
    get config(){return config;},
    get secrets(){return secrets;},
    get store(){return store;},
    get worker(){return worker;},
    async start() {
      if(started) return this;
      const base=loadConfig(configFile);
      secrets=loadSecrets(base.envFile,base.workspace);
      config=applyEnvOverrides(base,secrets);
      loadKnowledge(config.knowledgeFile);
      const pageMeta=meta ?? metaClient(config,secrets);
      const orderNotifier=notifier ?? telegramNotifier(config,secrets);
      if(config.mode==='live' && typeof pageMeta.probe==='function') {
        try {
          await pageMeta.probe();
          logger.info?.('Meta probe ok');
        } catch(e) {
          logger.warn?.(`Meta probe skipped: ${e.message}`);
        }
      }
      store=new Store(config.database,config.pageId,{sessionTtlSeconds:config.sessionTtlSeconds});
      complete ??= createHermesCompletion({model:config.model,hermesHome:config.hermesHome});
      worker=new Worker(config,store,complete,pageMeta,orderNotifier);
      handler=makeWebhook(config,secrets,store);
      if(shouldStartAdmin) adminServer=await startAdmin(config,secrets,store);
      if(startHttp) {
        httpServer=createServer((req,res)=>{
          if(servePublicImage(config,req,res)) return;
          handler(req,res);
        });
        await new Promise((resolve,reject)=>{
          httpServer.once('error',reject);
          httpServer.listen(config.edgePort,'0.0.0.0',()=>{httpServer.off('error',reject);resolve();});
        });
      }
      worker.start(e=>logger.error?.(`page-cskh worker failed: ${e?.message??e}`));
      started=true;
      logger.info?.(`page-cskh standalone ready (${config.mode})`);
      return this;
    },
    async stop() {
      if(!started && !store && !httpServer && !adminServer) return;
      started=false;
      if(worker) await worker.stop();
      if(httpServer) await new Promise(r=>httpServer.close(r));
      if(adminServer) await new Promise(r=>adminServer.close(r));
      store?.close();
      worker=undefined;httpServer=undefined;adminServer=undefined;store=undefined;handler=undefined;
    }
  };
}

export async function main(argv=process.argv.slice(2)) {
  const configFile=argv[argv.indexOf('--config')+1];
  if(!argv.includes('--config') || !configFile) throw new Error('Usage: node src/service.mjs --config /absolute/config.json');
  const service=createPageCskhService({configFile});
  await service.start();
  const shutdown=async()=>{await service.stop();process.exit(0);};
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
}

// Process managers (PM2 fork mode) make their own container script argv[1] and expose the
// real entrypoint via pm_exec_path, so argv[1] alone is not a reliable entry check.
export function isEntryPoint(argv=process.argv,env=process.env,selfUrl=import.meta.url) {
  let self;
  try { self=realpathSync(fileURLToPath(selfUrl)); } catch { return false; }
  for(const candidate of [argv[1],env.pm_exec_path]) {
    if(!candidate) continue;
    try { if(realpathSync(candidate)===self) return true; } catch {}
  }
  return false;
}

if(isEntryPoint()) main().catch(e=>{console.error(e.message);process.exitCode=1;});

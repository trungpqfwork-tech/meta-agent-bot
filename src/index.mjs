import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { applyEnvOverrides,loadConfig,loadSecrets } from './config.mjs';
import { Store } from './store.mjs';
import { makeWebhook } from './webhook.mjs';
import { Worker,openClawCompletion } from './worker.mjs';
import { metaClient } from './meta.mjs';
import { telegramNotifier } from './telegram.mjs';
import { startAdmin } from './admin.mjs';
import { loadKnowledge } from './knowledge.mjs';

export default definePluginEntry({
  id:'page-cskh',name:'Page CSKH',description:'Page-bound customer support with human ownership',
  register(api) {
    const file=api.pluginConfig?.configFile;
    if(!file) return; // Safe cold install; setup enables only after files exist.
    const initial=loadConfig(file);
    let handler,worker,store,admin;
    api.registerHttpRoute({path:initial.webhookPath,auth:'plugin',match:'exact',handler:async(req,res)=> {
      if(!handler){res.statusCode=503;res.end('not ready');return true;}
      return handler(req,res);
    }});
    api.registerService({
      id:'page-cskh-worker',
      async start() {
        const base=loadConfig(file), secrets=loadSecrets(base.envFile,base.workspace), c=applyEnvOverrides(base,secrets);
        loadKnowledge(c.knowledgeFile);
        const meta=metaClient(c,secrets);
        const notifier=telegramNotifier(c,secrets);
        if(c.mode==='live') await meta.probe();
        try {
          store=new Store(c.database,c.pageId);
          worker=new Worker(c,store,openClawCompletion(api),meta,notifier);
          admin=await startAdmin(c,secrets,store);
          handler=makeWebhook(c,secrets,store);
          worker.start(()=>api.logger.error('page-cskh: worker failed; inspect local operator status'));
          api.logger.info(`page-cskh ready (${c.mode}); operator console on loopback port ${c.adminPort}`);
        } catch(e) {store?.close();store=undefined;throw e;}
      },
      async stop() {
        handler=undefined;
        if(worker) await worker.stop();
        if(admin) await new Promise(r=>admin.close(r));
        store?.close();store=undefined;
      }
    });
  }
});

import { loadConfig,loadSecrets,assert } from '../src/config.mjs';
import { metaClient } from '../src/meta.mjs';
try {
  assert(process.argv.includes('--config'),'Use --config /path/config.json [--meta]');
  const c=loadConfig(process.argv[process.argv.indexOf('--config')+1]),s=loadSecrets(c.envFile,c.workspace);
  const r=await fetch(`http://127.0.0.1:${c.adminPort}/status`,{headers:{Authorization:`Bearer ${s.CSKH_ADMIN_TOKEN}`},signal:AbortSignal.timeout(5000)});
  assert(r.ok,'Local service unavailable');const status=await r.json();assert(status.pageId===c.pageId,'Wrong Page runtime');
  if(process.argv.includes('--meta')) await metaClient(c,s).probe();
  console.log(JSON.stringify({ok:true,mode:status.mode,pageBinding:'local verified',metaToken:process.argv.includes('--meta')?'verified against Page':'not checked',pendingHandoffs:status.conversations.filter(x=>x.state!=='BOT').length,note:'No messages sent. Public webhook and end-to-end agent reply require test Page acceptance.'},null,2));
}catch {console.error('Verification failed. Check config, local service, and token/Page binding; no credential details printed.');process.exitCode=1;}

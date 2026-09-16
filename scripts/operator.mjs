import { loadConfig,loadSecrets,assert } from '../src/config.mjs';
try {
  const args=process.argv.slice(2),i=args.indexOf('--config');assert(i>=0,'Use --config /path/config.json status|takeover PSID|resume PSID|reconcile JOB_ID sent|not-sent');
  const c=loadConfig(args[i+1]),s=loadSecrets(c.envFile,c.workspace);args.splice(i,2);
  const [action,target,outcome]=args;
  assert(['status','takeover','resume','reconcile'].includes(action),'Invalid action');
  let body;
  if(['takeover','resume'].includes(action)){assert(/^\d+$/.test(target),'Numeric PSID required');body={psid:target};}
  if(action==='reconcile'){assert(target&&['sent','not-sent'].includes(outcome),'Inspect Messenger before confirming sent/not-sent');body={jobId:target,delivered:outcome==='sent'};}
  const r=await fetch(`http://127.0.0.1:${c.adminPort}/${action}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${s.CSKH_ADMIN_TOKEN}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});
  assert(r.ok,'Operator action rejected; check ownership/unresolved sends');console.log(JSON.stringify(await r.json(),null,2));
}catch(e){console.error(e.message);process.exitCode=1;}

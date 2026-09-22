import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

const DEFAULT_HERMES_APP_DIR=join(homedir(),'.hermes','hermes-agent');

function stripPageSecrets(env) {
  const out={...env};
  for(const key of Object.keys(out)) {
    if(key.startsWith('META_') || key.startsWith('CSKH_') || key.startsWith('PAGE_CSKH_') || key==='TELEGRAM_BOT_TOKEN') delete out[key];
  }
  return out;
}

export function resolveHermesRuntime(env=process.env) {
  const appDir=env.HERMES_APP_DIR || DEFAULT_HERMES_APP_DIR;
  const venvPython=join(appDir,'venv','bin','python');
  const pythonPath=env.HERMES_PYTHON || (existsSync(venvPython) ? venvPython : 'python3');
  return {appDir,pythonPath};
}

export function buildHermesChildEnv(env=process.env,{hermesHome,appDir}={}) {
  const out=stripPageSecrets(env);
  if(hermesHome) out.HERMES_HOME=hermesHome;
  // run_agent.py lives at the root of the Hermes install dir; the child needs it importable.
  if(appDir) out.PYTHONPATH=out.PYTHONPATH ? `${appDir}${delimiter}${out.PYTHONPATH}` : appDir;
  return out;
}

function defaultRunner({model,agentId,message,system,timeoutMs,hermesHome},env=process.env) {
  return new Promise((resolve,reject)=>{
    const payload=JSON.stringify({agentId,message,system,model,timeoutMs});
    const {appDir,pythonPath}=resolveHermesRuntime(env);
    const code = `
import json, sys
from run_agent import AIAgent
req=json.loads(sys.stdin.read())
agent=AIAgent(model=req.get('model') or '',quiet_mode=True,skip_context_files=True,skip_memory=True,enabled_toolsets=[],ephemeral_system_prompt=req.get('system') or '',max_iterations=10)
print(agent.chat(req.get('message') or ''))
`;
    const child=spawn(pythonPath,['-c',code],{
      stdio:['pipe','pipe','pipe'],
      cwd:appDir,
      env:buildHermesChildEnv(env,{hermesHome,appDir})
    });
    let out='',err='';
    const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('Hermes completion timed out'));},timeoutMs||60000);
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',d=>out+=d);
    child.stderr.on('data',d=>err+=d);
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('close',code=>{clearTimeout(timer);code===0?resolve(out.trim()):reject(new Error(`Hermes completion failed: ${err.trim()||code}`));});
    child.stdin.end(payload);
  });
}

export function createHermesCompletion({model,hermesHome,runner=defaultRunner}={}) {
  return async ({agentId,message,system,timeoutMs}) => {
    const request={agentId,message,system,timeoutMs,model};
    if(hermesHome) request.hermesHome=hermesHome;
    return runner(request);
  };
}

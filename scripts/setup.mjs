import { readFileSync,writeFileSync,existsSync,mkdirSync,copyFileSync } from 'node:fs';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadConfig,loadSecrets,within,assert } from '../src/config.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function cli(args,{allowMissing=false}={}) {
  const r=spawnSync('openclaw',args,{encoding:'utf8',maxBuffer:8*1024*1024});
  if(r.status!==0) {if(allowMissing && /not found|does not exist|Unknown config path|valid but unset/i.test(r.stderr+r.stdout)) return null;throw new Error(`OpenClaw command failed: ${args.slice(0,2).join(' ')} (output withheld; run doctor locally)`);}
  return r.stdout.trim();
}
export function makePatch(c,file) {
  return {
    agents:{entries:{[c.agentId]:{name:`CSKH ${c.pageName}`,workspace:c.workspace,model:c.model,tools:{deny:['*']},skills:[]}}},
    plugins:{entries:{'page-cskh':{enabled:true,config:{configFile:resolve(file)}}}}
  };
}
export async function setup(args=process.argv.slice(2)) {
  const fileArg=args[args.indexOf('--config')+1];
  assert(args.includes('--config') && fileArg,'Usage: node scripts/setup.mjs --config /absolute/config.json [--apply]');
  const file=resolve(fileArg),c=loadConfig(file);
  assert(c.mode==='draft','Setup requires mode=draft; enable live separately after acceptance');
  assert(!within(root,c.envFile) && !within(root,c.database) && !within(root,c.workspace),'Runtime files must be outside project');
  const version=cli(['--version']);
  const rosterRaw=cli(['config','get','agents.entries','--json'],{allowMissing:true});
  const roster=rosterRaw?JSON.parse(rosterRaw):{};
  assert(roster && typeof roster==='object' && !Array.isArray(roster),'Unsupported agent roster');
  const marker=resolve(c.workspace,'.page-cskh-managed.json');
  const identity={agentId:c.agentId,pageId:c.pageId,configFile:file};
  if(roster[c.agentId] || existsSync(c.workspace)) {
    assert(existsSync(marker),'Existing agent/workspace is not managed by this project; choose another agentId/workspace');
    assert(JSON.stringify(JSON.parse(readFileSync(marker,'utf8')))==JSON.stringify(identity),'Managed agent belongs to another installation');
    if(roster[c.agentId]) assert(resolve(roster[c.agentId].workspace)===c.workspace,'Existing agent workspace differs');
  }
  const patch=makePatch(c,file);
  if(!args.includes('--apply')) {
    console.log(JSON.stringify({status:'plan_only',version,agentId:c.agentId,pageId:c.pageId,workspace:c.workspace,mode:c.mode,steps:['install local plugin','write missing templates only','validate and merge config','verify locally'],patch},null,2));return;
  }
  // Secrets are validated BEFORE any OpenClaw mutation, and never printed/exported.
  loadSecrets(c.envFile);
  mkdirSync(c.workspace,{recursive:true,mode:0o700});
  loadSecrets(c.envFile,c.workspace);
  for(const name of ['AGENTS.md','SOUL.md','IDENTITY.md']) {
    const target=resolve(c.workspace,name);if(!existsSync(target)) copyFileSync(resolve(root,'agent-template',name),target);
  }
  if(!existsSync(marker)) writeFileSync(marker,JSON.stringify(identity),{mode:0o600,flag:'wx'});
  mkdirSync(dirname(c.knowledgeFile),{recursive:true,mode:0o700});
  if(!existsSync(c.knowledgeFile)) copyFileSync(resolve(root,'knowledge-template/knowledge.json'),c.knowledgeFile);
  // Snapshot exact touched paths for review/rollback, not the full secret-bearing config.
  const oldPlugin=cli(['config','get','plugins.entries.page-cskh','--json'],{allowMissing:true});
  const backup=resolve(dirname(file),`setup-backup-${Date.now()}.json`);
  writeFileSync(backup,JSON.stringify({agentId:c.agentId,oldAgent:roster[c.agentId]??null,oldPlugin:oldPlugin?JSON.parse(oldPlugin):null},null,2),{mode:0o600,flag:'wx'});
  // Install a whitelist-packed artifact, never copy a checkout containing .env.
  const releaseDir=resolve(dirname(file),'releases');mkdirSync(releaseDir,{recursive:true,mode:0o700});
  const packed=spawnSync('npm',['pack','--ignore-scripts','--json','--pack-destination',releaseDir],{cwd:root,encoding:'utf8',maxBuffer:4*1024*1024});
  assert(packed.status===0,'Could not pack reviewed plugin');
  const artifact=JSON.parse(packed.stdout)[0];
  assert(!artifact.files.some(f=>f.path==='.env'||f.path==='config.json'||/\.sqlite/.test(f.path)),'Runtime files detected in package');
  cli(['plugins','install','npm-pack:'+resolve(releaseDir,artifact.filename),'--force','--accept-capabilities']);
  const patchFile=resolve(dirname(file),'.setup-patch.json');
  writeFileSync(patchFile,JSON.stringify(patch),{mode:0o600});
  cli(['config','patch','--file',patchFile,'--dry-run']);
  cli(['config','patch','--file',patchFile]);
  cli(['config','validate']);
  console.log(JSON.stringify({status:'configured_draft',agentId:c.agentId,backup,next:'Run doctor, inspect runtime, then verify webhook and agent on a test Page. No live sends enabled.'},null,2));
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) setup().catch(e=>{console.error(e.message);process.exitCode=1;});

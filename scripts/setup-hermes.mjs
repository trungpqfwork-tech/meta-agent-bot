import { existsSync,mkdirSync,copyFileSync,writeFileSync,readFileSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadConfig,loadSecrets,within,assert } from '../src/config.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');

function hermesVersion() {
  const r=spawnSync('hermes',['--version'],{encoding:'utf8',maxBuffer:1024*1024});
  if(r.status!==0) return null;
  return (r.stdout||r.stderr).trim();
}

export function makeHermesServiceUnit({configFile,node=process.execPath,projectRoot=root}) {
  return `[Unit]\nDescription=page-cskh Hermes standalone service\nAfter=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${projectRoot}\nExecStart=${node} ${resolve(projectRoot,'src/service.mjs')} --config ${resolve(configFile)}\nRestart=on-failure\nRestartSec=5\nNoNewPrivileges=true\n\n[Install]\nWantedBy=default.target\n`;
}

function dedicatedHermesContext(c) {
  return `# Page CSKH Hermes runtime\n\nThis Hermes home is dedicated to the page-cskh completion runtime for Page ${c.pageId}.\n\nSQLite database is the only durable customer memory. Do not use Hermes memory, sessions, or profile files to store Facebook customer history, PSIDs, orders, tokens, or operator notes. The service passes explicit JSON context from SQLite on every completion call.\n\nNo tools are required for customer completions. Do not add Meta tokens, admin tokens, customer databases, or live customer messages here.\n`;
}

function ensureDedicatedHermesHome(c) {
  if(!c.hermesHome) return null;
  mkdirSync(c.hermesHome,{recursive:true,mode:0o700});
  const context=resolve(c.hermesHome,'AGENTS.md');
  if(!existsSync(context)) writeFileSync(context,dedicatedHermesContext(c),{mode:0o600});
  return c.hermesHome;
}

export async function setupHermes(args=process.argv.slice(2)) {
  const fileArg=args[args.indexOf('--config')+1];
  assert(args.includes('--config') && fileArg,'Usage: node scripts/setup-hermes.mjs --config /absolute/config.json [--apply]');
  const file=resolve(fileArg), c=loadConfig(file);
  assert(c.mode==='draft','Setup requires mode=draft; enable live separately after acceptance');
  assert(!within(root,c.envFile) && !within(root,c.database) && !within(root,c.workspace),'Runtime files must be outside project');
  const version=hermesVersion();
  const unit=makeHermesServiceUnit({configFile:file});
  const plan={status:'plan_only',runtime:'hermes-standalone',hermesVersion:version,agentId:c.agentId,pageId:c.pageId,workspace:c.workspace,hermesHome:c.hermesHome??null,mode:c.mode,steps:['validate private env','write missing templates only','prepare dedicated Hermes home when configured','write optional systemd user unit','start standalone service in draft','verify webhook/admin/queue before live'],startCommand:`npm start -- --config ${file}`};
  if(!args.includes('--apply')) {console.log(JSON.stringify(plan,null,2));return plan;}
  mkdirSync(c.workspace,{recursive:true,mode:0o700});
  loadSecrets(c.envFile,c.workspace);
  for(const name of ['AGENTS.md','SOUL.md','IDENTITY.md']) {
    const target=resolve(c.workspace,name);
    if(!existsSync(target)) copyFileSync(resolve(root,'agent-template',name),target);
  }
  mkdirSync(dirname(c.knowledgeFile),{recursive:true,mode:0o700});
  if(!existsSync(c.knowledgeFile)) copyFileSync(resolve(root,'knowledge-template/knowledge.json'),c.knowledgeFile);
  const productsFile=resolve(dirname(file),'products.json');
  if(!existsSync(productsFile)) copyFileSync(resolve(root,'products-template/products.json'),productsFile);
  mkdirSync(c.imageDir,{recursive:true,mode:0o700});
  mkdirSync(dirname(c.imageCatalogFile),{recursive:true,mode:0o700});
  if(!existsSync(c.imageCatalogFile)) copyFileSync(resolve(root,'image-template/catalog.json'),c.imageCatalogFile);
  mkdirSync(dirname(c.database),{recursive:true,mode:0o700});
  const hermesHome=ensureDedicatedHermesHome(c);
  const unitFile=resolve(dirname(file),'page-cskh.service');
  if(!existsSync(unitFile) || readFileSync(unitFile,'utf8')!==unit) writeFileSync(unitFile,unit,{mode:0o600});
  const result={...plan,status:'configured_draft',unitFile,hermesHome,next:'Run npm run doctor/verify, then start the service in draft. Do not enable live until acceptance passes.'};
  console.log(JSON.stringify(result,null,2));
  return result;
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) setupHermes().catch(e=>{console.error(e.message);process.exitCode=1;});

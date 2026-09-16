import { readdirSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
for(const dir of ['src','scripts','test']) for(const name of readdirSync(dir)) if(name.endsWith('.mjs')) {
  const r=spawnSync(process.execPath,['--check',join(dir,name)],{encoding:'utf8'});
  if(r.status!==0) {console.error(r.stderr);process.exit(1);}
}
for(const name of ['package.json','openclaw.plugin.json','config.example.json','knowledge-template/knowledge.json']) JSON.parse(readFileSync(name,'utf8'));
console.log('Syntax and JSON checks passed');

import { loadConfig,loadSecrets } from '../src/config.mjs';
import { loadKnowledge } from '../src/knowledge.mjs';
import { cli } from './setup.mjs';
try {
  const file=process.argv[process.argv.indexOf('--config')+1];
  if(!process.argv.includes('--config'))throw Error('Use --config /path/config.json');
  const c=loadConfig(file);loadSecrets(c.envFile,c.workspace);
  const docs=loadKnowledge(c.knowledgeFile);
  const roster=JSON.parse(cli(['config','get','agents.entries','--json']));
  const agent=roster[c.agentId];
  const model=typeof agent?.model==='string'?agent.model:agent?.model?.primary;
  if(!agent || agent.workspace!==c.workspace || model!==c.model || !agent.tools?.deny?.includes('*'))throw Error('Agent missing or workspace/model/tool policy differs');
  cli(['config','validate']);
  console.log(JSON.stringify({ok:true,pageId:c.pageId,agentId:c.agentId,mode:c.mode,approvedDocuments:docs.filter(d=>d.approved).length,secrets:'present; not printed',liveProof:'not checked; run verify --meta and Page acceptance tests'},null,2));
}catch(e){console.error(e.message);process.exitCode=1;}

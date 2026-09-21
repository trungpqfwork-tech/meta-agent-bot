import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import { runtimeConfigFromEnv, loadConfig, loadSecrets, assert } from '../src/config.mjs';
import { makePatch, cli } from './setup.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(name) { return process.argv.includes(name); }
function run(bin, args, opts={}) {
  const r = spawnSync(bin, args, {encoding:'utf8', maxBuffer:8*1024*1024, ...opts});
  if(r.status !== 0) throw new Error(`${bin} ${args.slice(0,2).join(' ')} failed`);
  return r.stdout.trim();
}
function jsonFile(file, value, mode=0o600) {
  mkdirSync(dirname(file), {recursive:true, mode:0o700});
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {mode});
}
function textFile(file, value, mode=0o700) {
  mkdirSync(dirname(file), {recursive:true, mode:0o700});
  writeFileSync(file, value, {mode});
}

try {
  const envFile = resolve(arg('--env') ?? '');
  assert(envFile && process.argv.includes('--env'), 'Usage: npm run deploy-runtime -- --env /absolute/runtime/.env [--apply] [--start-pm2] [--restart-gateway]');
  const runtimeDir = resolve(arg('--runtime') ?? dirname(envFile));
  const configFile = resolve(arg('--config') ?? `${runtimeDir}/config.json`);
  const edgeFile = resolve(arg('--edge') ?? `${runtimeDir}/edge.json`);
  const ecosystemFile = resolve(arg('--ecosystem') ?? `${runtimeDir}/ecosystem.config.js`);
  const runnerFile = resolve(arg('--runner') ?? `${runtimeDir}/pm2-edge-runner.mjs`);
  const gatewayPort = Number(arg('--gateway-port') ?? 18789);
  assert(Number.isInteger(gatewayPort) && gatewayPort > 1024 && gatewayPort < 65536, 'Invalid Gateway port');

  chmodSync(envFile, 0o600);
  const env = parseEnv(readFileSync(envFile, 'utf8'));
  const config = runtimeConfigFromEnv(env);
  jsonFile(configFile, config);
  const loaded = loadConfig(configFile);
  loadSecrets(loaded.envFile);

  const edge = {
    port: loaded.edgePort,
    webhookPath: loaded.webhookPath,
    upstream: `http://127.0.0.1:${gatewayPort}${loaded.webhookPath}`,
    envFile: loaded.envFile,
    backendEnabled: true
  };
  jsonFile(edgeFile, edge);

  textFile(runnerFile, `import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { createEdge } from ${JSON.stringify(resolve(projectRoot, 'src/edge.mjs'))};
import { assert } from ${JSON.stringify(resolve(projectRoot, 'src/config.mjs'))};

const configFile = ${JSON.stringify(edgeFile)};
const c = JSON.parse(readFileSync(configFile, 'utf8'));
assert(Number.isInteger(c.port) && c.port > 1024 && c.port < 65536, 'Invalid edge port');
assert((statSync(c.envFile).mode & 0o077) === 0, 'Env must have mode 600');
const secrets = parseEnv(readFileSync(c.envFile, 'utf8'));
assert(secrets.META_WEBHOOK_VERIFY_TOKEN?.length >= 16 && secrets.META_APP_SECRET?.length >= 16, 'Required webhook secrets missing');
c.logFile = resolve(dirname(configFile), 'logs', 'edge.log');
const server = createEdge(c, secrets);
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.on('error', e => { console.error('Edge listener failed:', e.message); process.exitCode = 1; });
server.listen(c.port, '127.0.0.1', () => console.log(\`Webhook-only edge listening on 127.0.0.1:\${c.port}; processing=\${c.backendEnabled === true}\`));
for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => {
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => process.exit(0), 12000).unref();
});
`);

  textFile(ecosystemFile, `module.exports = {
  apps: [{
    name: 'page-cskh-edge',
    script: ${JSON.stringify(runnerFile)},
    cwd: ${JSON.stringify(runtimeDir)},
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    max_restarts: 10,
    min_uptime: '5s',
    out_file: ${JSON.stringify(resolve(runtimeDir, 'logs/pm2-edge.out.log'))},
    error_file: ${JSON.stringify(resolve(runtimeDir, 'logs/pm2-edge.err.log'))},
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
  }]
};
`, 0o600);

  mkdirSync(loaded.workspace, {recursive:true, mode:0o700});
  loadSecrets(loaded.envFile, loaded.workspace);
  const marker = resolve(loaded.workspace, '.page-cskh-managed.json');
  if(!existsSync(marker)) jsonFile(marker, {agentId:loaded.agentId, pageId:loaded.pageId, configFile});
  for(const name of ['AGENTS.md','SOUL.md','IDENTITY.md']) {
    const target = resolve(loaded.workspace, name);
    if(!existsSync(target)) copyFileSync(resolve(projectRoot, 'agent-template', name), target);
  }
  mkdirSync(dirname(loaded.knowledgeFile), {recursive:true, mode:0o700});
  if(!existsSync(loaded.knowledgeFile)) copyFileSync(resolve(projectRoot, 'knowledge-template/knowledge.json'), loaded.knowledgeFile);
  const productsFile = resolve(runtimeDir, 'products.json');
  if(!existsSync(productsFile)) copyFileSync(resolve(projectRoot, 'products-template/products.json'), productsFile);
  mkdirSync(loaded.imageDir, {recursive:true, mode:0o700});
  mkdirSync(dirname(loaded.imageCatalogFile), {recursive:true, mode:0o700});
  if(!existsSync(loaded.imageCatalogFile)) copyFileSync(resolve(projectRoot, 'image-template/catalog.json'), loaded.imageCatalogFile);

  const summary = {status:'generated', runtimeDir, configFile, edgeFile, ecosystemFile, edgePort:loaded.edgePort, webhookPath:loaded.webhookPath, mode:loaded.mode};
  if(has('--apply')) {
    const releaseDir = resolve(runtimeDir, 'releases');
    mkdirSync(releaseDir, {recursive:true, mode:0o700});
    const packed = spawnSync('npm', ['pack','--ignore-scripts','--json','--pack-destination',releaseDir], {cwd:projectRoot, encoding:'utf8', maxBuffer:4*1024*1024});
    assert(packed.status === 0, 'Could not pack plugin');
    const artifact = JSON.parse(packed.stdout)[0];
    assert(!artifact.files.some(f => f.path === '.env' || f.path === 'config.json' || /\.sqlite/.test(f.path)), 'Runtime files detected in package');
    const artifactPath = resolve(releaseDir, artifact.filename);
    cli(['plugins','install',`npm-pack:${artifactPath}`,'--force','--accept-capabilities']);
    const patchFile = resolve(runtimeDir, '.setup-patch.json');
    jsonFile(patchFile, makePatch(loaded, configFile));
    cli(['config','patch','--file',patchFile,'--dry-run']);
    cli(['config','patch','--file',patchFile]);
    cli(['config','validate']);
    summary.pluginInstalled = true;
  }
  if(has('--start-pm2')) {
    run('pm2', ['startOrReload', ecosystemFile, '--update-env']);
    if(has('--pm2-save')) run('pm2', ['save']);
    summary.pm2Started = true;
  }
  if(has('--restart-gateway')) {
    run('systemctl', ['--user','restart','openclaw-gateway.service']);
    summary.gatewayRestarted = true;
  }
  console.log(JSON.stringify(summary, null, 2));
} catch(e) {
  console.error(e.message);
  process.exitCode = 1;
}

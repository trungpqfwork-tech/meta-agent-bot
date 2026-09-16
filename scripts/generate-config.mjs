import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { runtimeConfigFromEnv, loadConfig } from '../src/config.mjs';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

try {
  const envFile = resolve(arg('--env') ?? './.env');
  const outFile = resolve(arg('--out') ?? resolve(dirname(envFile), 'config.json'));
  const env = parseEnv(readFileSync(envFile, 'utf8'));
  const config = runtimeConfigFromEnv(env);
  mkdirSync(dirname(outFile), {recursive: true, mode: 0o700});
  writeFileSync(outFile, JSON.stringify(config, null, 2) + '\n', {mode: 0o600});
  loadConfig(outFile);
  console.log(JSON.stringify({status: 'generated', configFile: outFile, pageId: config.pageId, mode: config.mode, webhookPath: config.webhookPath, edgePort: config.edgePort}, null, 2));
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}

#!/usr/bin/env node
// Check how the classifier prompts tier a customer: sỉ (store), lẻ (personal) or
// "chưa rõ". Run after touching agentPolicy, the B1 understanding prompt or the
// order extractor — all three must agree, and the tier decides which price the
// bot may read out.
//
//   node scripts/tier-check.mjs --config /path/runtime/config.json
//   node scripts/tier-check.mjs --config ... --runs 3      # repeat for stability
import { resolve } from 'node:path';
import { loadConfig, loadSecrets } from '../src/config.mjs';
import { parseModelJson } from '../src/knowledge.mjs';
import { createHermesCompletion } from '../src/hermes.mjs';
import { UNDERSTAND_PROMPT, EXTRACT_ORDER_PROMPT } from '../src/worker.mjs';

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const configPath = arg('--config', '');
if (!configPath) {
  console.error('Usage: node scripts/tier-check.mjs --config /path/runtime/config.json [--runs 2]');
  process.exit(2);
}
const runs = Number(arg('--runs', '1'));

const CASES = [
  ['Anh đặt tiệc cưới 30 bàn, ba chỉ bò giá sao em?', 'store'],
  ['Nhà anh làm cỗ, cần ba chỉ bò', 'store'],
  ['Anh cần đặt tiệc cưới 20 mâm', 'store'],
  ['Bếp anh lấy ba chỉ bò', 'store'],
  ['Chị lấy buôn về bán lại', 'store'],
  ['Anh mua ba chỉ bò về ăn', 'personal'],
  ['Nhà anh liên hoan cuối tuần', 'personal'],
  // Số lượng / mua nguyên con không quyết định nhóm khách — chỉ mục đích.
  ['Anh mua 1 con cá hồi nguyên con về ăn', 'personal'],
  ['Gia đình anh lấy nguyên con cá hồi', 'personal'],
  ['Anh mua nguyên con cá hồi về liên hoan', 'personal'],
  ['Anh lấy nguyên con cá hồi giá sao?', null],
  ['Cá hồi nguyên con giá bao nhiêu?', null],
  ['Nhà hàng anh lấy 1 con cá hồi nguyên con', 'store'],
  ['Ba chỉ bò giá bao nhiêu?', null],
];

const c = loadConfig(resolve(configPath));
const s = loadSecrets(c.envFile, c.workspace);
const complete = createHermesCompletion({ model: c.model, hermesHome: c.hermesHome });

const ask = async (system, msg) => {
  try {
    return parseModelJson(await complete({
      agentId: c.agentId, system, timeoutMs: c.agentTimeoutMs,
      message: JSON.stringify({ history: [], currentMessage: msg, order: null }),
    }));
  } catch {
    return {};
  }
};

let bad = 0;
for (const [msg, want] of CASES) {
  for (let i = 0; i < runs; i++) {
    const a = await ask(UNDERSTAND_PROMPT, msg);
    const b = await ask(EXTRACT_ORDER_PROMPT, msg);
    const b1 = a.nhom_khach ?? null;
    const ex = b.customerType ?? null;
    const ok = b1 === want || ex === want;
    if (!ok) bad++;
    const show = v => (v === null ? 'chưa rõ' : v);
    console.log(`${ok ? '✅' : '❌'} "${msg}"  muốn=${show(want)}  B1=${show(b1)}  trích-đơn=${show(ex)}${runs > 1 ? `  (lượt ${i + 1})` : ''}`);
  }
}
console.log(bad ? `\n${bad}/${CASES.length * runs} lượt sai — siết nhánh tương ứng trong cả 3 prompt.` : `\nTất cả đúng (${CASES.length * runs} lượt).`);
process.exit(bad ? 1 : 0);

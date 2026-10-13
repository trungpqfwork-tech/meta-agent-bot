import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Worker } from '../src/worker.mjs';
import { agentPolicy } from '../src/knowledge.mjs';

function fixture(t, mode = 'live') {
  const dir = mkdtempSync(join(tmpdir(), 'page-cskh-context-'));
  const c = {
    ...JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url))),
    pageId: '100', appId: '200', model: 'provider/model', mode,
    workspace: join(dir, 'agent'), envFile: join(dir, '.env'),
    database: join(dir, 'data/state.sqlite'), knowledgeFile: join(dir, 'knowledge.json'),
    messageDebounceSeconds: 0,
  };
  mkdirSync(c.workspace);
  const secrets = { META_APP_SECRET: 's'.repeat(32), META_PAGE_ACCESS_TOKEN: 'p'.repeat(32), META_WEBHOOK_VERIFY_TOKEN: 'v'.repeat(32), CSKH_ADMIN_TOKEN: 'a'.repeat(40) };
  writeFileSync(c.envFile, Object.entries(secrets).map(([k, v]) => `${k}=${v}`).join('\n'), { mode: 0o600 });
  const s = new Store(c.database, c.pageId);
  t.after(() => s.close());
  return { c, s };
}
const inbound = (psid, id, text) => ({ psid, id, kind: 'customer', text, at: Date.now() });

// The previous topic used to fill every context slot: documents about ba chỉ bò
// outscored the single document for sụn non, so the bot answered "dữ liệu em
// chưa ghi rõ xuất xứ" for an item whose own document states the origin.
function kb() {
  const rows = [
    ['product-ba-chi-bo', 'Ba chỉ bò', ['Ba chỉ bò', 'Ba chỉ', 'bò'], 'Ba chỉ bò: giá buôn 213.000đ/kg'],
    ['product-ba-chi-bo-loai-1-thai-day', 'Ba chỉ bò loại 1 (thái dày)', ['Ba chỉ bò loại 1', 'Ba chỉ', 'bò'], 'Ba chỉ bò loại 1: 140.000đ/khay'],
    ['product-ba-chi-bo-loai-1-thai-mong', 'Ba chỉ bò loại 1 (thái mỏng)', ['Ba chỉ bò loại 1', 'Ba chỉ', 'bò'], 'Ba chỉ bò loại 1: 140.000đ/khay'],
    ['product-ba-chi-bo-loai-2-thai-day', 'Ba chỉ bò loại 2 (thái dày)', ['Ba chỉ bò loại 2', 'Ba chỉ', 'bò'], 'Ba chỉ bò loại 2: 130.000đ/khay'],
    ['product-ba-chi-bo-loai-2-thai-mong', 'Ba chỉ bò loại 2 (thái mỏng)', ['Ba chỉ bò loại 2', 'Ba chỉ', 'bò'], 'Ba chỉ bò loại 2: 130.000đ/khay'],
    ['product-sun-non-heo', 'Sụn non heo', ['Sụn non heo', 'sụn non', 'sụn'], 'Sụn non heo: xuất xứ Nga'],
    ['category-heo', 'Nhóm sản phẩm heo', ['heo'], 'Nhóm heo: ba chỉ heo, sụn non heo'],
  ];
  return JSON.stringify({
    schemaVersion: 1,
    documents: rows.map(([id, title, keywords, content]) => ({ id, title, keywords, content, approved: true, validUntil: null })),
  });
}

test('câu khách đang hỏi thắng chủ đề cũ khi lấy tài liệu', async t => {
  const { c, s } = fixture(t);
  writeFileSync(c.knowledgeFile, kb());
  const seen = [];
  const w = new Worker(c, s, async p => {
    const m = JSON.parse(p.message);
    // Lượt trả lời chính dùng agentPolicy; bộ kiểm tra và bộ hiểu câu hỏi có
    // prompt riêng nên phải nhận JSON khác, nếu không lượt kiểm tra sẽ bị chấm
    // là rớt và hội thoại bị chuyển sang WAITING.
    if (p.system === agentPolicy) {
      if (Array.isArray(m.documents)) seen.push(m.documents.map(d => d.id));
      // Trích tài liệu CÓ trong lượt này: một câu trích tài liệu không được cấp
      // sẽ bị validateAnswer chặn và hội thoại chuyển sang WAITING.
      return JSON.stringify({ action: 'reply', text: 'Dạ em xin trả lời ạ.', sourceIds: [m.documents[0].id] });
    }
    if (/bộ kiểm tra/.test(p.system)) return '{"inScope":true,"supported":true}';
    return JSON.stringify({ inScope: true, supported: true, wantsOrder: false, san_pham: [], nhom: [], y_dinh: 'khác', nhom_khach: null, chinh_sach: [] });
  }, { send: async () => 'out' });

  for (const [id, text] of [['m1', 'Bà chỉ bò thật sao?'], ['m2', 'Ba chỉ bò giá sao em?']]) {
    s.ingest([inbound('111', id, text)], c);
    const j = s.next();
    assert.ok(j, `phải có job cho ${id}`);
    await w.process(j);
    assert.equal(s.conversation('111').state, 'BOT', `sau ${id} hội thoại phải ở BOT`);
  }

  seen.length = 0;
  s.ingest([inbound('111', 'm3', 'Sụn non bên em xuất xứ từ đâu?')], c);
  const j3 = s.next();
  assert.ok(j3, 'phải có job cho câu hỏi mới');
  await w.process(j3);

  assert.ok(seen.length, 'phải có lượt trả lời dùng tài liệu');
  const got = seen.at(-1);
  assert.ok(got.includes('product-sun-non-heo'),
    'tài liệu của món khách đang hỏi phải nằm trong ngữ cảnh, nhận được: ' + JSON.stringify(got));
});

---
name: page-cskh-admin
description: "Use when operating the page-cskh CSKH bot — KB updates, reply behavior, stuck conversations, deploy diagnostics."
version: 1.0.0
---

# Page CSKH — admin/ops

Use this skill when the owner asks to update the knowledge base, change how the
bot answers, unstick a conversation, deploy, or diagnose the Page CSKH service.
This is the **admin** side. The customer-facing completion is tool-less and must
stay that way — never route customer messages into this workflow.

## Hard rules

- **Never print, echo, or paste secrets** (`META_*`, `CSKH_ADMIN_TOKEN`,
  `TELEGRAM_BOT_TOKEN`). Read them only inside the scripts that need them; never
  put them in a prompt, a log line, or a chat message. Show lengths, not values.
- **Ask before restarting** the service, then restart through
  `scripts/restart-safe.mjs` — never bare `pm2 restart`. A restart kills the
  worker mid-job: the job ends as `cancelled` with `ownership_changed`, the
  customer never gets a reply, and there is **no replay path**. On 2026-10-01 a
  restart dropped a live customer question ("Cắt khúc thì thế nào em?") exactly
  this way.
- **Preview before applying** any KB change, and wait for an explicit approval
  ("apply", "duyệt", "ok cập nhật").
- **One live sender per Page.** Never start a second instance against the same
  Page. Stop the old one first.
- **Never copy a running SQLite** by its `.sqlite` file alone. Stop the writer or
  checkpoint so `-wal`/`-shm` travel with it, otherwise the copy loses the newest
  messages.
- **Never commit runtime data** (`knowledge.json`, `products.json`, `images/`,
  `data/`, `logs/`, `agent/`, `.env`, `config*.json`). All are gitignored; the
  repo ships `*-template/` instead.

## Running the admin agent

`AGENTS.md` and this skill load only when the session's working directory resolves
to the repo root. `terminal.cwd` must be an **absolute** path to the repo: with
the default relative `.` the session cwd resolves to the Hermes home, and both
the project rules and this skill silently fail to load — no error, just an agent
that does not know the procedure. `scripts/setup-admin-agent.sh` sets it and
`--check` verifies it. If runtime `.env` has
`PAGE_CSKH_ADMIN_TELEGRAM_BOT_TOKEN` and
`PAGE_CSKH_ADMIN_TELEGRAM_ALLOWED_USERS`, the script imports them into the admin
Hermes profile as `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USERS`, then starts
and enables the Hermes gateway for that profile; keep this admin bot separate
from the CSKH alert bot.

## Where things are

The **runtime dir** holds `config.json`, `.env`, `data/`, `knowledge.json`,
`products.json`, `images/`, `agent/logs/`. The **code** lives in a separate dir
(shipped with `git archive`). Ask the owner for the runtime dir if unknown —
never guess, and never write outside it.

```bash
RUNTIME=<runtime dir containing config.json>
CONFIG=$RUNTIME/config.json
```

Ports, model, database, KB paths and mode all come from `config.json`. Note:
`PAGE_CSKH_*` ports in `.env` only take effect when `config.json` is
regenerated — at runtime `applyEnvOverrides` honours only `MODE`,
`WAITING_RESET_SECONDS`, `MESSAGE_DEBOUNCE_SECONDS`, `ENABLE_HUMAN_HANDOFF`,
`ORDER_TELEGRAM_CHAT_IDS`.

## 1. Update the knowledge base (no restart needed)

`retrieve()` re-reads the KB on every answer, so content changes never need a
restart.

```bash
node scripts/import-products.mjs --file "/path/products.xlsx" \
  --runtime "$RUNTIME" --sheet "Đặc tính SP"            # preview
node scripts/import-products.mjs --file "/path/products.xlsx" \
  --runtime "$RUNTIME" --sheet "Đặc tính SP" --apply    # write
```

- **Always pass `--sheet`** when the workbook has internal sheets (sales, KPIs,
  quotas). Those must never reach the KB.
- **Group-header rows** (`THỊT BÒ`, `HẢI SẢN`, `HEO`, `TRÂU`, `GÀ`, `Gia Vị`...)
  sit in the product-name column with an empty `TT`. Importing them raw creates
  products literally named `HEO`. Filter them out.
- **Internal columns must never reach the KB**: `Cost`, `Cước`, `Nét`, and the
  unlabelled margin column (a negative number). The importer has no alias for
  them, so they drop out — keep it that way.
- **`Ghi Chú` in a price sheet is usually operational** (`Hết`, `Xả`,
  `SL liên hệ`, `Chọn giá 69`, `Hỗ trợ cắt`). It goes stale within days and the
  bot would quote stock states to customers. Keep it out of the KB.
- **Price cells are bare thousands**: `205` means `205.000đ`. `formatPrice()`
  multiplies by 1000 and appends `đ`. Verify before trusting: the sheet's own
  arithmetic must close (`Cost + Cước = Nét`, `Giá Thùng − Nét` = margin column).
- **Operator price names rarely match KB product names.** A wholesale sheet
  saying `Ba chỉ bò JBS Diamond CND` is KB's `Ba chỉ bò` brand
  `Blueribbon (JBS)`. Importing raw turns 27 products into 84 near-duplicates
  (verified). Always build an explicit name→(product, brand) map and get it
  approved before applying.

### How the importer merges, and how to re-render safely

Every `--apply` **regenerates all `product-*` and `category-*` documents from
`products.json`** and republishes them; only documents outside those two families
(`policy-*`, `example-*`) survive untouched.

- **Never hand-edit a `product-*` document in `knowledge.json`.** The next import
  overwrites it. Text that must persist goes into `products.json` (`notes`,
  `origins`, brand `traits`/`bestFor`, `useCases`) or into a `policy-*` document.
  This bit once: a paragraph explaining which ba chỉ bò cuts are retail lived
  only in the document and disappeared on the next import.
- **An empty cell must never erase imported data.** `mergeProduct()` keeps the
  existing value when the incoming one is empty (`category`, `name`, `traits`,
  and every price field). A sheet with no `Nhóm` column used to blank the
  category of products that already had one — and a product without a category
  drops out of its `category-*` document, so the bot stops offering it. If you
  add a merge field, guard it the same way.
- **Notes are prose, not a keyword list.** They are stored and rendered whole; do
  not route them through `uniq()`, which splits on `,`, `;`, `/` and shreds
  `140.000đ/khay 500gr` into fragments. Strip trailing `.` before joining so the
  rendered line does not read `…từ Nga.; Móng heo…`.
- **To re-render documents without touching data**, pass a file with no rows:
  ```bash
  echo '[]' > /tmp/empty-rows.json
  node scripts/import-products.mjs --file /tmp/empty-rows.json --runtime "$RUNTIME" --apply
  ```
  `Retrieval`/rendering is what you want after editing `products.json` directly;
  it reports `Update/merge: 0`.
- **Back up before any apply** — the importer writes `products.json.bak-*`,
  `knowledge.json.bak-*` and `images/catalog.json.bak-*` on its own, but take your
  own copy too, and diff afterwards to see exactly which documents changed.

### Keywords decide whether the bot can answer at all

`retrieve()` scores documents by whole-phrase keyword hits, so a document the
customer asked about still loses if its keywords do not match how customers
write. The importer generates extra variants per product name; keep them when you
touch that code:

- the name with any parenthetical qualifier removed and its inner forms
  (`Cá hồi cắt khúc (khúc giữa)` → `Cá hồi cắt khúc`, `khúc giữa`);
- the name with the trailing category noun dropped (`Sụn non heo` → `sụn non`);
- every leading word-prefix (`Tôm thẻ hấp size 25` → `tôm thẻ`, `Tôm thẻ hấp`);
- the single distinctive first word of a two-word name (`Dải heo` → `dải`,
  `Tim heo` → `tim`).

Symptoms of missing variants: the bot answers from a `category-*` document and
says it has no origin/price for an item it does hold ("dữ liệu em chưa ghi rõ
xuất xứ"), or asks the customer to repeat the product. Verify with one line:

```bash
node -e "import('$APP/src/knowledge.mjs').then(({retrieve})=>{
  const K='$RUNTIME/knowledge.json';
  for(const q of ['sụn non giá sao','mực ống giá sao','tôm thẻ giá sao'])
    console.log(q,'->',retrieve(K,q).filter(d=>d.id.startsWith('product-')).map(d=>d.id).join(', '));})"
```

### Price model (three tiers)

`Giá mua dùng` = households. `Giá buôn` = bếp ăn / nhà hàng / khách sạn / quán
lẩu nướng, split by order size: `Giá < 1 thùng` (under one pack's weight) and
`Giá Thùng` / `Giá buôn từ 1 thùng trở lên`. Any header containing "thùng" is a
band column, never the flat wholesale price.

Retail and wholesale prices live in separate fields with **separate unit and
pack size** (`priceUnitRetail`/`packSizeRetail` vs `priceUnitWholesale`/
`packSizeWholesale`). They used to share one field and a later retail import
overwrote the wholesale pack, printing `147/Khay` for a price that was per kg.

A row naming a brand puts the price on that brand only; a row without a brand
puts it on the product. Brands sharing identical traits and prices still group
into one line, so one row listing `APK, Miratoc, VLMK` is enough.

- The Excel reader is python3 **stdlib** (zipfile + ElementTree) and expands
  merged cells. Do **not** install or require `openpyxl`, and `.xls` must be
  re-saved as `.xlsx`.
- Column matching is word-boundary based. A substring match once turned the
  `Ảnh` alias into the `Danh Mục` column and invented 27 approved image records;
  if image counts jump after an import, that class of bug is back.
- `--apply` overwrites `product-*`/`category-*` docs and **keeps** every other
  document; it backs up `knowledge.json`/`products.json`/`images/catalog.json`
  automatically — report those paths.
- Report a diff summary (added/updated/removed) and 3-4 smoke questions after
  applying. Do not silently delete products that the new file omits.

### Who the customer is decides the price tier

The operator's rule lives in **three** prompts and they must agree
(`agentPolicy` in `src/knowledge.mjs`, `UNDERSTAND_PROMPT` and
`EXTRACT_ORDER_PROMPT` in `src/worker.mjs` — changing one alone leaves the others
contradicting it):

- **Wholesale** (`customerType=store`): resale or a business — cửa hàng, đại lý,
  anyone taking goods to buôn bán/kinh doanh/bán lại, nhà hàng, quán ăn, bếp ăn,
  khách sạn — **and customers taking meat to cook for a gathering or a wedding**
  (`làm cỗ`, `làm tiệc`, `tiệc cưới`, `đám cưới`, `đặt tiệc`, `phục vụ tiệc`).
- **Retail** (`customerType=personal`): dùng cho gia đình, liên hoan, hội họp,
  sinh nhật, giỗ trong nhà, mua 1-2kg, mua khay.
- **Unknown**: read out **no** money figure at all — not wholesale, not a range,
  not "chỉ bán buôn" — describe traits/origin/uses and ask exactly one question:
  `Anh/chị lấy về cho nhà hàng, quán ăn hay mua về dùng cho gia đình ạ?`

Verify against the real model before shipping a prompt change:

```bash
node scripts/tier-check.mjs --config "$RUNTIME/config.json"          # 8 phrasings
node scripts/tier-check.mjs --config "$RUNTIME/config.json" --runs 3 # stability
```

`liên hoan`/`hội họp` are retail while `cỗ`/`tiệc cưới` are wholesale — that
boundary is the operator's call (confirmed 2026-10-05). If a run flips one,
tighten that branch in all three prompts, not just the answer text.

Verify after applying:

```bash
node -e "const k=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));\
console.log('docs',k.documents.length,'approved',k.documents.filter(d=>d.approved).length)" \
  "$RUNTIME/knowledge.json"
```

Expected shape for the TM Food KB: 27 products + 5 category groups, 32 approved.

## 2. Change how the bot answers

| What | Where | Restart? |
|---|---|---|
| Product/policy facts | `knowledge.json` via the importer | no |
| Scope text, keywords, handoff/out-of-scope/clarify replies, model, handoff flag, waiting reset | `.env` + `config.json` | yes |
| The bot's system prompt and answer contract | **code**: `src/knowledge.mjs` (`agentPolicy`, `answerFormatPolicy`) and the inline prompts in `src/worker.mjs` | yes |

`agent-template/{AGENTS.md,SOUL.md,IDENTITY.md}` and the runtime `agent/` dir are
**not read** by the service — `workspace` is only used to place
`agent/logs/worker.log` and to assert that `.env`/the DB stay outside it. Editing
those files changes nothing. Do not promise the owner otherwise.

Flow for a behaviour change: edit the file → regenerate config if `.env` changed
(`node scripts/generate-config.mjs --env "$RUNTIME/.env"`) → ask → restart →
verify with one real completion.

## 3. Conversations and orders

```bash
node scripts/operator.mjs --config "$CONFIG" status
node scripts/operator.mjs --config "$CONFIG" takeover <psid>     # human takes over -> HUMAN
node scripts/operator.mjs --config "$CONFIG" resume <psid>       # back to BOT
node scripts/operator.mjs --config "$CONFIG" reconcile <id> sent|not-sent
```

`reconcile` is the only way out of an ambiguous send — check the Page inbox
first, never auto-resend. A conversation can sit in `WAITING` for reasons that do
**not** alert Telegram: `messaging_window_expired`, `ambiguous_send`,
`runtime_interrupted`, `auto_waiting_reset`, `external_page_message`.

## 4. Diagnostics

Restarting safely (do this instead of `pm2 restart`):

```bash
export PATH=$HOME/.hermes/tools/bin:$PATH           # pm2 lives inside the volume
node scripts/restart-safe.mjs --config "$RUNTIME/config.json"
node scripts/restart-safe.mjs --config "$RUNTIME/config.json" --dry-run   # check only
node scripts/restart-safe.mjs --config "$RUNTIME/config.json" --wait 180  # wait longer for a job to drain
```

It refuses to restart while a job is in flight (waiting up to `--wait`, default
120s), skips rows older than 10 minutes so a stale row cannot block forever, then
polls `/status` until the service is back and prints mode/pageId. `--force`
overrides the gate and **will lose the running job**.

```bash
pm2 status                                    # one sender per Page, online
tail -50 "$RUNTIME/logs/webhook.log"          # GET verify ok / POST ingested / sig_fail
tail -50 "$RUNTIME/agent/logs/worker.log"     # process handoff / handoff_suppressed / send errors
curl "http://127.0.0.1:<edgePort>/webhooks/page-cskh?hub.mode=subscribe&hub.verify_token=<verify>&hub.challenge=ok"   # -> 200 ok
curl -H "Authorization: Bearer <CSKH_ADMIN_TOKEN>" http://127.0.0.1:<adminPort>/status
```

Known failure modes: every reply falling back to the default text means the
completion is failing (`agent_error` in the worker log) — usually the Hermes
venv interpreter or the model id; `handoff_suppressed` means
`enableHumanHandoff=false`; a Telegram alert that never arrives means the
notifier is disabled (no token/chat ids) or the flag above is false.

**Replies land on the handoff text (`Em chuyển nhân viên hỗ trợ tiếp nhận nhé`).**
The worker runs a second model call that reviews the draft reply
(`ANSWER_CHECK_PROMPT`) and hands off when it returns `supported=false`, which
means the draft stated a business fact the supplied documents do not back. It is
**not** a retrieval crash — read `verify_fail` in the worker log, which now
records the rejected text in `answer=...`. Diagnose in this order:

1. Does the context for that turn actually contain the document with the fact?
   Rebuild the query the worker used (`last 3 customer messages + current message
   + order products`) and run `retrieve()` on it. If the price/brand/policy
   document is missing, the model was asked to answer without evidence.
2. A short or vague message (`Hi em`, `ok`, `còn gì nữa`) matches no product
   keyword on its own. Retrieval used to fall through to the catalog filler and
   return only `category-*` documents — names without prices — so the bot said
   "em chưa có dữ liệu giá" and the reviewer rejected it. Fixed by including
   `payload.order.products` in the query in `src/worker.mjs`.
3. Facts that live in `policy-*` documents (VAT, shipping) can be stated in a
   turn where no keyword matches them, so `retrieve()` now pins policy documents
   into every context.
4. A handoff parks the conversation in `WAITING` for `waitingResetSeconds`
   (300s), then `auto_reset_waiting` returns it to `BOT`. Any customer message
   arriving inside that window is `cancelled` and **never answered** — check
   `jobs` for `cancelled` rows before blaming the model.
5. The turn in progress must win its context slots. `primary` merges the last
   three customer messages, so a heavier previous topic can fill all five slots
   and push out the document for the product just asked about: after a
   conversation about ba chỉ bò, "Sụn non bên em xuất xứ từ đâu?" retrieved five
   ba chỉ bò documents (score 3) and dropped sụn non (score 2), so the bot said
   the origin was missing. `src/worker.mjs` therefore runs a separate pass for
   the current message and keeps up to three of its documents at the front
   (matched only, score > 0, so a bare "Hi em" takes no slot).
   `test/context-priority.test.mjs` reproduces it: it fails with the pass removed
   and passes with it. Measure before changing it:
   ```bash
   node --test test/context-priority.test.mjs
   ```
   If documents are still missing, print the retrieval for the exact bundle
   (`last 3 customer messages + current message`) and compare scores — do not
   assume the model is at fault.

**Bot answers about the wrong product.** `retrieve()` scores keyword hits against
the query. It used substring matching, so short keywords matched inside unrelated
words: keyword `Úc` (normalize → `uc`) matched the query `mực ống làm sạch`, every
Úc-origin product tied with the one actually asked about, and the real document was
pushed out of the top 5 — the bot answered about ba chỉ bò for a mực ống question.
Matching is now whole-word (`includesWord` in `src/knowledge.mjs`). If products
from one origin start crowding answers that mention an unrelated product, suspect
this class of bug: score a query with a throwaway script against the live
`knowledge.json` and print the top docs plus which keywords hit.

To score without guessing:

```bash
node -e '
import("/srv/page-cskh/app/src/knowledge.mjs").then(({retrieve})=>{
  for(const q of ["mực ống làm sạch giá bao nhiêu"]) 
    console.log(q, retrieve("/srv/page-cskh/runtime/knowledge.json", q).map(d=>d.id+"("+(d.score??0)+")").join(", "));
});'
```

## 5. Deploy

Follow `docs/VPS-BUILD.md`. Order matters: setup refuses to run in `mode=live`,
and it requires the runtime outside the code dir. Start in `draft`, then switch
to `live` and regenerate the config.

## Smoke questions after any KB change

```text
bên mình có sản phẩm gì?
trâu thì có những sản phẩm nào?
ba chỉ bò xuất xứ từ đâu?
ba chỉ bò làm lẩu chọn loại nào?
```

After a price change, add these three — they exercise the tier rules (the first
must return NO price, the other two must return exactly one tier):

```text
cho anh giá ba chỉ bò          -> phải KHÔNG báo giá, hỏi lại khách mua dùng hay mua buôn
nhà anh mua về dùng, giá bao nhiêu?   -> chỉ mức giá mua dùng
bên anh là bếp ăn, lấy 1 thùng, giá bao nhiêu?  -> chỉ giá buôn, mốc từ 1 thùng
```

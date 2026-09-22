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
- **Ask before restarting** the service. A restart drops in-flight jobs.
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
`--check` verifies it.

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

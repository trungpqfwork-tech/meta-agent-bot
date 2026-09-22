# Operations

Start/stop/reload with the destination OpenClaw Gateway's existing service manager.
No independent daemon is installed: plugin registers its lifecycle service.
Runtime config is generated from `.env`. After editing `PAGE_CSKH_*` values that
feed config, run:

```bash
npm run generate-config -- --env /absolute/runtime/.env --out /absolute/runtime/config.json
```

For generated PM2 edge files as well, run:

```bash
npm run deploy-runtime -- --env /absolute/runtime/.env
```

Then restart/reload the component that reads the changed file. Secrets and config
are read at start. KB is read fresh per job. Gateway restarts preserve DB and
human ownership.

For Excel-driven product updates, use `docs/PRODUCT-UPDATES.md`. It defines how
to map spreadsheet columns into runtime product, KB, and image catalog files.
Automated imports should use `npm run import-products -- --preview` first and
only run `--apply` after owner approval. Agent-facing instructions live in
`skills/page-cskh-product-import/SKILL.md`.

Runtime `.env` controls:

- `PAGE_CSKH_MODE=draft|live`: overrides config mode at Gateway service start.
- `PAGE_CSKH_WAITING_RESET_SECONDS=0`: `0` disables auto reset; a positive number
  moves `WAITING` conversations back to `BOT` after that many seconds.
- `PAGE_CSKH_MESSAGE_DEBOUNCE_SECONDS=2`: `0` disables debounce; a positive
  number waits for that many quiet seconds and folds rapid customer messages
  into one job/reply.
- `PAGE_CSKH_ENABLE_HUMAN_HANDOFF=true|false`: when `false`, model handoff
  decisions are logged and answered with the clarify text, but the conversation
  stays in `BOT` for test-heavy runs.
- `TELEGRAM_BOT_TOKEN` and `PAGE_CSKH_ORDER_TELEGRAM_CHAT_IDS=["123","456"]`:
  when set, every order that reaches `status='ready'` is sent once to each
  configured Telegram chat id. Leave the array empty to disable notifications.
- `PAGE_CSKH_EDGE_PORT=18892`: local loopback port for the PM2 webhook edge.
  Public HTTPS must proxy the webhook path to this port, never to admin or the
  full Gateway.
- `PAGE_CSKH_IMAGE_DIR=./images` and
  `PAGE_CSKH_IMAGE_CATALOG_FILE=./images/catalog.json`: runtime product image
  storage and metadata. Edit the catalog to add/remove image availability; it is
  read per job like KB. Moving the path needs config regeneration and Gateway
  restart.

## Webhook PM2 edge

`page-cskh-edge` is the public webhook door:

```text
Meta/domain -> 127.0.0.1:${PAGE_CSKH_EDGE_PORT} PM2 edge -> 127.0.0.1:18789 Gateway
```

Use it to trace webhook delivery:

```bash
pm2 ls
pm2 logs page-cskh-edge --lines 100
tail -f /absolute/runtime/logs/edge.log
```

Expected message flow in PM2 logs:

```text
REQUEST method=POST path=/webhooks/page-cskh ...
POST body raw=...
POST ok ... text="..."
POST upstream status=200
```

If PM2 shows no `REQUEST`, Meta/domain did not reach this machine. If PM2 shows
`POST sig_fail`, App Secret does not match the Meta app sending the webhook. If
PM2 shows `POST upstream status=200` but no reply, debug Gateway/worker:

```bash
tail -f /absolute/runtime/agent/logs/worker.log
journalctl --user -u openclaw-gateway.service --since '10 minutes ago'
```

Restart boundaries:

- Edge code, `.env` App Secret/verify token, `edge.json`, or PM2 config:
  `pm2 restart page-cskh-edge`.
- Worker, typing, model behavior, generated `config.json`, or handoff settings:
  restart/reload OpenClaw Gateway.

Open `http://127.0.0.1:18891/` (or configured adminPort). Enter the admin token
privately in the browser. It is not persisted to localStorage. Click refresh to
inspect waiting conversations and jobs; no background notification channel is wired.

```bash
npm run operator -- --config /absolute/runtime/config.json status
npm run operator -- --config /absolute/runtime/config.json takeover 123456
npm run operator -- --config /absolute/runtime/config.json resume 123456
```

Takeover locks before staff reply. Resume allows future incoming messages; it does
not replay pending/draft jobs. Review history before giving back to the bot.

## Order intake

The bot can collect order details while continuing normal CSKH conversation. Order
state is persisted in the runtime SQLite database, table `orders`, keyed by PSID.
Each order tracks:

- `customer_type`: `store` or `personal`
- `customer_name`
- `phone`
- `address`
- `products`: JSON array of requested products/quantities/needs
- `status`: `collecting` until all required fields are present, then `ready`
- `notified_at`: Telegram notification timestamp, `0` until successfully sent

The model writes the customer-facing text; code only extracts/stores structured
fields. If a customer wants to order, the bot should first identify whether they
are a store/business buyer or a personal buyer, then ask naturally for missing
fields. When Telegram notification env values are configured, a ready order is
sent once to every chat id in `PAGE_CSKH_ORDER_TELEGRAM_CHAT_IDS`; later
workflows can also read `orders` and process rows with `status='ready'`.

## Ambiguous send

If delivery status is unknown, inspect the actual Messenger conversation. Do not
automatically retry: Meta may have accepted the first request before a timeout.

```bash
npm run operator -- --config /absolute/runtime/config.json reconcile JOB_UUID sent
# OR, only after verifying it did NOT send:
npm run operator -- --config /absolute/runtime/config.json reconcile JOB_UUID not-sent
```

Reconcile only records the observed outcome, never resends. Then resume explicitly.
During recovery in-flight agent jobs are interrupted and queued jobs for those
conversations are canceled. Unrelated pending jobs remain queued.

## Troubleshooting

- 503 webhook: plugin not ready, env/config invalid, DB unavailable, or service stopped.
- 403 webhook: signature invalid or GET verify token mismatch; do not disable checks.
- No draft: wrong Page subscription, app test permissions, HUMAN/WAITING state, model
  unavailable, empty KB, or request rejected. Inspect doctor/status, not raw secrets.
- All replies handoff: model runtime may not support tool-free `complete`, or the
  configured model is not returning schema-valid JSON. Prove with a test Page.
- Env error: file mode 600, outside workspace, required keys set, service user can read.
- Lock exists: check PID and runtime owner; don't remove a live runtime's lock.
- Port collision: change adminPort then reload; do not kill unknown listeners.
- Page token mismatch in live: configure the correct Page token, never relax probe.

API accepted/sent is not evidence the customer read it. Delivery/read receipts are
ignored in v0.1; UI must not claim delivered/read.

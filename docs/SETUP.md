# Setup

## 1. Preconditions

- Node >=24.16, qualified OpenClaw 2026.9.4; npm; reachable Gateway.
- A model provider already configured on the destination OpenClaw. Configure any
  missing credentials through OpenClaw's masked terminal flow, not chat.
- Meta app with Messenger, Page access, appropriate permissions and app access
  for intended users. Test-mode access is not production approval.
- A public HTTPS endpoint with a valid certificate and stable hostname.

## 2. Runtime directory and config

Choose an absolute private directory such as `/srv/page-cskh-runtime` or a private
directory under the service user's home, outside agent workspaces. Restrict its
permissions to the service user. Runtime `config.json` should be generated from
the private `.env`; do not hand-maintain secret-adjacent runtime values in the
repository checkout.

Create secrets with:

```bash
node scripts/init-env.mjs /absolute/runtime/.env
```

The terminal masks App Secret and Page Access Token. Verify Token and local Admin
Token are generated randomly; view them only in a private editor/terminal to
configure Meta or open the console. Do not send their values to an assistant.
On POSIX `.env` must have mode 600. The plugin explicitly parses this file on
service start, without `source`, global env injection, or a shell rc edit.

Fill the non-secret `PAGE_CSKH_*` values in `.env`, then generate config:

```bash
npm run generate-config -- --env /absolute/runtime/.env --out /absolute/runtime/config.json
```

For clean deployments, prefer the full runtime generator. It creates generated
`config.json`, `edge.json`, PM2 runner/ecosystem files, agent workspace
templates and the starter knowledge file from `.env`:

```bash
npm run deploy-runtime -- --env /absolute/runtime/.env
```

After reviewing the generated paths, run the same command with actions enabled:

```bash
npm run deploy-runtime -- --env /absolute/runtime/.env \
  --apply --start-pm2 --pm2-save --restart-gateway
```

`config.example.json` documents the generated JSON shape, source env var names
and enum-style allowed values. Review the supported Graph API version in your
Meta dashboard; `v25.0` is an example, not an evergreen guarantee. Relative
env/database/workspace/knowledge paths resolve from the generated config file.

Runtime behavior is controlled from `.env`: `PAGE_CSKH_MODE=draft|live` selects
draft or real sends at service start. Set
`PAGE_CSKH_WAITING_RESET_SECONDS` to a positive integer to automatically move
`WAITING` conversations back to `BOT` after that many seconds. Set
`PAGE_CSKH_MESSAGE_DEBOUNCE_SECONDS` to a positive integer to wait for a quiet
period before creating a model/reply job, so rapid multi-message customer input
is folded into one bot reply. Set it to `0` to disable debounce. Set
`PAGE_CSKH_ENABLE_HUMAN_HANDOFF=false` in test environments when the agent should
keep bot ownership instead of actually parking a conversation in `WAITING` after
a handoff decision.

`PAGE_CSKH_EDGE_PORT` controls the local webhook-only PM2 edge port. The public
domain must reverse proxy only `PAGE_CSKH_WEBHOOK_PATH` to
`127.0.0.1:${PAGE_CSKH_EDGE_PORT}`. `PAGE_CSKH_ADMIN_PORT` is private operator
console only and must not be exposed publicly.

## 3. Setup

```bash
npm run setup -- --config /absolute/runtime/config.json
npm run setup -- --config /absolute/runtime/config.json --apply
npm run doctor -- --config /absolute/runtime/config.json
openclaw plugins inspect page-cskh --runtime --json
```

First command is a read-only plan. Apply installs the reviewed local plugin
(with `--force --accept-capabilities` to acknowledge its local source, replacement
and declared runtime capabilities),
creates only missing template files, snapshots touched config paths and uses
OpenClaw's validated merge patch. Existing unmanaged agent/workspace causes a
failure rather than overwrite. Repeated setup retains edited KB and template files.

OpenClaw's plugin loader owns SDK resolution. To transport: run `npm pack`, copy the
tarball to destination, extract it to a reviewed local project directory and follow
START_HERE. Alternatively install the tarball through OpenClaw's `npm-pack:` path;
retain the extracted scripts/docs for setup and operation.

If no Gateway is running, start it using the destination's existing service setup.
Never replace crontab/systemd/nginx wholesale. Inspect and merge required changes.

## 4. PM2 edge and HTTPS route

Webhook ingress is a separate PM2 process named `page-cskh-edge`. It verifies
Meta signatures, writes PM2-readable request logs, and forwards only valid
webhook traffic to the local Gateway. Gateway owns ingestion, worker processing,
typing indicators, handoff state and Messenger replies.

Inspect it with:

```bash
pm2 ls
pm2 logs page-cskh-edge --lines 100
ss -ltnp | grep "$(grep '^PAGE_CSKH_EDGE_PORT=' /absolute/runtime/.env | cut -d= -f2-)"
```

Reverse proxy only the exact configured webhook path to the PM2 edge port. Do
NOT proxy the whole Gateway, Control UI, or local admin listener publicly.
Example location block to merge into an existing HTTPS server:

```nginx
location = /webhooks/page-cskh {
    proxy_pass http://127.0.0.1:18892;
    proxy_set_header Host $host;
    client_max_body_size 1m;
    proxy_read_timeout 10s;
}
```

TLS/server block creation is environment-specific and not performed by setup.
Configure edge request limits and disable query/body logging for this route:
the GET verification query contains the verify token. Ensure raw POST bytes are
not transformed before signature verification. Only GET/POST are accepted.

Cloudflare Quick Tunnel is for local testing only. Production/staging machines
should use their real domain and reverse proxy to `PAGE_CSKH_EDGE_PORT`.

## 5. Meta

In the app's Messenger webhook configuration, enter publicWebhookUrl and the
Verify Token from the destination `.env`. Subscribe the intended Page to message
and postback events; enable relevant echo events supported by the app/API version.
Verify actual Page subscription and test-account eligibility in Meta.

```bash
npm run verify -- --config /absolute/runtime/config.json --meta
```

This probes token identity; it does not send a message or prove webhook subscription.
Send a test message from your test Facebook account and inspect draft output locally.
Meta UI labels, approval and event availability can vary; validate with current Meta
docs and real event payloads, not assumptions from an old tutorial.

## 6. Knowledge and activation

Edit knowledge.json. Every approved document needs a unique id, title, keywords,
content, `approved:true`, and optionally an ISO validUntil timestamp.
MVP retrieval is accent-insensitive keyword matching; supply synonyms. It is not
a vector database. Unsupported/expired information causes clarification/handoff.
Knowledge reloads each job; config/env changes need service restart/reload.

Run ACCEPTANCE.md. Only then set `PAGE_CSKH_MODE=live` with the owner's
authorization and restart/reload the plugin. Old drafts are NEVER auto-sent when
switching live.

## Primary references

- https://docs.openclaw.ai/plugins/building-plugins
- https://docs.openclaw.ai/plugins/sdk-runtime/background-work
- https://docs.openclaw.ai/cli/config
- https://docs.openclaw.ai/cli/agents
- https://developers.facebook.com/docs/messenger-platform/webhooks
- https://developers.facebook.com/docs/messenger-platform/send-messages

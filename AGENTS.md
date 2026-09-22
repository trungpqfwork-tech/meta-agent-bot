# Repository instructions

Read `START_HERE.md` before installing or deploying, and `docs/VPS-BUILD.md` for
the verified build path. This is repository-owned source for a standalone CSKH
service that uses Hermes only as a completion runtime.

## Security invariants (never weaken these)

- Customer completions get **no tools**: `enabled_toolsets=[]`, `skip_memory`,
  `skip_context_files`, and no recipient, Meta secrets or admin token in the
  payload. Customer messages are untrusted input from strangers.
- **SQLite is the only durable customer memory.** Never use Hermes memory,
  sessions or profile files to store Facebook customer history, PSIDs, orders or
  operator notes.
- Page + PSID routing is decided by the service, never by the model. Takeover
  increments the conversation version. There is no automatic resend after an
  ambiguous send.
- `.env` is never exported to `process.env` of a child, never passed to the model
  and never logged. Keep it mode 600 — `loadSecrets()` asserts it.
- `mode=draft` sends nothing. Only `approved: true` KB documents may support a
  reply.
- One live sender per Page. Never run two instances against the same Page, and
  never copy a running SQLite without stopping the writer or checkpointing WAL.

## Repo vs runtime

Code lives in the repo and ships with `git archive`. Runtime data (`.env`,
`config.json`, `data/`, `knowledge.json`, `products.json`, `images/`, `agent/`,
`logs/`) lives **outside** the repo and is gitignored — never commit it, and
never package credentials, customer messages or local absolute paths.

Ports in `.env` are only read when `config.json` is generated
(`scripts/generate-config.mjs`); at runtime `applyEnvOverrides` honours only
`PAGE_CSKH_MODE`, `PAGE_CSKH_WAITING_RESET_SECONDS`,
`PAGE_CSKH_MESSAGE_DEBOUNCE_SECONDS`, `PAGE_CSKH_ENABLE_HUMAN_HANDOFF` and
`PAGE_CSKH_ORDER_TELEGRAM_CHAT_IDS`. `setup-hermes.mjs` refuses to run unless
`mode=draft`.

## Admin agent

`.agents/skills/page-cskh-admin/` is the operating procedure for the admin agent
(KB updates, behaviour changes, conversation ops, diagnostics, deploy). It loads
for any agent whose working directory is this repo once the repo is trusted:

```bash
hermes skills trust <repo root>      # enables ./.agents/skills and ./.hermes/skills
scripts/setup-admin-agent.sh         # per-host profile + trust + terminal.cwd
scripts/setup-admin-agent.sh --check # verify profile, trust and cwd
```

If the owner can only chat with a Hermes agent on the VPS, that agent may run the
same script via its terminal tool after the code is deployed:

```text
cd /srv/page-cskh/app
bash scripts/setup-admin-agent.sh
bash scripts/setup-admin-agent.sh --check
```

This is still a bootstrap step: it requires an already-running Hermes/gateway
agent with terminal access. It is not automatic if no Hermes process exists yet.

Both mechanisms are cwd-scoped: the profile's `terminal.cwd` must be an absolute
path to the repo, otherwise AGENTS.md and the project skill silently do not load
(the relative default `.` resolves to the Hermes home, not the launch dir).

The admin agent may operate the runtime dir, but must ask before restarting the
service, preview before applying KB changes, and never print secrets. Customer
messages must never reach it: there is no path from the Meta webhook to the
admin agent.

## Before declaring a change done

```bash
npm run check     # syntax + JSON checks
npm test          # node --test test/*.test.mjs
```

Report evidence (command output, counts, ports), not assumptions. Do not delegate
unless the user explicitly asks. Do not modify another profile's
skills/plugins/cron/memories.

# Security model

## Secrets

Required `.env`: META_APP_SECRET, META_WEBHOOK_VERIFY_TOKEN,
META_PAGE_ACCESS_TOKEN, CSKH_ADMIN_TOKEN. No Facebook password/cookies.
Model credentials belong to destination OpenClaw provider config, not this package.
App Secret verifies HMAC SHA256 over raw POST bytes. Verify Token serves only GET
handshake. Page token is used only for Graph requests. Admin token protects localhost
operator APIs. Tokens are not supplied to completion inputs, log messages or runtime
process.env. Env must be outside agent workspace and mode 600 on POSIX.

This does not defend against the OS account owner, another privileged plugin, a
compromised Gateway, root, or agents with unrestricted host tools. For stronger
isolation run the whole public-facing OpenClaw under a separate OS user/container
from the personal assistant. Per-agent workspace is not an OS security boundary.

## Routing and ownership

Only the configured numeric Page is accepted. Customer PSID and Page come from
verified transport, never text or model output. Model output is projected to an
allowlisted answer shape, no recipient/tool calls. Outbox route is immutable job
data. Ownership version fences old results. Unknown external Page messages pause
the bot; this is conservative and can include other apps, not just staff.

Echo arriving before Send API returns may cause a conservative HUMAN pause because
the message ID is not yet known locally. This is preferable to a false BOT decision.
No system can recall a request already sent to Meta; staff should press Takeover
before typing in Business Suite. Echo detection must be proved with the actual Page.

## Knowledge and model

Complete uses a fresh tool-free inference under the configured agent's model/auth.
The plugin supplies explicit policy and scoped recent history and documents. No
customer session memory lookup, read tools, terminal, browser or generic send tools.
The default agent config denies all tools even for accidental direct invocation.
Knowledge is administrator-authored only; customers cannot write or approve it.
Source IDs are mechanically checked; semantic grounding/scope are model checks,
not a security proof. Use adversarial tests and monitor quality before enabling live.
Structured parsing failures, unavailable runtime, KB errors or exhausted daily/hourly
model-call caps lead to handoff. Caps count both drafting and verification calls.

## Storage and operations

SQLite stores customer content, drafts, audit events and route IDs in plaintext on
the local protected filesystem. Retention/deletion automation and disk encryption
are not implemented. Set operational retention, restricted backups and encryption
appropriate to your installation. Do not expose status/history unauthenticated.

Admin listener binds loopback, checks Host, requires bearer token for every data or
mutation API, has no permissive CORS and uses textContent for customer display.
Use SSH tunneling for remote operators. No multi-user accounts/roles in this MVP.
Public ingress is limited to 1 MiB; deployment must add edge rate limits to protect
disk/CPU. A call budget does not prevent webhook disk flooding.

The local lock prevents simultaneous owners on one host. Shared/network filesystems,
multi-host DB writers and active-active deployments are unsupported.

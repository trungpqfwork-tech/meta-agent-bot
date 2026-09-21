# Acceptance gates

## Automated

`npm run check && npm test` tests routing, HTTP signature/challenge, dedup, isolated
histories, takeover while a model call runs, handoff, timeout reconciliation, restart,
Page token binding, env mode, local admin auth, scope/citation checks and call caps.
Mock models and Meta do not constitute real model/Meta proof.

## Isolated host install

Run `npm run smoke:install` on Linux with the target OpenClaw host and `tar` available.
It packs/extracts the project, sets up twice in a new temp state directory, proves
existing-agent/KB preservation, runs an actual isolated Gateway and a local mock
OpenAI-compatible model, signs an inbound event, verifies scoped draft output and
takeover, then stops its processes. Evidence is kept in the printed temp directory.
It uses no real Meta/model credential and does not alter the active OpenClaw config.

Use a clean OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH, private temp runtime and
distinct loopback Gateway/admin ports. Install the packed artifact, run setup twice,
validate config and inspect plugin runtime. Confirm unrelated agent settings survive.
Start the isolated Gateway and exercise a signed synthetic webhook. Never reuse
the owner's production token, active config, Page routing or service ports.

## Real Page — mandatory before live

- Valid GET verification through public HTTPS; signed real inbound event appears once.
- Correct Page token probe and required app access for intended customer accounts.
- Two real test accounts (including matching display names), interleaved messages:
  each answer is in the correct Messenger conversation and never contains other's data.
- Approved FAQ question produces a supported draft with source ID; unrelated coding,
  politics and prompt-injection requests do not get general-purpose answers.
- Follow-up/thank-you/complaint/ambiguous questions are handled appropriately.
- Unknown price/stock/exception → WAITING; one handoff notice in live test mode.
- Press Takeover during slow model response → late answer not sent.
- Reply in Business Suite → actual echo is received and HUMAN set; document latency
  and any conservative false pauses before enabling unattended operation.
- Restart with HUMAN active → remains HUMAN. Old drafts are never auto-sent.
- Attachment-only message goes to a human (no image/voice support in MVP).
- Out-of-window message cannot trigger a send; API errors/timeouts require review.
- Observe console on desktop/mobile and verify takeover/resume controls.

Approval must identify the Page and permit live sending. Retain a dated operator
acceptance record outside the distributable package, without secrets.

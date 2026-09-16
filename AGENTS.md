# Repository instructions

Read START_HERE.md before installation. This is repository-owned source, not a
Skill Workshop package. Do not modify the developer's active OpenClaw config to test.
Use an isolated OPENCLAW_STATE_DIR + OPENCLAW_CONFIG_PATH and separate loopback ports.
Do not delegate unless the user explicitly requests delegation.

Security invariants: Page+PSID route is captured by the plugin, never model-selected;
takeover increments version; no automatic resend after ambiguous network failure;
no tools in customer completions; `.env` never passed into process.env/model/logs;
draft sends nothing; only approved non-expired KB documents may support replies.

After changes run npm run check and npm test. Test the actual packed artifact on an
isolated OpenClaw host. Update STATUS.md with evidence, not assumptions.
Never package credentials, runtime databases, customer messages or local absolute paths.

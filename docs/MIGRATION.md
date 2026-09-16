# Distribution, migration and rollback

## New independent installation

Run `npm pack`; copy the versioned tgz and checksum. Extract, inspect START_HERE.md,
then setup with destination config/env/KB. No dependency on the development host.
Never distribute `.env`, live DB, personal memory or auth stores with the software.
Tarball includes runtime JS and all deployment docs/scripts; no transpilation needed.

## Moving the same Page

1. Pause bot and stop old plugin/Gateway worker before transferring ownership.
2. Stop DB writer; back up DB consistently (including WAL checkpoint or SQLite backup).
   Copying only the main SQLite file while running is unsafe.
3. Transfer needed KB and DB through a private channel; transfer/reissue secrets
   separately. Keep Page ID unchanged. Do not copy stale PID lock.
4. Configure fresh destination agent/workspace/model paths, start in draft.
5. Change public routing/webhook to the new runtime only when old sender is stopped.
6. Verify human ownership, local queue and webhook on the destination, then enable live.

This is an operational runbook, not automated live migration. Credentials and host
provider setup are not copied automatically. Native OpenClaw sessions need not move:
conversation context is in the plugin DB in this MVP.

## Upgrade/rollback

Pin package and host versions. Back up runtime config, approved KB and stopped DB
before upgrade. Setup snapshots only touched agent/plugin config values; OpenClaw
plugin install may also update plugin allowlist/install metadata. Inspect those diffs.
Do not restore an entire old OpenClaw config over unrelated changes.

Disable page-cskh first, reinstall the previous reviewed package, restore compatible
DB/config if a migration requires it, then verify in draft. Current schema is v1;
unknown schemas fail closed. Do not downgrade a future schema without a migration.

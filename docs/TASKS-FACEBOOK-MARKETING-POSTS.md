# Tasks — Facebook marketing posts

Task list for implementing `docs/FACEBOOK-MARKETING-POSTS.md` in one complete delivery. Do not enable real publishing by default.

## 0. Pre-flight

- [x] Re-read `START_HERE.md`, `docs/SECURITY.md`, `docs/OPERATIONS.md`, and `docs/FACEBOOK-MARKETING-POSTS.md`.
- [x] Confirm working tree status before editing code.
- [x] Identify the runtime config used for manual testing, but do not print secrets.
- [x] Add tests before or alongside each source change.

## 1. Config and env

- [x] Add env parsing in `src/config.mjs`:
  - `PAGE_CSKH_ENABLE_MARKETING_POSTS`
  - `PAGE_CSKH_MARKETING_APPROVAL_REQUIRED`
  - `PAGE_CSKH_MARKETING_MAX_POSTS_PER_DAY`
  - `PAGE_CSKH_MARKETING_DEFAULT_TONE`
  - `PAGE_CSKH_MARKETING_TIMEZONE`
  - `PAGE_CSKH_MARKETING_QUIET_HOURS`
- [x] Add optional secret handling for `META_PAGE_PUBLISH_ACCESS_TOKEN` without making it required.
- [x] Validate defaults are safe: disabled, approval required, max 3/day, timezone `Asia/Ho_Chi_Minh`.
- [x] Reject unsupported/unsafe config values.
- [x] Update `scripts/init-env.mjs` with commented marketing env defaults.
- [x] Update `config.example.json` with generated marketing config shape.
- [x] Test config defaults and invalid values.

## 2. Store schema and methods

- [x] Add `fb_posts` table migration in `src/store.mjs`.
- [x] Add `fb_post_audit` table migration in `src/store.mjs`.
- [x] Add methods:
  - `createMarketingPost(draft)`
  - `marketingPost(id)`
  - `listMarketingPosts(filters)`
  - `updateMarketingPost(id, patch)`
  - `approveMarketingPost(id, approvedBy)`
  - `scheduleMarketingPost(id, scheduledAt, approvedBy)`
  - `reserveMarketingPublish(id)`
  - `markMarketingPublished(id, receipt)`
  - `markMarketingFailed(id, error)`
  - `markMarketingUnknown(id, detail)`
  - `cancelMarketingPost(id, reason)`
  - `reconcileMarketingPost(id, outcome)`
  - `marketingPostsDue(now, limit)`
  - `marketingPublishedCountForDay(dayStart, dayEnd)`
- [x] Add defensive JSON parsing helpers for hashtags/media/source_ids/risk_flags.
- [x] Ensure stale `publishing` rows can be moved to `unknown` on startup.
- [x] Test state transitions and terminal-state guards.

## 3. Meta publishing client

- [x] Extend `src/meta.mjs` or add wrapper for publishing methods:
  - `probePostPermissions()`
  - `publishFeedPost({message, link, scheduledAt})`
  - `publishPhotoPost({caption, imageUrl, filePath, scheduledAt})`
  - `readPost(postId)`
- [x] Use `META_PAGE_PUBLISH_ACCESS_TOKEN` when present; otherwise use `META_PAGE_ACCESS_TOKEN`.
- [x] Keep Messenger send behavior unchanged.
- [x] Sanitize Meta errors before returning/storing.
- [x] Require readback permalink before success.
- [x] Test endpoints, request bodies, token selection, failures, and readback.
- [x] Compose the published text as caption + hashtags (`composePostMessage`); previously hashtags stayed in the DB column and never reached Facebook.
- [x] Resolve `media[].image_id` to a real catalog entry (public URL or local file) at publish time, falling back to a text post.
- [x] Show score, hashtags, media and the exact publish body in the admin UI list.

## 4. Marketing module

- [x] Create `src/marketing.mjs`.
- [x] Implement draft generation orchestration:
  - load approved KB docs;
  - load approved image catalog records;
  - build marketing-only prompt;
  - call existing Hermes completion runner without secrets/tools;
  - parse strict JSON;
  - validate caption, hashtags, media, source ids, risk flags.
- [x] Implement publish orchestration:
  - feature enabled check;
  - service mode check;
  - approval check;
  - daily limit check;
  - quiet-hours check for scheduled publish;
  - reserve row;
  - call Meta publisher;
  - readback;
  - update status/audit.
- [x] Implement scheduler tick function with no infinite loop in tests.
- [x] Implement startup recovery for stale `publishing` rows.
- [x] Test generation validation, publish guards, due scheduler behavior, and ambiguous publish handling.

## 5. Admin API and UI

- [x] Add loopback/admin-token protected routes in `src/admin.mjs`:
  - `POST /marketing/draft`
  - `GET /marketing/posts`
  - `GET /marketing/posts/:id`
  - `POST /marketing/posts/:id/regenerate`
  - `POST /marketing/posts/:id/edit`
  - `POST /marketing/posts/:id/approve`
  - `POST /marketing/posts/:id/schedule`
  - `POST /marketing/posts/:id/publish`
  - `POST /marketing/posts/:id/cancel`
  - `POST /marketing/posts/:id/reconcile`
  - `GET /marketing/permissions`
- [x] Keep existing takeover/resume/reconcile APIs unchanged.
- [x] Add minimal admin HTML section:
  - list marketing posts;
  - show caption preview;
  - buttons for approve, publish now, cancel;
  - show permalink/status/error.
- [x] Ensure admin UI uses `textContent`, not raw HTML injection.
- [x] Test unauthorized access, route behavior, and no public webhook access to marketing actions.

## 6. Service integration

- [x] Wire marketing module in `src/index.mjs`.
- [x] Start scheduler only when `marketing.enabled=true`.
- [x] Keep one scheduler inside the single service instance.
- [x] Make scheduler stoppable during service shutdown.
- [x] Ensure no customer job path imports or invokes marketing publishing.
- [x] Test service startup with marketing disabled and enabled.

## 7. Docs updates

- [x] Update `docs/SETUP.md` with marketing env values and Meta permissions.
- [x] Update `docs/OPERATIONS.md` with admin publish/schedule/reconcile operations.
- [x] Update `docs/SECURITY.md` with publishing token separation and approval gate.
- [x] Update `docs/ACCEPTANCE.md` with marketing acceptance tests.
- [x] Update `README.md` feature list only after implementation is working.

## 8. Verification

- [x] Run `npm run check`.
- [x] Run `npm test`.
- [x] Run a local mocked admin flow:
  - create draft;
  - approve;
  - publish with mocked Meta;
  - verify status `published` and permalink stored.
- [ ] Run token permission probe against real Meta token without printing secrets.
- [ ] Do not publish to the real Page until owner explicitly approves a real test post.

## 9. Real Page test, only with explicit owner approval

- [ ] Confirm Page: `TM Food` / configured Page ID.
- [ ] Confirm token has `pages_manage_posts`.
- [ ] Create a clearly marked test draft.
- [ ] Owner approves exact caption.
- [ ] Publish once.
- [ ] Read back post id and permalink.
- [ ] Record result and any cleanup action.

## 10. Facebook SEO content skill

- [x] Create `.agents/skills/facebook-seo-content/SKILL.md` (hard rules, caption structure, 10-point rubric, rewrite procedure, pitfalls, verification).
- [x] Embed the same rubric in `marketingPrompt()` so the model self-checks before returning JSON.
- [x] Rewrite `scoreMarketingSeo()` (now `src/seoscore.mjs`) to the rubric (hook, product keyword, evidence, audience, CTA, 3-6 hashtags, approved image, local/context, safety).
- [x] Apply caps: no approved image ≤ 6/10, no grounded evidence ≤ 5/10, risky claim without source ids ≤ 3/10.
- [x] Show score and "Cần cải thiện" items in the Telegram preview.
- [x] Add tests for score caps and preview rendering.
- [x] Reference the skill from `AGENTS.md` so the admin agent loads it.

## 11. Score gate and anti-AI voice

- [x] Add `marketing.minScore`, `marketing.reviseAttempts`, `marketing.lowScoreAction` with env vars `PAGE_CSKH_MARKETING_MIN_SCORE`, `PAGE_CSKH_MARKETING_REVISE_ATTEMPTS`, `PAGE_CSKH_MARKETING_LOW_SCORE_ACTION`.
- [x] Validate the gate: 0-10, revisions 0-3, action `warn|hold`, and reject a gate above 6/10 that can never change behavior.
- [x] Rewrite below the gate up to `reviseAttempts` times, feeding the rubric failures back to the model, keeping the best-scoring draft.
- [x] Flag a still-below-gate post with `low_seo_score_<n>`; `warn` sends the preview with a warning, `hold` skips the Telegram preview.
- [x] Move the scorer to `src/seoscore.mjs` and add `detectAiTells()` for AI-sounding copy (ported from the `humanizer` skill).
- [x] Rewrite `marketingPrompt()` for a human voice: varied sentence rhythm, concrete facts, allowed uncertainty, no ad clichés, no em dash, no decorative emoji, no forced lists.
- [x] Show the gate and the below-threshold state in the Telegram preview and the admin UI.
- [x] Test the gate (rewrite, best-draft wins, hold, pass) and the AI-tell detection.

## 12. Auto-topic + live Page style learning

- [x] Add Meta `listPublishedPosts()` using `/{page-id}/published_posts` so the service can read its own recent Page posts as style references.
- [x] Add `createAutoDraft()` to choose a KB-backed topic first, then generate a normal `pending_approval` draft using recent Page posts for style only.
- [x] Add admin API/UI entry point `POST /marketing/auto-draft` / "Tự chọn chủ đề + viết draft".
- [x] Keep facts bounded to approved KB/source ids; old Page posts may shape format/voice/hashtags but not factual claims.
- [x] Test published-post reading and the auto-draft two-step flow.

## Completion report format

When done, report:

- files changed;
- tests run and pass/fail counts;
- whether real Meta permissions were probed;
- whether any real post was published;
- what remains unverified.

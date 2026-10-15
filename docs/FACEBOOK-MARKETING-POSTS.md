# Facebook marketing posts

This document defines the one-shot implementation plan for an admin-only workflow where Hermes writes Facebook Page posts, stores drafts, waits for owner approval, publishes through Meta Graph API, verifies the published post, and audits every action.

## Goal

Add a marketing publishing workflow for the configured Facebook Page.

The workflow must support:

- owner asks the admin agent/admin API to write a post, or asks the service to auto-pick a topic from approved KB;
- service can read the Page's own `published_posts` to learn format/voice/hashtags from real posts;
- service generates a Page-safe draft from approved internal data;
- draft is stored in SQLite and shown to the owner;
- owner can regenerate, edit, approve, schedule, publish now, cancel, or reconcile;
- service publishes approved posts to the Page through Meta Graph API;
- service reads the created post back from Meta and stores the permalink;
- every state change is audited.

This is an admin workflow, not a customer-CSKH workflow.

## Non-negotiable boundaries

- Customer completions still get no tools, no Meta/admin secrets, no recipient, no Hermes memory, no native Hermes session state.
- Page publishing is decided only by service code and admin-authenticated endpoints, never by customer text or model output alone.
- Marketing drafts and audits live in the service SQLite database, not Hermes memory/profile/session files.
- Existing Page posts are used only as style references. Facts for a new post must come from approved KB/source ids, never from old post copy.
- Meta tokens are never sent to Hermes completion input, logs, admin preview text, or customer-facing text.
- No post is published unless approval is recorded first.
- No automatic blind retry after an ambiguous Meta publish. Read back or reconcile explicitly.
- `PAGE_CSKH_MODE=draft` must block real publishing unless a future explicitly named marketing test mode says otherwise.
- The feature is disabled by default.

## Existing environment values already available

The current runtime already provides the base values needed to build the feature:

- Page ID: `PAGE_CSKH_PAGE_ID`
- App ID: `PAGE_CSKH_APP_ID`
- Page name: `PAGE_CSKH_PAGE_NAME`
- Graph version: `PAGE_CSKH_GRAPH_VERSION`
- Meta Page token: `META_PAGE_ACCESS_TOKEN`
- App secret: `META_APP_SECRET`
- Admin token: `CSKH_ADMIN_TOKEN`
- Model: `PAGE_CSKH_MODEL`
- Knowledge file: `PAGE_CSKH_KNOWLEDGE_FILE`
- Image directory: `PAGE_CSKH_IMAGE_DIR`
- Image catalog: `PAGE_CSKH_IMAGE_CATALOG_FILE`

Before live publishing, verify whether the token has:

- `pages_manage_posts`
- `pages_read_engagement`
- `pages_show_list`

If the existing Messenger token should not be reused for publishing, add a separate token:

```dotenv
META_PAGE_PUBLISH_ACCESS_TOKEN=
```

When this token is set, the publisher uses it for Page post publishing and readback; Messenger replies continue to use `META_PAGE_ACCESS_TOKEN`.

## New configuration

Add these optional `.env` values and generated config fields:

```dotenv
PAGE_CSKH_ENABLE_MARKETING_POSTS=false
PAGE_CSKH_MARKETING_APPROVAL_REQUIRED=true
PAGE_CSKH_MARKETING_MAX_POSTS_PER_DAY=3
PAGE_CSKH_MARKETING_DEFAULT_TONE=thân thiện, chuyên nghiệp, ngắn gọn
PAGE_CSKH_MARKETING_TIMEZONE=Asia/Ho_Chi_Minh
PAGE_CSKH_MARKETING_QUIET_HOURS=22:00-07:00
PAGE_CSKH_MARKETING_MIN_IMAGES=3
```

Generated config shape:

```json
{
  "marketing": {
    "enabled": false,
    "approvalRequired": true,
    "maxPostsPerDay": 3,
    "defaultTone": "thân thiện, chuyên nghiệp, ngắn gọn",
    "timezone": "Asia/Ho_Chi_Minh",
    "quietHours": "22:00-07:00",
    "minImagesPerPost": 3
  }
}
```

Rules:

- Defaults are safe: disabled and approval required.
- `approvalRequired=false` is invalid unless explicitly supported by a later owner-approved change; do not implement auto-publish in the first version.
- `maxPostsPerDay` must be a positive integer.
- `timezone` defaults to `Asia/Ho_Chi_Minh`.
- `quietHours` blocks scheduled auto-publish in that local interval unless an admin command explicitly says to publish during that interval.
- `minImagesPerPost` (1-6, default 3) is the minimum số ảnh mỗi bài. Bài gửi
  Page là album nhiều ảnh, không phải bài một ảnh.

## Admin flow

### Create draft

Owner/admin says something like:

```text
Viết bài giới thiệu combo hải sản cuối tuần, giọng thân thiện, có CTA inbox, đăng tối nay 20h.
```

Service:

1. Authenticates admin request.
2. Loads approved internal data: knowledge, products if available, approved image catalog entries.
3. Calls Hermes with a marketing-only system prompt and no secrets.
4. Requires structured JSON output.
5. Validates output against policy and available data.
6. Stores row in `fb_posts` with `status='pending_approval'`.
7. Writes `fb_post_audit` action `draft_created`.
8. Returns preview with actions.

### Auto-pick topic draft

Owner/admin can also ask the service to pick a topic itself:

```text
Tự chọn chủ đề từ KB và viết một draft theo style Page.
```

Service:

1. Loads approved KB documents and approved image catalog entries.
2. Reads recent Page posts through Meta Graph `/{page-id}/published_posts` when
   the Page publish token permits it.
3. Builds a bounded candidate list from product/category/usage/brand KB docs,
   including whether each candidate appears to have an approved image and whether
   it was posted recently.
4. Calls Hermes once to choose the topic/brief from those candidates. The output
   is only a brief (`topic`, `prompt`, `source_ids`, `reason`), not a publishable
   post.
5. Calls the normal draft generator with that brief plus the recent Page posts as
   style references. Old Page posts are explicitly style-only: facts must still
   come from the chosen KB `source_ids`.
6. Stores the result as a normal `pending_approval` row and sends preview. It is
   never published automatically.

Admin API endpoint: `POST /marketing/auto-draft` with optional
`{ "instruction": "...", "tone": "...", "scheduledAt": 0 }`.

### Nút bấm trên Telegram phải luôn có phản hồi

Mỗi thao tác bấm nút trong tin nháp đều trả về hai lớp phản hồi: toast
(`answerCallbackQuery`) và **một tin nhắn mới trong chat** — vì toast dễ bị bỏ lỡ
hoặc hết hạn. Tin nhắn ghi rõ nháp id, trạng thái mới, và lỗi nếu có:

- Duyệt → `✅ Đã duyệt nháp <id>` + điểm SEO/social, đổi menu còn "Đăng ngay"/"Hủy".
- Hủy → `🚫 Đã hủy nháp <id>`, bỏ toàn bộ nút.
- Đăng ngay → chỉ chạy khi nháp đã `approved`; nếu chưa, bot nhắc duyệt trước.
  Thành công trả permalink, thất bại trả lý do và giữ nút để thử lại.
- Sửa → gửi hướng dẫn `/editpost <id> <caption mới>` kèm caption hiện tại.
- Nháp đã bị xóa hoặc action lạ → cảnh báo, không im lặng.

Hai điều kiện hạ tầng để nút bấm chạy được:

1. Bot gửi preview (bot admin) **phải** có webhook trỏ về
   `${publicWebhookUrl}/telegram`. `scripts/deploy-runtime.mjs` set webhook cho
   cả bot dịch vụ và bot admin; nếu chỉ set bot dịch vụ thì bấm nút không có
   phản hồi nào.
2. `PAGE_CSKH_PUBLIC_WEBHOOK_URL` phải là tunnel còn sống. Quick tunnel đổi URL
   mỗi lần restart, nên sau khi restart tunnel phải cập nhật `.env` rồi chạy lại
   `npm run deploy-runtime ... --apply`. Kiểm tra nhanh:
   `curl -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' ${publicWebhookUrl}/telegram`
   phải trả `403`.

### SEO/content rubric

The marketing prompt in `src/marketing.mjs` (`marketingPrompt()`) embeds a
Facebook SEO/social rubric plus the anti-AI writing rules ported from the
`humanizer` skill (no "nâng tầm / giải pháp / đẳng cấp", no em dash, no
decorative emoji, no "không chỉ ... mà còn", no forced lists, sentence rhythm
must vary). `scoreMarketingSeo()` in `src/seoscore.mjs` scores the stored draft
with the same 10-point rubric: hook, product keyword, grounded evidence,
audience, CTA, 3-6 hashtags, approved image, local context, safety and
naturalness. `detectAiTells()` returns the specific AI-sounding phrases found so
the preview and the rewrite feedback can name them.

Caps keep a weak draft from looking ready:

- no approved image -> at most 6/10;
- no grounded KB evidence -> at most 5/10;
- price/promo/stock claim without `source_ids` -> at most 3/10.

When `marketing.minScore > 0` the draft is scored before it is stored: if it is
below the gate the service rewrites it (up to `marketing.reviseAttempts` times)
with the rubric failures as feedback, keeps the best version, adds a
`low_seo_score_<n>` risk flag when it is still short, and either warns in the
preview (`lowScoreAction=warn`) or withholds the Telegram preview
(`lowScoreAction=hold`). The Telegram preview shows the score, the gate and the
"Cần cải thiện" list, and `.agents/skills/facebook-seo-content/SKILL.md` is the
agent-facing version of the same rubric for the admin agent when it writes or
reviews posts by hand.

### Preview actions

Admin can choose:

- regenerate;
- edit caption/media/schedule;
- approve;
- schedule;
- publish now;
- cancel.

### Approve and schedule

For a scheduled post:

```text
Duyệt bài 27, đăng lúc 20:00 ngày 14/10/2026.
```

Service:

1. Checks the post exists and is not terminal.
2. Records `approved_by`, `approved_at`, `scheduled_at`.
3. Sets `status='scheduled'`.
4. Writes audit actions `approved` and `scheduled`.

### Publish now

For immediate publish:

```text
Duyệt và đăng bài 27 ngay.
```

Service:

1. Records approval if needed.
2. Checks feature is enabled and service mode allows real publishing.
3. Checks daily post limit.
4. Locks the row and sets `status='publishing'`.
5. Calls Meta Graph API.
6. Reads the created post back.
7. Stores `facebook_post_id`, `facebook_permalink`, `published_at`.
8. Sets `status='published'`.
9. Writes audit actions `publishing` and `published`.

### Failed or ambiguous publish

If Meta returns a definite failure:

- set `status='failed'`;
- store sanitized error;
- audit `failed`;
- do not retry automatically.

If the request times out or the process exits after sending but before readback:

- set `status='unknown'` if possible;
- audit `publish_unknown`;
- require admin reconciliation after checking the Page.

Reconcile actions:

- mark as published with a supplied Meta post id/permalink after owner verifies it exists;
- mark as failed/not-published only after owner verifies no post was created.

## State machine

```text
pending_approval
  -> approved
  -> scheduled
  -> publishing
  -> published

pending_approval -> cancelled
approved         -> cancelled
scheduled        -> cancelled
publishing       -> failed
publishing       -> unknown
unknown          -> published
unknown          -> failed
```

Allowed status values:

- `pending_approval`
- `approved`
- `scheduled`
- `publishing`
- `published`
- `failed`
- `unknown`
- `cancelled`

Terminal statuses:

- `published`
- `failed`
- `cancelled`

## SQLite schema

Add tables in `Store` startup migration.

```sql
CREATE TABLE IF NOT EXISTS fb_posts(
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  title_internal TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL,
  hashtags TEXT NOT NULL DEFAULT '[]',
  cta TEXT NOT NULL DEFAULT '',
  media TEXT NOT NULL DEFAULT '[]',
  link TEXT NOT NULL DEFAULT '',
  scheduled_at INTEGER NOT NULL DEFAULT 0,
  approved_by TEXT NOT NULL DEFAULT '',
  approved_at INTEGER NOT NULL DEFAULT 0,
  published_at INTEGER NOT NULL DEFAULT 0,
  facebook_post_id TEXT NOT NULL DEFAULT '',
  facebook_permalink TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  source_ids TEXT NOT NULL DEFAULT '[]',
  risk_flags TEXT NOT NULL DEFAULT '[]',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS fb_posts_status_schedule
ON fb_posts(status, scheduled_at, created);

CREATE TABLE IF NOT EXISTS fb_post_audit(
  id INTEGER PRIMARY KEY,
  post_id TEXT NOT NULL,
  action TEXT NOT NULL,
  at INTEGER NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS fb_post_audit_post
ON fb_post_audit(post_id, id);
```

JSON fields must be parsed defensively and length-limited before storage.

## Meta Graph API publisher

Add publisher methods to `metaClient` or a small wrapper module that uses `metaClient` internals.

Required methods:

- `probePostPermissions()`
- `publishFeedPost({message, link, scheduledAt})`
- `publishPhotoPost({caption, imageUrl, filePath, scheduledAt})` — one image only
- `publishMultiPhotoPost({caption, images, scheduledAt})` — album từ 2 ảnh trở
  lên: upload từng ảnh với `published=false` rồi `POST /{page-id}/feed` kèm
  `attached_media:[{media_fbid:<photo-id>}, ...]`. Ảnh unpublished nên nếu bước
  feed lỗi thì không có ảnh nào lộ ra ngoài.
- `readPost(postId)`

What the publisher sends is composed at publish time, not stored as-is:

- `composePostMessage(caption, hashtags)` appends the draft's hashtags to the
  caption (`\n\n#tag1 #tag2`), de-duplicates them and drops any tag already
  present in the caption. Without this the hashtags stayed in the `fb_posts`
  column and every published post went out without a single hashtag.
- Ảnh của bài được LỌC TRƯỚC khi đưa cho model: `selectPostImages()` chạy
  `imageScores()` (cùng bộ khớp từ khoá/IDF mà CSKH dùng) trên chủ đề + caption
  + keyword của tài liệu để ra danh sách ngắn (mặc định 12 ảnh), ảnh vừa dùng ở
  10 bài gần nhất bị đẩy xuống cuối. Prompt chỉ thấy danh sách ngắn này.
  Lý do: kho ảnh đã hơn 200 bản ghi; dán cả kho vào prompt thì model trả
  `media:[]` và bài lên Page không có ảnh (ca thật 15/10/2026).
- `ensureMinMedia(media, shortlist, {min, max})` giữ thứ tự model chọn rồi điền
  thêm ảnh theo điểm khớp cho đủ `minImagesPerPost` (tối đa 6). Không đủ ảnh
  cùng chủ đề thì gắn `risk_flags:["fewer_images_than_min"]` để admin bổ sung
  ảnh, không lấy ảnh hàng khác cho đủ số.
- `resolveMarketingImages(config, media)` turns a draft's
  `{type:'image', image_id}` into a real source: the catalog entry's own `url`,
  otherwise the public `https://<publicWebhookUrl origin>/images/<file>` URL that
  edge serves for approved files, otherwise the local `runtime/images/<file>`
  path. An `image_id` that is missing or not `approved:true` yields `null`, and
  the post falls back to a text post instead of failing the publish. Với nhiều
  ảnh, ảnh nào resolve được thì đăng; từ 2 ảnh trở lên dùng
  `publishMultiPhotoPost`, còn lại mới rơi về bài text.

Feed post endpoint:

```text
POST /{page-id}/feed
```

Readback endpoint:

```text
GET /{post-id}?fields=id,permalink_url,created_time,message
```

Photo post endpoint:

```text
POST /{page-id}/photos
```

Implementation rules:

- Use Page token only in HTTP Authorization headers.
- If `META_PAGE_PUBLISH_ACCESS_TOKEN` exists, use it for publishing and readback.
- Do not log response bodies containing token echoes or raw request headers.
- Check returned `id` is a string.
- Read the created post back and require a permalink before claiming success.
- Sanitize Meta errors before storing or displaying.

## Marketing generation prompt contract

Hermes must return JSON only:

```json
{
  "title_internal": "short internal title",
  "caption": "Facebook caption",
  "hashtags": ["#TMFood"],
  "cta": "Inbox để được tư vấn",
  "media": [{"type":"image", "image_id":"catalog-id", "reason":"why this image fits"}],
  "link": "",
  "scheduled_at_hint": "2026-10-14T20:00:00+07:00",
  "source_ids": ["knowledge-doc-id"],
  "risk_flags": [],
  "confidence": 0.85
}
```

Validation rules:

- `caption` required, non-empty, length-limited.
- `hashtags` max 10.
- `source_ids` must match approved knowledge/product/image records actually loaded.
- Reject unsupported price/promotion claims unless present in approved data or admin input.
- Reject medical/legal/guaranteed-outcome claims.
- If `risk_flags` is non-empty, still save draft but show flags and require explicit approval.
- Generated media references must point to approved image catalog entries.

## Admin API

All routes are loopback-only through `src/admin.mjs`, require bearer `CSKH_ADMIN_TOKEN`, and return JSON.

Add endpoints:

```text
POST /marketing/draft
GET  /marketing/posts
GET  /marketing/posts/:id
POST /marketing/posts/:id/regenerate
POST /marketing/posts/:id/edit
POST /marketing/posts/:id/approve
POST /marketing/posts/:id/schedule
POST /marketing/posts/:id/publish
POST /marketing/posts/:id/cancel
POST /marketing/posts/:id/reconcile
GET  /marketing/permissions
```

Body sketches:

```json
{"prompt":"...","scheduledAt":"2026-10-14T20:00:00+07:00","tone":"..."}
```

```json
{"scheduledAt":"2026-10-14T20:00:00+07:00","explicitQuietHourOverride":false}
```

```json
{"outcome":"published","facebookPostId":"...","facebookPermalink":"..."}
```

The admin HTML can start minimal: list posts, preview caption, and expose approve/publish/cancel buttons. A CLI/operator command can be added later if needed, but the API must be complete first.

## Scheduler

Add one in-process scheduler owned by the service instance.

Rules:

- Runs only when marketing is enabled.
- Polls due `scheduled` posts every 30-60 seconds.
- Uses SQLite transaction to move one row to `publishing` before calling Meta.
- Respects daily limit and quiet hours.
- Does not run in customer completion code.
- Does not publish if service mode is draft.
- On startup, inspects stale `publishing` rows and moves them to `unknown` for operator reconciliation.

## Acceptance criteria

The implementation is complete only when all pass:

- `npm run check`
- `npm test`
- token permission probe masks secrets and reports only permission status;
- draft can be created through admin endpoint with mock Hermes output;
- unapproved draft cannot publish;
- disabled marketing config cannot publish;
- `PAGE_CSKH_MODE=draft` cannot publish;
- approved post can publish through mocked Meta client;
- publish readback stores post id and permalink;
- Meta definite failure stores `failed` and sanitized error;
- ambiguous timeout stores or recovers to `unknown`, not blind retry;
- daily post limit blocks extra publishes;
- scheduled post due time publishes once;
- scheduled post outside due time does not publish;
- customer webhook path cannot trigger any marketing action;
- no test logs contain token values.

Optional real-Page smoke test, only after owner explicitly authorizes it:

1. Probe token and permissions.
2. Publish a clearly marked test post.
3. Read back permalink.
4. Optionally delete/hide the test post if the delete endpoint is implemented and approved.

## Files to change

Expected source changes:

- `src/config.mjs`
- `src/meta.mjs`
- `src/store.mjs`
- `src/marketing.mjs` new
- `src/admin.mjs`
- `src/index.mjs`
- `scripts/init-env.mjs`
- `config.example.json`
- tests under `test/`

Expected docs updates:

- `docs/SETUP.md`
- `docs/OPERATIONS.md`
- `docs/SECURITY.md`
- `docs/ACCEPTANCE.md`
- this document

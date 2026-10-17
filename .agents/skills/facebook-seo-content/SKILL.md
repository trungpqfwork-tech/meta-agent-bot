---
name: facebook-seo-content
description: "Use when drafting or scoring Facebook SEO/social posts for TM Food."
version: 1.0.0
---

# Facebook SEO content — TM Food

Use this skill when creating, editing, or scoring Facebook Page posts for TM Food. It is for organic Facebook search/social discovery and sales intent, not Google long-form SEO.

## Hard rules

- Use only approved KB/product/image facts. Never invent price, stock, discounts, certificates, shipping promises, or quality guarantees.
- If there is no approved image, say so and penalize the score. Do not attach unapproved images.
- The customer-facing agent must not publish. Marketing content stays admin-only: draft, preview, edit, approve, then publish.
- Keep the voice human. The AI-writing tells below always cost the naturalness point.

## Anti-AI voice and Facebook layout

The service runs `detectAiTells()` from `src/seoscore.mjs` over every caption; a
hit costs a point and is listed in the preview. The target style is not a plain
blog paragraph, but it is also NOT one fixed skeleton: the Page owner rejected
posts that all "copy the same mould" (measured: 7 of 13 lines identical between
two consecutive posts, 17/10/2026). Every post is written in ONE of five rotating
angles (`POST_ANGLES` in `src/marketing.mjs`), and the angle must not repeat the
last two posts:

1. `Món và cách dùng` — dishes/uses that the KB supports, for whom.
2. `Hỏi đáp khách hay hỏi` — answer one common customer question from KB facts.
3. `Chọn hàng theo nhu cầu` — what each buyer segment (bếp ăn, nhà hàng, quán
   lẩu nướng, mua về dùng) needs and why this product fits.
4. `Ngắn gọn` — 3-5 lines, no uppercase headline, no `✔` block, max 2 emoji.
5. `Kho hàng và bảo quản` — origin, packing, storage, defrost guidance.

Always required, whatever the angle:

- Contact/CTA line with 📞/☎/💬. Use phone numbers only when the KB/admin prompt
  provides them; otherwise use inbox/comment.
- Hashtags at the end (3-6, specific).
- A first line that is specific and under ~140 characters, never a
  question-then-answer opener.
- The `💯 TMFood - ...` positioning line only in `Món và cách dùng` and
  `Chọn hàng theo nhu cầu`, and only when KB supports it. Never in the other three.
- The `✅` block and `✔` checklist are optional: at most one block, only when the
  angle needs a list. Do not repeat the same
  "Bếp ăn / Nhà hàng / Khách sạn / Quán lẩu nướng" list in every post.

Do not write any of these:

- Ad clichés: nâng tầm, giải pháp, đẳng cấp, hoàn hảo, tuyệt vời, hàng đầu, số 1,
  đỉnh cao, trọn vẹn, tận hưởng, chất lượng vượt trội.
- Em dash (—), stacked exclamation marks, all-caps sentences beyond the headline.
- Negative parallelism ("không chỉ ... mà còn"), false ranges ("từ A đến B"),
  rule-of-three lists padded to feel complete.
- Weasel openers: "ngày nay", "trong thế giới", "bạn đang tìm kiếm", "hãy để chúng tôi".
- Pushy CTA: "nhanh tay", "đừng bỏ lỡ", "hãy liên hệ ngay hôm nay".
- Blanket promises ("cam kết", "đảm bảo", "100%") with no KB source.

Functional emoji and bullet lists are allowed because TM Food's proven Page style
uses them for scanning. Random decorative emoji are still bad.

## Score gate

`PAGE_CSKH_MARKETING_MIN_SCORE` decides whether a draft is good enough to send
for approval. Below it, the service rewrites the caption up to
`PAGE_CSKH_MARKETING_REVISE_ATTEMPTS` times and keeps the best version;
`PAGE_CSKH_MARKETING_LOW_SCORE_ACTION` then either warns in the Telegram preview
(`warn`) or withholds it (`hold`). When you write by hand, aim at or above the
configured gate and check the "Cần cải thiện" list before sending.

## Caption structure

Pick the angle first (rotate, never the same angle as the last two posts), then write:

Hook line that names the product and a concrete selling point, under ~140
characters. Then the body the angle calls for. Then the required closing lines:

1. CTA: inbox/comment/phone only when provided to get the right product/variant.
2. Hashtags: 3-6 relevant tags. Prefer specific tags over generic tags.
3. Image hint: use approved image ids when available; otherwise flag `no_approved_image_available`.

Anti-repeat gate: before the draft is shown for approval, `captionRepeatRatio()`
compares it with the previous three captions, ignoring the mandatory hotline/CTA
lines. At or above 40 per cent of non-mandatory lines duplicated, the service
rewrites the caption in a different angle once and tags the post
`template_repeat_<n>pct` if the copy is still too close.

## Live Page style learned from published posts

The service can read the Page's own `published_posts` with the Page publish token.
Recent TM Food posts follow this shape:

- 7-15 non-empty lines, usually one approved image attached.
- First line is usually a product headline with emoji, e.g.
  `🥩 BẮP HOA BÒ – GIÒN NGON SẦN SẬT, ĐA DẠNG MÓN NGON`. That is one option, not a
  rule: `Ngắn gọn` posts open with a plain sentence and no uppercase line.
- 5-9 hashtags are common. The brand tag appears as `#TMfood` in older posts,
  followed by product + category + buyer-intent tags such as `#ThitBoNhapKhau`,
  `#ThucPhamDongLanh`, `#NguonHangNhaHang`, `#GiaSiThucPham`.
- Many posts use functional emoji and checklist lines (`✅`, `✔`), but some short
  posts omit checklist and hashtags. Do not force every block when facts are thin.
- The successful tone is direct wholesale Facebook copy, not a soft blog caption:
  product, mouthfeel/use case, customer segment, then contact/inbox.

## Scoring rubric, 10 points

- 1.0 hook: first line is specific and not generic.
- 1.0 product keyword: names the product/category clearly.
- 1.0 evidence: includes a grounded origin, brand trait, or use case.
- 1.0 audience: says who it fits and why.
- 1.0 CTA: clear low-friction next action.
- 1.0 hashtags: 3-6 relevant hashtags.
- 2.0 approved image: has at least one approved image selected.
- 1.0 local/context: includes Thái Bình or a concrete sales context when appropriate.
- 1.0 naturalness/safety: no AI clichés, no invented claims, no risky absolutes. `detectAiTells()` must return empty.

Caps:

- No approved image: max 6/10.
- No grounded product fact: max 5/10.
- Invented price/promo/stock: max 3/10 and must be blocked.
- Generic “thực phẩm sạch/ngon/bổ/rẻ/chất lượng” without evidence: max 5/10.

## Rewrite procedure

1. Identify the main product and buyer segment.
2. Pull grounded facts from KB: source ids, product names, origin/brand/use case.
3. Check approved image catalog. If none, keep media empty and add a risk flag.
4. Draft three variants when asked:
   - direct sales caption;
   - soft advisory caption;
   - engagement caption.
5. Score the best variant with the rubric.
6. If score is below 7, revise once before sending preview.
7. Send preview with score, missing items, source ids, and image status.

## Pitfalls

- Facebook SEO is not keyword stuffing. Repeating “cá hồi cá hồi cá hồi” makes the post worse.
- Hashtags do not replace a useful first line.
- “Sạch”, “cao cấp”, “tươi ngon”, “an toàn” can be risky if the KB does not support them.
- A caption without image can still be reviewed, but it should not be treated as publish-ready.

## Verification

Before the post is sent to Telegram approval, verify:

- caption has a clear product and CTA;
- every factual claim maps to `source_ids`;
- `media` contains only approved image ids/URLs;
- score and missing items are shown in preview;
- status remains draft/pending approval, not published.

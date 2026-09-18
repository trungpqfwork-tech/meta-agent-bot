# Product Updates From Excel

This runbook is for an operator or another agent updating the Page CSKH product
knowledge base from an Excel file supplied by the owner.

## Goal

Convert owner-supplied product data into runtime files the bot can read:

- `/home/trungpq/.openclaw/page-cskh-runtime/knowledge.json`
- `/home/trungpq/.openclaw/page-cskh-runtime/images/catalog.json`
- image files under `/home/trungpq/.openclaw/page-cskh-runtime/images/`

Do not put secrets, runtime DBs, logs, or customer conversations into source
control.

## Expected Excel Columns

Accept flexible column names. Map them by meaning, not by exact spelling:

- Product name: `Tên sản phẩm`, `Danh mục`, `Sản phẩm`, `Mặt hàng`
- Origin: `Xuất xứ`
- Brand: `Thương hiệu`, `Nhãn hiệu`
- Characteristics: `Đặc tính`, `Mô tả`
- Usage: `Công dụng`, `Món phù hợp`, `Ứng dụng`
- Notes: `Ghi chú`, `Lưu ý`
- Keywords: `Từ khóa`, `Keyword`
- Image file/link: `Ảnh`, `Image`, `Link ảnh`, `Photo`

If the sheet is messy or split into several tables, preserve facts and normalize
them into product-focused records. Do not invent missing price, inventory,
delivery time, or promotion information.

## Knowledge Format

Each approved knowledge document needs:

```json
{
  "id": "product-buffalo-tenderloin-67",
  "title": "Thăn trâu 67",
  "keywords": ["thăn trâu", "trâu 67", "trâu", "xào", "phở", "lẩu"],
  "content": "Tên sản phẩm: Thăn trâu 67\nXuất xứ: Ấn Độ\nĐặc tính: ...\nCông dụng: Phù hợp các món xào, phở, nướng, lẩu...",
  "approved": true,
  "validUntil": null
}
```

Guidelines:

- Use stable, lowercase, ASCII ids: `product-buffalo-tail-57`.
- Add Vietnamese synonyms and common customer wording into `keywords`.
- Keep content factual and compact.
- Use one document per product when possible.
- Add group documents only when customers ask category-level questions like
  "trâu có những sản phẩm nào".
- Set `approved:false` for uncertain rows instead of deleting them.

## Image Catalog Format

Images are tracked separately from KB text:

```json
{
  "id": "image-buffalo-tenderloin-67",
  "title": "Thăn trâu 67",
  "keywords": ["thăn trâu", "trâu 67", "trâu"],
  "caption": "Ảnh sản phẩm thăn trâu 67.",
  "file": "buffalo-tenderloin-67.jpg",
  "approved": true
}
```

Place local image files in:

```bash
/home/trungpq/.openclaw/page-cskh-runtime/images/
```

Use `url` instead of `file` only for stable public HTTPS image URLs:

```json
"url": "https://example.com/images/buffalo-tenderloin-67.jpg"
```

Current behavior: the worker passes matching image metadata to the model so the
bot can say whether an image is available. Sending actual image attachments is a
future action and must use this catalog.

## Update Procedure

1. Save the original Excel file under a runtime import folder, for example:

```bash
mkdir -p /home/trungpq/.openclaw/page-cskh-runtime/imports
```

2. Parse the Excel file with a real spreadsheet parser. Do not rely on ad-hoc
string splitting.

3. Backup current runtime files before writing:

```bash
cp /home/trungpq/.openclaw/page-cskh-runtime/knowledge.json \
  /home/trungpq/.openclaw/page-cskh-runtime/knowledge.json.bak-$(date +%Y%m%d-%H%M%S)
cp /home/trungpq/.openclaw/page-cskh-runtime/images/catalog.json \
  /home/trungpq/.openclaw/page-cskh-runtime/images/catalog.json.bak-$(date +%Y%m%d-%H%M%S)
```

4. Merge products into `knowledge.json`. Keep existing useful records unless the
Excel file clearly replaces them.

5. Merge image metadata into `images/catalog.json`. Copy image files into
`images/` when the Excel references local files.

6. Validate JSON:

```bash
node -e "JSON.parse(require('fs').readFileSync('/home/trungpq/.openclaw/page-cskh-runtime/knowledge.json','utf8')); console.log('knowledge ok')"
node -e "JSON.parse(require('fs').readFileSync('/home/trungpq/.openclaw/page-cskh-runtime/images/catalog.json','utf8')); console.log('images ok')"
```

7. Smoke check retrieval with likely customer questions. Example:

```bash
node --input-type=module - <<'NODE'
import { retrieve } from '/home/trungpq/.openclaw/workspace/projects/page-cskh/src/knowledge.mjs';
import { retrieveImages } from '/home/trungpq/.openclaw/workspace/projects/page-cskh/src/images.mjs';
const kb='/home/trungpq/.openclaw/page-cskh-runtime/knowledge.json';
const imgs='/home/trungpq/.openclaw/page-cskh-runtime/images/catalog.json';
for (const q of ['trâu có những sản phẩm nào', 'ba chỉ bò làm lẩu', 'có ảnh thăn trâu không']) {
  console.log('\nQ:', q);
  console.log('KB:', retrieve(kb,q).map(d=>d.id));
  console.log('IMG:', retrieveImages(imgs,q).map(d=>d.id));
}
NODE
```

8. No Gateway restart is required for content-only changes to `knowledge.json` or
`images/catalog.json`; both are read per job. Restart Gateway only if config,
source code, model, or paths changed.

## Expected Bot Behavior

When the Excel contains product data but no images, the bot should answer the
product part and say the image is not available:

```text
Dạ nhóm trâu bên em hiện có:
- Nạc dăm trâu 65
- Thăn trâu 67
- Đuôi trâu 57
- Bắp hoa trâu 60s
- Bắp chuột trâu 64

Hiện dữ liệu em có chưa kèm ảnh sản phẩm ạ.
```

When image catalog entries exist and are approved, the bot may say an image is
available by name/caption. It must not claim it has sent an image until the
send-image action exists.

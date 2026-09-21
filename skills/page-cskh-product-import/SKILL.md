# Page CSKH Product Import

Use this skill when the owner sends an Excel/CSV/JSON product file or asks to
update the Page CSKH knowledge base, product catalog, or product images.

## Principle

Do not edit runtime JSON by hand unless the owner explicitly asks for a tiny
manual correction. The normal flow is:

1. Save the uploaded source file under the runtime imports folder.
2. Run the import script in preview mode.
3. Show the owner a concise diff summary.
4. Wait for explicit approval (`/kb_apply`, "apply", "duyệt", etc.).
5. Run the import script with `--apply`.
6. Report backups and suggested smoke-test questions.

The AI may help interpret messy Excel files, but the script is the only writer
for runtime product/KB/image catalog files.

## Runtime Files

Default runtime root:

```bash
/home/trungpq/.openclaw/page-cskh-runtime
```

Main files:

```bash
products.json
knowledge.json
images/catalog.json
images/
```

`products.json` is the product catalog. `knowledge.json` is generated/merged so
the current bot can retrieve product facts. `images/catalog.json` tracks product
image metadata.

## Commands

For `.xlsx` files, ensure Python `openpyxl` exists on the VPS:

```bash
python3 -m pip install --user openpyxl
```

CSV and normalized JSON imports do not need this dependency.

Preview:

```bash
cd /home/trungpq/.openclaw/workspace/projects/page-cskh
npm run import-products -- \
  --file /absolute/path/to/products.xlsx \
  --runtime /home/trungpq/.openclaw/page-cskh-runtime \
  --preview
```

Apply after owner approval:

```bash
cd /home/trungpq/.openclaw/workspace/projects/page-cskh
npm run import-products -- \
  --file /absolute/path/to/products.xlsx \
  --runtime /home/trungpq/.openclaw/page-cskh-runtime \
  --apply
```

If only an env file is known:

```bash
npm run import-products -- \
  --file /absolute/path/to/products.xlsx \
  --env /home/trungpq/.openclaw/page-cskh-runtime/.env \
  --preview
```

## Telegram Workflow

Recommended owner-facing commands:

```text
/kb_import page-cskh
/kb_preview
/kb_apply
/kb_cancel
/kb_status
/kb_rollback
```

For `/kb_import`, save the attached file into:

```bash
/home/trungpq/.openclaw/page-cskh-runtime/imports/
```

Then run preview and send a summary like:

```text
Đã đọc file:
- Thêm mới: 4 sản phẩm
- Cập nhật: 18 sản phẩm
- Knowledge docs sau apply: 35
- Ảnh/link ảnh: 6 mục

Gõ /kb_apply để cập nhật hoặc /kb_cancel để hủy.
```

Never apply directly from Telegram without an explicit approval message.

## Messy Excel Handling

Accept flexible column names and sheet layouts. Map by meaning:

- product name: `Tên sản phẩm`, `Danh mục`, `Sản phẩm`, `Mặt hàng`, `Product`
- origin: `Xuất xứ`, `Nguồn gốc`, `Origin`
- brand: `Thương hiệu`, `Nhãn hiệu`, `Brand`
- traits: `Đặc tính`, `Mô tả`, `Đặc điểm`
- usage: `Công dụng`, `Món phù hợp`, `Dùng cho`, `Use case`
- notes: `Ghi chú`, `Lưu ý`
- image: `Ảnh`, `Image`, `Link ảnh`, `Photo`

If the preview looks wrong because the Excel has multiple stacked tables or
merged-header style data, do not apply. Ask the owner for permission to run a
manual AI normalization pass, then create a temporary normalized JSON file and
run `import-products` against that JSON.

## Safety Rules

- Never copy secrets, runtime DBs, or logs into source control.
- Backup files are created automatically on `--apply`; mention their paths.
- Do not delete old data just because a new Excel omits a cell.
- To remove a product, require an explicit delete/remove instruction from the
  owner or a future supported delete column.
- `approved:true` is allowed only when the owner-provided file is intended as
  the source of truth.
- No Gateway restart is required for content-only product/KB/image changes.

## Smoke Questions

After apply, suggest the owner test:

```text
bên mình có sản phẩm gì?
trâu thì có những sản phẩm nào?
ba chỉ bò làm lẩu chọn loại nào?
có ảnh chân gà không?
```

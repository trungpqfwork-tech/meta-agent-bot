# Build & chạy trên VPS (đã chạy thật, copy lệnh là dùng được)

Layout: **code** và **runtime** tách rời. Runtime nằm ngoài thư mục code (service assert điều này).

```
/srv/page-cskh/
  app/        <- code, ship từ git (không chứa secrets, không chứa data)
  runtime/    <- .env, config.json, data/, knowledge.json, products.json, images/, agent/, logs/
```

Yêu cầu: Node **24+** (dùng `node:sqlite` built-in), không cần `npm install` (project không có dependency ngoài).
Hermes phải có sẵn trên máy: `~/.hermes/hermes-agent` (hoặc `HERMES_APP_DIR`/`HERMES_PYTHON`).

## 1. Ship code

```bash
mkdir -p /srv/page-cskh/app /srv/page-cskh/runtime
git archive --format=tar <branch> | tar -x -C /srv/page-cskh/app
```

`git archive` chỉ lấy file đã commit nên không kéo theo data/backup.

## 2. Đưa secrets vào runtime

Copy `.env` lên VPS (scp/vault), đặt ở `runtime/.env`, **bắt buộc mode 600** — service assert, sai mode là không boot:

```bash
chmod 600 /srv/page-cskh/runtime/.env
```

Các key bắt buộc: `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `META_PAGE_ACCESS_TOKEN`, `CSKH_ADMIN_TOKEN` (>=32 ký tự).

## 3. Tạo config.json

`generate-config` đọc **file env**, không đọc `process.env`:

```bash
node app/scripts/generate-config.mjs --env /srv/page-cskh/runtime/.env
```

Ghi ra `runtime/config.json` (mode 600) từ các biến `PAGE_CSKH_*`: pageId, ports, model, đường dẫn data/KB, mode, chat id Telegram.

## 4. Setup runtime — **phải ở mode=draft**

`setup-hermes` từ chối chạy khi `mode=live`:

```
Setup requires mode=draft; enable live separately after acceptance
```

Nên chạy setup bằng bản draft, rồi mới bật live ở bước 7:

```bash
sed 's/^PAGE_CSKH_MODE=.*/PAGE_CSKH_MODE=draft/' /srv/page-cskh/runtime/.env > /tmp/env.draft
cp /tmp/env.draft /srv/page-cskh/runtime/.env && chmod 600 /srv/page-cskh/runtime/.env
node app/scripts/generate-config.mjs --env /srv/page-cskh/runtime/.env
node app/scripts/setup-hermes.mjs --config /srv/page-cskh/runtime/config.json          # xem plan
node app/scripts/setup-hermes.mjs --config /srv/page-cskh/runtime/config.json --apply  # ghi thật
```

`--apply` tạo: `agent/` (AGENTS.md, SOUL.md, IDENTITY.md), `knowledge.json` (template), `data/`, và unit file `runtime/page-cskh.service` (systemd user unit, ExecStart trỏ vào `src/service.mjs` + config này).

## 5. Nạp KB từ Excel của Page

```bash
node app/scripts/import-products.mjs --file "/path/Đặc tính sản phẩm.xlsx" \
  --runtime /srv/page-cskh/runtime --sheet "Đặc tính SP"          # preview
node app/scripts/import-products.mjs --file "..." \
  --runtime /srv/page-cskh/runtime --sheet "Đặc tính SP" --apply  # ghi
```

Luôn dùng `--sheet` để loại sheet nội bộ. Kiểm tra: 27 product + 5 category, `approved: 32`.

## 6. Chạy service

PM2 (fork mode — service đã hỗ trợ `pm_exec_path`):

```bash
pm2 start /srv/page-cskh/app/src/service.mjs --name page-cskh \
  --interpreter node -- --config /srv/page-cskh/runtime/config.json
pm2 save
```

Hoặc systemd user unit đã sinh ở bước 4 (`runtime/page-cskh.service`).

## 7. Chuyển sang live

```bash
cp /path/.env.live /srv/page-cskh/runtime/.env && chmod 600 /srv/page-cskh/runtime/.env
node app/scripts/generate-config.mjs --env /srv/page-cskh/runtime/.env   # mode=live
pm2 restart page-cskh
```

Log boot phải có `page-cskh standalone ready (live)` và `Meta probe ok`.

## 8. Nghiệm thu local (không cần Meta)

```bash
# webhook challenge
curl "http://127.0.0.1:<edgePort>/webhooks/page-cskh?hub.mode=subscribe&hub.verify_token=<verify>&hub.challenge=ok"
# -> 200 "ok"

# admin console
curl -H "Authorization: Bearer <CSKH_ADMIN_TOKEN>" http://127.0.0.1:<adminPort>/status
```

POST giả lập tin khách: ký HMAC-SHA256 body bằng `META_APP_SECRET`, header `x-hub-signature-256: sha256=<hex>`, body dạng:

```json
{"object":"page","entry":[{"id":"<pageId>","time":0,"messaging":[{"sender":{"id":"999001"},
  "recipient":{"id":"<pageId>"},"timestamp":0,"message":{"mid":"m-1","text":"Ba chỉ bò xuất xứ từ đâu?"}}]}]}
```

Kết quả đúng: `200 EVENT_RECEIVED`, `logs/webhook.log` ghi `POST ingested events=1`, DB có event `customer`, và outbox/job có câu trả lời do Hermes sinh từ KB.

**Dùng PSID giả**: gửi thật tới PSID không tồn tại sẽ làm job thành `unknown` / `reason=ambiguous_send` và conversation bị giữ ở `WAITING` — đây là hành vi đúng khi Meta send lỗi, không phải bug.

## 9. Đưa tunnel/HTTPS vào

```bash
cloudflared tunnel --url http://127.0.0.1:<edgePort>
```

Cập nhật webhook URL trong Meta App theo hostname mới (quick tunnel đổi mỗi lần chạy).

## Quy tắc không được vi phạm

- **Một sender live cho một Page.** Trước khi cho instance mới nhận traffic, phải stop instance cũ.
- **Không copy SQLite đang chạy bằng mỗi file `.sqlite`** — phải stop writer hoặc checkpoint cả WAL (`-wal`, `-shm`).
- **Port trong `.env` chỉ có tác dụng lúc generate-config**, không được áp lại lúc runtime (`applyEnvOverrides` chỉ nhận `MODE`, `WAITING_RESET_SECONDS`, `MESSAGE_DEBOUNCE_SECONDS`, `ENABLE_HUMAN_HANDOFF`, `ORDER_TELEGRAM_CHAT_IDS`). Muốn đổi port phải sửa `.env` → generate lại config → restart.
- **Sửa KB không cần restart**; sửa code/config/env thì phải restart.

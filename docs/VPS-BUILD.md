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

## 10. Agent admin (tùy chọn — để vận hành từ Telegram)

Agent admin là con chạy trên máy để làm việc vận hành (cập nhật KB, sửa hành vi,
xử lý hội thoại kẹt, đọc log, deploy). Nó **phải tách** khỏi con bot trả lời
khách: bot CSKH bị người lạ chọc qua webhook nên không được có tool, còn agent
admin chỉ nghe từ Telegram user id của chủ Page.

```bash
scripts/setup-admin-agent.sh --check     # xem còn thiếu gì
scripts/setup-admin-agent.sh             # tạo profile cskh-admin + trust repo
```

Nếu anh **chỉ chat được với Hermes trên VPS** và không SSH vào terminal, hãy gửi
cho Hermes trên VPS đúng yêu cầu này sau khi code đã nằm ở `/srv/page-cskh/app`:

```text
Hãy chạy bootstrap admin agent cho page-cskh:
cd /srv/page-cskh/app
bash scripts/setup-admin-agent.sh
bash scripts/setup-admin-agent.sh --check
Gửi lại nguyên văn kết quả check, không in secret.
```

Điều kiện: con Hermes mà anh đang chat trên VPS phải là agent có tool terminal và
đủ quyền ghi vào `$HOME/.hermes/profiles`. Script không cần input bí mật và có
thể chạy qua chat. Nếu VPS chưa có Hermes/gateway nào để anh chat được thì không
có tiến trình nào tự chạy được script này — lúc đó cần bước bootstrap ngoài
Hermes (SSH/systemd/cloud-init/Ansible) để cài Hermes lần đầu.

Script tạo profile (`--clone` để có sẵn provider + key, **không** copy token
messaging mặc định), chạy `hermes skills trust <repo>` để `.agents/skills/` được
load, set `terminal.cwd` tuyệt đối về repo, và nếu runtime `.env` có các biến
sau thì tự import bot Telegram admin vào profile `cskh-admin`:

```dotenv
PAGE_CSKH_ADMIN_TELEGRAM_BOT_TOKEN=123456:bot-token-cua-admin-agent
PAGE_CSKH_ADMIN_TELEGRAM_ALLOWED_USERS=1011998801
```

Script ghi hai giá trị này vào `$HOME/.hermes/profiles/cskh-admin/.env` dưới tên
Hermes chuẩn `TELEGRAM_BOT_TOKEN` và `TELEGRAM_ALLOWED_USERS`, nhưng không in
secret. Nếu runtime không nằm cạnh app ở `../runtime/.env`, truyền rõ:

```bash
scripts/setup-admin-agent.sh --runtime-env /srv/page-cskh/runtime/.env
```

Các bước còn lại:

- **dùng bot khác** với bot cảnh báo `TELEGRAM_BOT_TOKEN` của service trong
  `runtime/.env`; nếu dùng chung, gateway sẽ poll chính bot đó và agent admin sẽ
  đọc/đáp cả trong group cảnh báo
- nếu hai biến Telegram admin đã có trong `.env`, script sẽ tự chạy
  `hermes gateway install --start-now --start-on-login`, nên bot admin bắt đầu
  nhận Telegram ngay và tự lên lại sau reboot/login

Chạy agent từ thư mục repo để `AGENTS.md` + skill có hiệu lực. **Bắt buộc**:
`terminal.cwd` của profile phải là đường dẫn **tuyệt đối** tới repo — mặc định `.`
sẽ resolve về Hermes home và khi đó `AGENTS.md` + skill trong repo **im lặng
không load** (không có lỗi, chỉ là agent không biết quy trình). Script đã set và
`--check` kiểm tra lại.

```bash
cd /srv/page-cskh/app && HERMES_HOME=$HOME/.hermes/profiles/cskh-admin hermes
```

Quy trình vận hành nằm trong `.agents/skills/page-cskh-admin/SKILL.md` (đi theo
git nên VPS tự có). Bộ nhớ/session của agent admin **không** đi theo git và không
bao giờ được lẫn sang câu trả lời cho khách.

## Quy tắc không được vi phạm

- **Một sender live cho một Page.** Trước khi cho instance mới nhận traffic, phải stop instance cũ.
- **Không copy SQLite đang chạy bằng mỗi file `.sqlite`** — phải stop writer hoặc checkpoint cả WAL (`-wal`, `-shm`).
- **Port trong `.env` chỉ có tác dụng lúc generate-config**, không được áp lại lúc runtime (`applyEnvOverrides` chỉ nhận `MODE`, `WAITING_RESET_SECONDS`, `MESSAGE_DEBOUNCE_SECONDS`, `ENABLE_HUMAN_HANDOFF`, `ORDER_TELEGRAM_CHAT_IDS`). Muốn đổi port phải sửa `.env` → generate lại config → restart.
- **Sửa KB không cần restart**; sửa code/config/env thì phải restart.

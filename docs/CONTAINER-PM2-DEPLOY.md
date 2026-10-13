# Chạy page-cskh trong container Hermes (pm2 + persist volume)

Tài liệu này bổ sung cho [`VPS-BUILD.md`](VPS-BUILD.md) cho trường hợp service chạy
**bên trong container Hermes** — nơi không có systemd, chỉ một thư mục là persist, và
node/pm2 phải sống trong volume đó. Mọi lệnh ở đây đã chạy thật.

## 1. Đặc thù của host dạng này

```bash
grep -E ' / |hermes' /proc/mounts
# overlay / overlay rw,...                      <- mọi thứ còn lại: TẠM
# /dev/sda1 /root/.hermes ext4 rw,...           <- volume persist DUY NHẤT
```

Hệ quả — **container dựng lại là mất**:

| Mất | Vì ở overlay |
|---|---|
| `node`, `npm`, `npx`, `corepack` | `/usr/local/bin`, `/usr/local/lib` |
| pm2 daemon + mọi process pm2 | process tree của container |
| symlink CLI `hermes`, `pm2` | `/usr/local/bin` |
| `/tmp` (script tạm, tarball) | `/tmp` |

Còn nguyên (nằm trong `/root/.hermes`): code, `runtime/` (`.env`, `config.json`,
`data/*.sqlite`, `knowledge.json`), `profiles/`, `tools/`, `.pm2/dump.pm2`.

**Nhận biết container vừa dựng lại:**

```bash
ps -o pid,etime,args -p 1 --no-headers   # etime vài chục giây
ls /usr/local/bin/node                   # No such file or directory
```

`PID 1` là `hermes gateway run` — gateway thoát thì container dựng lại sau ~1.5-5s.

## 2. Layout trên host

```
/root/.hermes/
├── tools/
│   ├── node/                    node v24.21.0 (tarball nodejs.org) — PERSIST
│   ├── node_modules/            pm2 7.x — PERSIST
│   ├── pm2.sh                   wrapper: set PM2_HOME + PATH có node
│   ├── run-cskh-admin-gateway.sh gateway cho profile admin
│   ├── recover.sh               hồi phục sau dựng lại (1 lệnh)
│   └── who_listens.py           map port -> PID (không có ss/netstat/lsof)
├── .pm2/                        PM2_HOME: dump.pm2, pids/, logs/
├── profiles/cskh-admin/         profile Hermes cho bot admin
└── projects/page-cskh/
    ├── app/                     code (git)
    └── runtime/                 .env (600), config.json, data/, logs/,
                                 ecosystem.config.cjs
```

Không cài pm2/node ở `/usr/local` — chúng sẽ mất ở lần dựng lại tiếp theo.

## 3. Cài node + pm2 vào volume

```bash
mkdir -p /root/.hermes/tools
curl -L https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz -o /tmp/node.tar.xz
tar -xJf /tmp/node.tar.xz -C /root/.hermes/tools
mv /root/.hermes/tools/node-v24.21.0-linux-x64 /root/.hermes/tools/node

# pm2 cài vào volume, không dùng npm -g (npm prefix = /usr/local = overlay)
cd /root/.hermes/tools && npm init -y && npm install --prefix /root/.hermes/tools pm2
```

Wrapper bắt buộc (gọi `pm2` trần sẽ dùng `/root/.pm2` — danh sách rỗng — và không
thấy `node`):

```bash
cat > /root/.hermes/tools/pm2.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail
export PM2_HOME="${PM2_HOME:-/root/.hermes/.pm2}"
export PATH="/root/.hermes/tools/node/bin:/usr/local/bin:$PATH"
exec /root/.hermes/tools/node_modules/.bin/pm2 "$@"
SH
chmod 755 /root/.hermes/tools/pm2.sh
ln -sf /root/.hermes/tools/pm2.sh /usr/local/bin/pm2
```

## 4. Chạy service bằng pm2

`runtime/ecosystem.config.cjs` (đã có trong runtime, không commit):

```js
module.exports = { apps: [{
  name: 'page-cskh',
  cwd: '/root/.hermes/projects/page-cskh/app',
  script: 'src/service.mjs',
  args: '--config /root/.hermes/projects/page-cskh/runtime/config.json',
  interpreter: '/root/.hermes/tools/node/bin/node',   // đường dẫn TRONG volume
  env: { HERMES_APP_DIR: '/usr/local/lib/hermes-agent', NODE_ENV: 'production' },
  autorestart: true, max_restarts: 20, restart_delay: 3000, kill_timeout: 10000,
  out_file: '.../runtime/logs/pm2-out.log',
  error_file: '.../runtime/logs/pm2-err.log',
  merge_logs: true, time: true,
}]};
```

```bash
cd /root/.hermes/projects/page-cskh/runtime
pm2 start ecosystem.config.cjs
pm2 save            # BẮT BUỘC — không save thì `pm2 resurrect` bỏ sót process
```

Hai điểm không được bỏ:

- **`HERMES_APP_DIR=/usr/local/lib/hermes-agent`** — mặc định trong `src/hermes.mjs` là
  `~/.hermes/hermes-agent`, không tồn tại trên host này. Thiếu biến này thì mọi tin nhắn
  khách rơi vào câu trả lời mặc định (`agent_error` trong `agent/logs/worker.log`).
- **`interpreter` trỏ vào volume**, không trỏ `/usr/local/bin/node` (symlink ở overlay).

`pm2 startup` **không dùng được** ở đây: không có init thật, pm2 nhận nhầm `upstart`
rồi sinh `/etc/init.d/pm2-undefined` (tên có chữ `undefined`, không ai chạy). Dọn bằng
`pm2 unstartup upstart`.

## 5. Hồi phục sau khi container dựng lại

```bash
bash /root/.hermes/tools/recover.sh
```

Idempotent. Script làm tuần tự:

1. kiểm tra node trong volume (thiếu thì in lệnh cài, không tự tải)
2. tạo lại symlink `/usr/local/bin/{node,npm,npx,corepack,hermes,hermes-agent,pm2}`
3. `pm2 resurrect` từ `dump.pm2`
4. đảm bảo `cskh-admin-gateway` chạy — `pm2 restart` rồi fallback `pm2 start`
   (dump có thể cũ hơn process list thật)
5. `pm2 save`
6. verify: port nào do PID nào giữ, webhook challenge HTTP 200, `/status` HTTP 200,
   boot log, telegram connected

## 6. Admin agent trên Telegram

Agent admin phải **tách** khỏi bot trả lời khách: bot CSKH bị người lạ chọc qua
webhook nên không được có tool; agent admin chỉ nghe từ Telegram user id của chủ Page.

Trên host này `scripts/setup-admin-agent.sh` **không chạy được** (xem §8). Các bước
tương đương, làm tay:

```bash
P=$HOME/.hermes/profiles/cskh-admin
REPO=/root/.hermes/projects/page-cskh/app

# 1. profile, clone provider + key (KHÔNG copy token messaging)
hermes profile create cskh-admin --clone --description "Page CSKH admin/ops agent"

# 2. bỏ hết token messaging mà --clone đã kéo theo
grep -vE '^(TELEGRAM|DISCORD|SLACK|WHATSAPP|SIGNAL|MATRIX|TEAMS|EMAIL|TWILIO|SMS|LINE|DINGTALK|MATTERMOST)_' \
  "$P/.env" > /tmp/p.env && install -m 600 /tmp/p.env "$P/.env" && rm -f /tmp/p.env

# 3. nạp bot Telegram admin (đọc từ runtime .env, không in ra)
#    -> TELEGRAM_BOT_TOKEN + TELEGRAM_ALLOWED_USERS trong $P/.env

# 4. project skill trong repo (thay cho `hermes skills trust` đã bị bỏ)
HERMES_HOME=$P hermes config set skills.external_dirs "[\"$REPO/.agents/skills\"]"

# 5. terminal.cwd TUYỆT ĐỐI về repo, không thì AGENTS.md + skill im lặng không load
HERMES_HOME=$P hermes config set terminal.cwd "$REPO"

# 6. gateway riêng qua pm2
pm2 start /root/.hermes/tools/run-cskh-admin-gateway.sh \
  --name cskh-admin-gateway --interpreter bash
pm2 save
```

### Bốn cái bẫy của `hermes profile create --clone`

1. **Copy luôn `SOUL.md`** → bot admin tự nhận là trợ lý cá nhân của người khác. Phải
   viết lại `profiles/cskh-admin/SOUL.md` thành identity vận hành.
2. **Copy luôn `memories/USER.md` + `MEMORY.md`** — đây mới là thủ phạm **chính**:
   memory được inject vào MỌI turn nên nó **đè** SOUL.md. Sửa SOUL.md mà không sửa
   memories thì bot vẫn sai identity. Phải viết lại cả hai.
3. **Copy luôn `platforms.webhook` (enabled, cùng port)** → trùng port gateway chính
   → log spam `Errno 98` mỗi 60-120s. Tắt bằng config, **không** bằng `.env`:
   `HERMES_HOME=$P hermes config set platforms.webhook.enabled false`
   (`WEBHOOK_ENABLED=false` trong `.env` KHÔNG có tác dụng.)
4. **Session Telegram cũ vẫn tiếp tục** — history chứa câu tự nhận sai thì model đọc
   lại và giữ persona đó. Gửi `/new` (alias `/reset`) trong chat với bot.

### Xác minh identity bằng session sạch

```bash
cd $REPO && HERMES_HOME=$P hermes chat -q "em là ai?"
```

Nếu bot vẫn sai identity thì nguyên nhân là **memory hoặc history**, không phải
SOUL.md không được nạp — `system_prompt` trong `state.db` là `NULL`, prompt được dựng
lại mỗi turn.

### Ba bot phải phân biệt

| Bot | Vai trò |
|---|---|
| bot chính của host | gateway profile `default` |
| bot cảnh báo của service (`TELEGRAM_BOT_TOKEN` trong `runtime/.env`) | gửi alert đơn/handoff vào group |
| bot admin (`PAGE_CSKH_ADMIN_TELEGRAM_BOT_TOKEN`) | agent vận hành, profile `cskh-admin` |

Dùng chung bot giữa bot cảnh báo và bot admin thì agent admin sẽ đọc/đáp cả trong
group cảnh báo.

Gateway của profile dùng Telegram **long-polling** nên không bind port nào. Telegram
còn backlog sẵn lúc gateway khởi động thì **bị bỏ qua** — muốn test phải gửi tin **mới**.

## 7. Kiểm tra (bằng chứng, không đoán)

```bash
RT=/root/.hermes/projects/page-cskh/runtime

# service
node $RT/../app/scripts/verify.mjs --config $RT/config.json
node $RT/../app/scripts/verify.mjs --config $RT/config.json --meta   # probe token thật

# webhook challenge
VT=$(grep '^META_WEBHOOK_VERIFY_TOKEN=' $RT/.env | cut -d= -f2-)
curl -s -w " HTTP:%{http_code}\n" \
  "http://127.0.0.1:3002/webhooks/page-cskh?hub.mode=subscribe&hub.verify_token=$VT&hub.challenge=ok"
# -> ok HTTP:200

# admin console
AT=$(grep '^CSKH_ADMIN_TOKEN=' $RT/.env | cut -d= -f2-)
curl -s -H "Authorization: Bearer $AT" http://127.0.0.1:3001/status
# -> {"pageId":"...","mode":"live",...}

# port nào do PID nào giữ (host này không có ss/netstat/lsof)
python3 /root/.hermes/tools/who_listens.py

# process pm2 (xem §8 nếu `pm2 list` bị chặn)
GOD=$(pgrep -f "God Daemon" | head -1)
for p in $(pgrep -P $GOD); do ps -o pid,etime,rss,args -p $p --no-headers; done

# log
tail -5 $RT/logs/pm2-out.log      # phải có "page-cskh standalone ready (live)"
tail -5 $RT/logs/pm2-err.log
tail -5 $HOME/.hermes/profiles/cskh-admin/logs/gateway.log   # "telegram connected"
```

## 8. Pitfalls riêng của host này

- **`pm2 list` bị lifecycle guard chặn** — guard coi lệnh/script có khả năng
  restart/stop gateway đang chạy là nguy hiểm (SIGTERM lan sang process con). Dùng
  `ps`/`pgrep`/`/proc` để đọc process list thay vì `pm2 list`.
- **`setup-admin-agent.sh` hỏng trên Hermes v0.20.0** — script gọi `hermes skills
  trust`, subcommand này **đã bị bỏ** (`invalid choice: 'trust'`); ngoài ra script bị
  lifecycle guard chặn vì chứa lệnh restart gateway. Thay `trust` bằng
  `skills.external_dirs` (§6) và làm các bước còn lại bằng tay.
- **`hermes` không có trên PATH mặc định** — CLI nằm ở
  `/usr/local/lib/hermes-agent/venv/bin/hermes`. Symlink vào `/usr/local/bin` (đã có
  sẵn trong PATH, hoạt động cả với shell **non-interactive**). Cách chính thức của
  installer là symlink `~/.local/bin` + sửa `~/.bashrc`, nhưng shell non-interactive
  (`bash script.sh`) **không đọc `.bashrc`** nên cách đó không sửa được lỗi
  `hermes not on PATH` khi chạy script.
- **Edge port bind `0.0.0.0`** trên host này (khác mặc định `127.0.0.1` trong repo) để
  tunnel ngoài container vào được. Đây là thay đổi có ý thức — đừng "sửa lại" thành
  `127.0.0.1` nếu vẫn cần tunnel.
- **Không có `cloudflared` trên host** — `mode=live` chỉ có nghĩa khi tunnel sống.
  URL quick tunnel là ephemeral; dựng lại tunnel là URL mới → phải cập nhật webhook
  trong Meta App. Test bằng chính public URL, không chỉ `127.0.0.1`.

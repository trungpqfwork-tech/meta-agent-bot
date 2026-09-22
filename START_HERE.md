# Start here — triển khai page-cskh trên Hermes

## Mục tiêu và giới hạn

Triển khai service CSKH cho **một Facebook Page trên một runtime**, một SQLite DB riêng, KB riêng, `.env` riêng. Service tự nhận Meta webhook và dùng Hermes chỉ để sinh completion. Mặc định `draft` (không gửi Meta).

Conversation continuity invariant: mọi history khách, Page/PSID isolation, BOT/WAITING/HUMAN, order state, dedup, outbox và audit nằm trong SQLite của page-cskh. Không dùng native Hermes session/memory làm nguồn nhớ khách hàng.

Đây là MVP 0.1.0; đọc `docs/STATUS.md` và `docs/HERMES-MIGRATION-PLAN.md` trước khi khẳng định live-ready.

## Trình tự bắt buộc

1. Đọc `README.md`, `docs/HERMES-MIGRATION-PLAN.md`, `docs/SETUP.md`, `docs/SECURITY.md` và `docs/ACCEPTANCE.md`.
2. Chạy `node --version`, `hermes --version`, `npm run check`, `npm test`.
3. Tạo thư mục runtime **ngoài repository và ngoài workspace agent công khai**. Copy/generate `config.json`; giữ `mode: draft`. Nếu dùng runtime Hermes riêng, đặt `PAGE_CSKH_HERMES_HOME=./hermes-cskh` hoặc `hermesHome` trong config; thư mục này chỉ chứa persona/model runtime, không chứa lịch sử khách.
4. Tạo `.env` ở runtime bằng `node scripts/init-env.mjs /absolute/runtime/.env`. Không lấy secrets qua chat/tool arguments, không in secrets, không đọc `.env` trả cho model.
5. Chạy plan: `npm run setup -- --config /absolute/runtime/config.json`.
   Sau đó mới chạy `--apply` trong phạm vi người quản trị đã duyệt.
6. Start service ở draft:
   `npm start -- --config /absolute/runtime/config.json`
   hoặc dùng unit file được tạo cạnh config.
7. Hoàn thiện KB: tài liệu mẫu `approved:false` KHÔNG được dùng để trả lời nghiệp vụ.
8. Cấu hình HTTPS/tunnel/nginx để Meta gọi tới `edgePort` của service. Kiểm tra token bằng verify/meta read-only trước khi live.
9. Chạy các bài kiểm thử Page thật ở `docs/ACCEPTANCE.md`. Ban đầu chỉ draft.
10. Chỉ đổi `mode: live` sau khi người quản trị cho phép gửi thật và đã qua nghiệm thu. Restart service sau khi đổi config/env.

## Không được làm

- Không copy toàn bộ `.hermes`, auth store, memory cá nhân hoặc profile secrets vào runtime bot.
- Không cấp terminal/browser/file tools cho completion CSKH để “sửa lỗi thiếu quyền”.
- Không dùng Hermes memory/session làm nơi lưu lịch sử khách Facebook.
- Không tự bật live, gửi thử cho khách thật, đổi webhook của Page đang chạy bot khác.
- Không chạy hai sender live cho cùng một Page.
- Không copy SQLite đang chạy chỉ bằng file `.sqlite`; phải dừng writer hoặc checkpoint/backup cả WAL.
- Không overwrite config, KB hoặc workspace không thuộc project.

## Lỗi thường gặp khi vận hành (đã gặp thật)

- **`ModuleNotFoundError: No module named 'run_agent'`** — completion gọi `python3` hệ thống trong khi `run_agent.py` nằm ở thư mục cài Hermes. `src/hermes.mjs` phải spawn interpreter của venv Hermes và chạy với `cwd`/`PYTHONPATH` trỏ vào thư mục cài (`HERMES_APP_DIR`, mặc định `~/.hermes/hermes-agent`; override bằng `HERMES_PYTHON`). Khi lỗi này xảy ra, mọi tin nhắn đều rơi vào câu trả lời mặc định, log worker ghi `agent_error ... agent_or_knowledge_unavailable`.
- **Model không tồn tại trên provider** — `model` trong config/.env phải là id mà Hermes runtime gọi được (provider lấy từ `~/.hermes/config.yaml` của Hermes). Model sai cho ra `HTTP 400 Model is unavailable`, cũng rơi vào câu trả lời mặc định. Sửa cả `config.json` và `.env` (`PAGE_CSKH_MODEL`) rồi restart.
- **Chạy bằng PM2 nhưng service không mở port** — PM2 fork mode đặt script container của nó vào `argv[1]`, nên kiểm tra entrypoint kiểu `argv[1] === import.meta.url` sẽ sai và `main()` không bao giờ chạy (process online nhưng im lặng). `src/service.mjs` kiểm tra thêm `pm_exec_path`; xem `isEntryPoint()`.
- **KB không có tài liệu `approved: true`** — `retrieve()` chỉ dùng tài liệu đã duyệt, nên KB rỗng khiến agent không có dữ liệu để bám và luôn handoff/fallback.
- **Hai tiến trình cùng mở một SQLite** — chạy song song PM2 và `node src/service.mjs` làm tiến trình sau kẹt ở `Store` (online, không mở port). Luôn chỉ giữ một instance.

## Cập nhật KB từ Excel của Page

Nguồn dữ liệu KB là file Excel do Page cung cấp. Import bằng pipeline của project:

```
npm run import-products -- --file "/đường/dẫn/Đặc tính sản phẩm.xlsx" \
  --runtime /path/runtime --sheet "Đặc tính SP" --preview
npm run import-products -- --file "..." --runtime /path/runtime --sheet "Đặc tính SP" --apply
```

Quy tắc rút ra từ lần import thật:

- **Luôn dùng `--sheet`** khi file còn sheet nội bộ (doanh số, KPI, khoán). Không lọc sheet thì mọi sheet đều được đọc; sheet nội bộ thường không tạo sản phẩm nhưng vẫn nên loại tường minh để tránh rò dữ liệu nội bộ vào KB.
- **Reader Excel dùng python3 stdlib** (zipfile + ElementTree), không cần `openpyxl`. Cell merge được expand nên row nằm trong vùng merge vẫn giữ đúng Danh mục/Xuất xứ. Chỉ hỗ trợ `.xlsx`/`.xlsm`; `.xls` cũ phải lưu lại thành `.xlsx`.
- **Nhóm sản phẩm** suy ra từ tên sản phẩm. Muốn chắc chắn đúng, thêm cột `Nhóm` vào Excel (giá trị sẽ được ưu tiên khi tên không khớp quy tắc nào).
- Import ghi đè `product-*`/`category-*` và **giữ lại** mọi document KB khác; muốn bỏ tài liệu cũ thì xoá khỏi `knowledge.json` trước khi apply.
- `--apply` tự backup `products.json`, `knowledge.json`, `images/catalog.json`.
- Sau khi sửa KB không cần restart: `retrieve()` đọc file mỗi lần trả lời. Chỉ restart khi đổi code/config.

## Báo cáo bàn giao

Ghi phiên bản project/host, Page ID, vị trí config/KB/DB (không giá trị secrets), chế độ draft/live, kiểm tra đã chạy, phần còn thiếu, cách mở console, cách start/stop service và rollback. Nếu thiếu Meta/model/domain, hoàn tất phần local và báo blocker cụ thể; không báo live-ready.

# Start here — dành cho OpenClaw triển khai project

## Mục tiêu và giới hạn

Triển khai plugin CSKH cho **một Facebook Page trên một Gateway**, một agent riêng,
KB riêng, `.env` riêng. Không sửa core OpenClaw. Mặc định `draft` (không gửi Meta).
Đây là MVP 0.1.0; đọc `docs/STATUS.md` trước khi khẳng định tính năng đã được chứng minh.

## Trình tự bắt buộc

1. Đọc `README.md`, `docs/SETUP.md`, `docs/SECURITY.md` và `docs/ACCEPTANCE.md`.
2. Chạy `node --version`, `openclaw --version`, `npm run check`, `npm test`.
   Host mục tiêu được ghim ở 2026.9.4; không tự bỏ qua kiểm tra tương thích.
3. Tạo thư mục runtime **ngoài repository và ngoài mọi workspace agent công khai**.
   Copy `config.example.json` vào đó. Cấu hình Page ID, App ID, domain, model,
   phạm vi, đường dẫn; giữ `mode: draft`. Các đường dẫn tương đối tính từ config.
4. Tạo `.env` ở runtime bằng `node scripts/init-env.mjs /absolute/runtime/.env`
   trong terminal của người quản trị. Không lấy secrets qua chat/tool arguments,
   không in secrets, không đọc `.env` thành nội dung trả cho model.
5. Chạy `npm run setup -- --config /absolute/runtime/config.json` để xem kế hoạch.
   Sau đó chạy với `--apply` trong phạm vi người dùng đã yêu cầu cài đặt.
6. Kiểm tra cấu hình và plugin: `npm run doctor -- --config ...`,
   `openclaw plugins inspect page-cskh --runtime --json`.
   Inspect không chứng minh Gateway đang chạy plugin: khởi động/reload Gateway đúng
   theo cấu hình dịch vụ hiện có, rồi `npm run verify -- --config ...`.
7. Hoàn thiện KB: tài liệu mẫu `approved:false` KHÔNG được dùng để trả lời nghiệp vụ.
8. Cấu hình HTTPS và Meta theo SETUP. Kiểm tra token bằng `verify --meta` (chỉ đọc).
9. Chạy các bài kiểm thử Page thật ở ACCEPTANCE. Ban đầu chỉ soạn.
10. Chỉ đổi `mode: live` sau khi người quản trị cho phép gửi thật và đã qua nghiệm thu.
    Restart/reload plugin sau khi đổi config/env; file JSON ngoài OpenClaw không tự reload.

## Không được làm

- Không copy toàn bộ `.openclaw`, auth store, memory cá nhân từ máy phát triển.
- Không cấp exec/read/browser/message cho agent CSKH để “sửa lỗi thiếu quyền”.
- Không tự bật live, gửi thử cho khách thật, đổi webhook của Page đang chạy bot khác.
- Không overwrite config, KB hoặc workspace không thuộc project.
- Không dùng `--force` để kill Gateway. `plugins install --force` xác nhận nguồn
  local và cho thay bản plugin hiện có; chỉ dùng cho plugin project đã được kiểm tra.
  Setup dùng `--accept-capabilities` cho quyền runtime của plugin đã được duyệt.

## Báo cáo bàn giao

Ghi phiên bản project/host, agentId, Page ID, vị trí config và KB (không giá trị secrets),
chế độ draft/live, kiểm tra đã chạy, phần còn thiếu, cách mở console và rollback.
Nếu thiếu Meta/model/domain, hoàn tất phần local và báo blocker cụ thể; không báo live-ready.

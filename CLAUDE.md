# CLAUDE.md

Hướng dẫn chạy và sửa project này nằm ở **[AGENTS.md](AGENTS.md)** — đọc file đó trước khi làm gì.

Tóm tắt: `./run-tri.sh` (cần `tri-config.json`). Đừng chạy thẳng `tri-script.jsx` khi
chưa có config — script sẽ mở dialog và treo.

**BẮT BUỘC:** trước mỗi lần chạy, dùng `AskUserQuestion` hỏi người dùng: nguồn dữ liệu
(Pháp/Đức, CSV hay Google Sheets), thư mục template (local `PTS/` hay NAS), length rules,
công thức tên file, thư mục output — rồi ghi `tri-config.json` theo câu trả lời.
**Luôn smoke test với `"limit": 2` và mở xem ảnh trước khi chạy full 500 dòng.**

**NAS:** `./nas-mount.sh` (LAN → Tailscale → WebDAV public, cổng WebDAV là **5005**).
Ghi `[NAS]/đường/dẫn` vào config, không ghi cứng mount point.

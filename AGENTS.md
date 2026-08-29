# AGENTS.md — hướng dẫn cho AI agent

Project sinh ảnh PNG hàng loạt từ template Photoshop (.psd), mỗi dòng dữ liệu (tên người)
ra 1 ảnh. Template dùng cho mỗi tên được chọn theo **độ dài tên**.

**Trước mỗi lần chạy, bạn PHẢI hỏi người dùng để điền config** (xem mục ngay dưới).
Đọc hết file trước khi chạy.

## BẮT BUỘC — hỏi người dùng trước khi chạy

**Không được tự chạy config có sẵn.** Dùng `AskUserQuestion` — không đoán, không lấy
giá trị mặc định thay câu trả lời.

### Vòng 1 — nguồn dữ liệu (Pháp hay Đức, CSV hay Sheets)

Hỏi 2 câu gộp một lần:

1. **Ngôn ngữ/nguồn nào** — `Pháp` hay `Đức`.
2. **Lấy dữ liệu từ đâu** — file CSV cạnh script (`fr_name.csv` / `de_name.csv`,
   không cần mạng) hay Google Sheets (luôn mới nhất, cần mạng).

URL sheet mặc định nằm trong `DATA_SOURCES` ở đầu `tri-script.jsx`. Ghi vào config:

```jsonc
"source": "fr_name.csv"                                  // CSV
"source": "https://docs.google.com/spreadsheets/d/..."   // Sheets
"sourceLabel": "Pháp"                                    // chỉ để đọc log cho dễ
```

Script tự nhận biết: bắt đầu bằng `http` → Sheets (tải bằng `curl`), còn lại → file CSV.

### Vòng 2 — thư mục template PSD

Hỏi lấy template ở đâu:

- **Local** — `PTS/` cạnh script (9 file, mỗi file cho 1 độ dài tên).
- **NAS** — mount rồi duyệt chọn, xem mục "NAS" bên dưới.

### Vòng 3 — 3 câu còn lại

1. **Length rules** — mỗi độ dài tên dùng template nào. Tên kết thúc bằng một số,
   như `..._3.psd`, tạo rule đúng một độ dài; tên có khoảng như `5-6.psd` tạo rule
   `min: 5, max: 6`, nên tên dài 5 hoặc 6 ký tự đều dùng template đó. Hỏi người dùng
   xác nhận map này có đúng không.
2. **Tên file output** — `outputFormula`. Token: `[name]`, `[stt]`, `[content]`.
   Mặc định `[[name]][name]-xxx-[stt]`. Nhắc: công thức không có token nào thì
   mọi ảnh trùng tên và ghi đè nhau.
3. **Thư mục output** — `outputFolder`, mặc định `Result`. Nếu đã có ảnh cũ, nói rõ
   ảnh trùng tên sẽ bị ghi đè.

### Sau khi có đủ câu trả lời

1. Ghi `tri-config.json` theo đúng câu trả lời (mẫu: `tri-config.example.json`).
2. **Đọc lại config vừa ghi và tóm tắt** (nguồn, số dòng, thư mục template, output).
3. **Luôn smoke test trước**: đặt `"limit": 2` rồi chạy, **mở xem ảnh** để xác nhận
   chữ đúng, xoá ảnh test đi, rồi mới đổi `limit` về `0` và chạy full.

Chỉ bỏ qua câu hỏi nào người dùng đã nói thẳng trong câu lệnh — các câu còn lại vẫn hỏi,
và vẫn tóm tắt config trước khi chạy.

## Chạy như thế nào

```bash
./run-tri.sh                  # macOS, dùng ./tri-config.json
./run-tri.sh smoke.json       # dùng config khác
```
```bat
run-tri.bat
run-tri.bat smoke.json
```

| Exit code | Nghĩa |
|---|---|
| 0 | Xong, ảnh nằm trong thư mục output |
| 1 | Không tìm thấy config / Photoshop / không mount được NAS |
| 2 | Quá thời gian chờ (chỉ Windows) — Photoshop có thể kẹt ở hộp thoại nào đó |
| 3 | Script chạy nhưng lỗi — đọc `tri-run.log` |

**Đừng chỉ nhìn "lệnh chạy xong" mà kết luận thành công — phải xem exit code.**
Log ở `tri-run.log`, trạng thái cuối (`OK`/`ERROR`) ở `tri-run.done`.

## CẢNH BÁO — đừng làm những việc sau

| Đừng | Vì sao |
|---|---|
| Chạy thẳng `tri-script.jsx` khi không có config | Script mở dialog ScriptUI, bạn không click được → **treo vô hạn** |
| Chạy full ngay để "thử xem có được không" | 500 dòng = 500 ảnh, Photoshop bị chiếm suốt thời gian đó. Dùng `limit` |
| Xoá `Result/` | Có thể chứa ảnh người dùng đã xuất trước đó |

## Config (`tri-config.json`)

| Key | Bắt buộc | Mặc định | Ghi chú |
|---|---|---|---|
| `source` | có | — | Đường dẫn file CSV **hoặc** URL Google Sheets (tự nhận biết bằng `http`) |
| `sourceLabel` | không | `config` | Nhãn cho dễ đọc log (`Pháp` / `Đức`) |
| `templateFolder` | không | tự dò `PTS/` → thư mục script | Dùng `[NAS]/đường/dẫn` cho thư mục trên NAS |
| `outputFolder` | không | `Result/` | Tự tạo nếu chưa có. Dùng được `[NAS]/...` |
| `outputFormula` | không | `[[name]][name]-xxx-[stt]` | `[name]`, `[stt]`, `[content]` |
| `limit` | không | `0` | `0` = chạy hết. `> 0` = chỉ chạy N dòng đầu — dùng để smoke test |
| `rules` | **có** | — | `[{ "min": 3, "max": 3, "template": "x.psd" }]`; tên `5-6.psd` tự tạo `min: 5, max: 6`. `max: null` = không giới hạn trên, phải nằm cuối |

`rules` không được chồng khoảng, script sẽ báo lỗi và dừng.
Tên nào không khớp rule nào thì bị bỏ qua (đếm trong log).

## Script làm gì

Đọc dữ liệu (CSV/Sheets) → cột A = `stt`, cột B = `name`, cột C = `content` →
sắp xếp theo độ dài tên → mỗi dòng: chọn template theo độ dài `name`, mở PSD,
set layer `name` = tên, set layer `first_letter` = ký tự đầu, export PNG, đóng file.

Template PSD cần layer text tên `name` và `first_letter`. Thiếu layer nào thì phần đó
không được thay, script vẫn chạy và export bình thường — nên nếu ảnh ra sai nội dung,
kiểm tra tên layer trong PSD trước tiên.

> **Cột `content` KHÔNG được đổ vào ảnh.** Script chỉ dùng nó cho token `[content]` khi
> đặt tên file. Các dòng chữ kiểu "A – Achtsam, D – Dankbar" trong ảnh là text tĩnh
> nằm sẵn trong PSD, không đổi theo từng tên. Nếu cần đổ `content` vào ảnh thì phải
> sửa `processName()` — hiện chưa làm.

## Yêu cầu môi trường

Cần Adobe Photoshop đã cài. Wrapper tự dò đường dẫn cài đặt.
Nguồn Google Sheets cần `curl` (macOS/Windows 10+ có sẵn) và sheet phải để
**Anyone with link**.

### macOS

**Lần chạy đầu trên máy mới**: macOS hiện hộp thoại xin quyền "Terminal muốn điều khiển
Adobe Photoshop". Đây là dialog hệ thống, **bạn không click được** — phải nhờ người dùng
bấm OK một lần. Lỗi `-1743` / "Not authorized" chính là dấu hiệu: dừng lại, báo người
dùng vào *System Settings → Privacy & Security → Automation*.

### Windows

- `run-tri.bat` dò `Photoshop.exe` trong `%ProgramFiles%\Adobe\Adobe Photoshop*`.
  Cài chỗ khác → đặt biến `TRI_PS_EXE`.
- Photoshop **không tự thoát** sau khi script xong, nên batch chờ bằng cách poll
  `tri-run.done`. Mặc định 60 phút; đổi bằng `TRI_TIMEOUT_SEC`.
- Nếu Photoshop báo lỗi, timeout hoặc không ghi `OK` vào `tri-run.done`, wrapper tự
  đóng Photoshop và thử lại tối đa 3 lần tổng cộng. Đổi số lần thử bằng
  `TRI_MAX_RETRIES` (mặc định `2` lần retry). Vì JSX bỏ qua ảnh đã tồn tại, lần thử
  lại sẽ tiếp tục phần còn thiếu, không xuất lại từ đầu.
- `Photoshop.exe -r` không truyền được tham số → batch ghi đường dẫn config vào
  `tri-config-path.txt`; script đọc rồi tự xoá. Đừng commit hay sửa file tạm này.
- Photoshop đang mở document chưa lưu → hộp thoại lưu file có thể chặn script (exit 2).
  Đóng hết document trước khi chạy.

### NAS (nếu template nằm trên NAS)

> **Ưu tiên chạy local**: nếu template nằm trên NAS, tải PSD về `local-run/tri/PTS/` trước,
> ghi config trỏ local, chạy, rồi upload kết quả lên NAS — đừng để Photoshop đọc/ghi trực
> tiếp qua WebDAV (rất chậm).

Credentials trong `.env` (copy từ `.env.example`, **không commit**).

```bash
MOUNT_POINT=$(./nas-mount.sh)    # macOS  → /Volumes/...
```
```bat
for /f "delims=" %B in ('nas-mount.bat') do set "NAS_BASE=%B"   REM Windows → \\host hoặc Z:
```

Ba tuyến, thử theo thứ tự — tuyến nào không với tới được thì bỏ qua ngay:

| Biến | Tuyến | Khi nào dùng được |
|---|---|---|
| `NAS_URL_1` | LAN `192.168.x.x:5005` | máy ở cùng mạng công ty — nhanh nhất |
| `NAS_URL_2` | Tailscale `100.x.x.x:5005` | máy đã join tailnet, ở đâu cũng được |
| `NAS_URL_3` | WebDAV public `nas.example.com` | fallback cuối |

**Cổng WebDAV của NAS là 5005, không phải 5000** (5000 là giao diện DSM).

**Duyệt theo từng cấp, không quét đệ quy toàn NAS** — WebDAV chậm, quét cả cây sẽ treo
rất lâu. Mỗi cấp: `ls` ra thư mục con và đếm `.psd` ngay trong nó, hỏi người dùng đi tiếp
hay dùng luôn thư mục này.

**Ghi `[NAS]` vào config, KHÔNG ghi mount point thật** — mount point đổi theo tuyến và
theo máy (`/Volumes/100.x.x.x`, `\\192.168.x.x`, `Z:`), ghi cứng thì sang máy khác
sẽ sai đường dẫn. `run-tri.sh` / `run-tri.bat` tự thay `[NAS]` lúc chạy.

> **Phần Windows chưa chạy thử.** `nas-mount.bat` và đoạn resolve `[NAS]` trong
> `run-tri.bat` được viết nhưng chưa test vì máy phát triển là macOS. Chạy lần đầu trên
> Windows phải smoke test với `limit` nhỏ và đọc kỹ log.

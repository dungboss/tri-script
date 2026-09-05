#!/bin/bash
# Chạy tri-script.jsx trong Photoshop mà không cần click dialog — dành cho AI agent / CI.
#
#   ./run-tri.sh                    # dùng ./tri-config.json
#   ./run-tri.sh my-config.json     # dùng config khác
#
# Yêu cầu: file config phải tồn tại, nếu không script sẽ mở dialog và treo.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JSX="$SCRIPT_DIR/tri-script.jsx"

# Nếu có cờ huỷ (do /cancel trên Telegram), thoát ngay — tránh agent retry khởi động lại Photoshop.
if [[ -f "$SCRIPT_DIR/../.cancel-flag" ]]; then
  echo "Có lệnh huỷ trước đó — bỏ qua lần chạy này."
  exit 0
fi
CONFIG="${1:-$SCRIPT_DIR/tri-config.json}"
LOG="$SCRIPT_DIR/tri-run.log"
DONE="$SCRIPT_DIR/tri-run.done"

# Đường dẫn tuyệt đối cho config
[[ "$CONFIG" = /* ]] || CONFIG="$SCRIPT_DIR/$CONFIG"

if [[ ! -f "$CONFIG" ]]; then
  echo "Không tìm thấy config: $CONFIG" >&2
  echo "Copy tri-config.example.json thành tri-config.json rồi sửa lại." >&2
  exit 1
fi

# --- NAS placeholder ---------------------------------------------------------
# Config dùng "[NAS]/..." thay cho đường dẫn tuyệt đối, vì mount point khác nhau tuỳ
# tuyến vào NAS (LAN / tailscale / webdav public). Mount xong mới thay [NAS] bằng
# mount point thật → cùng một config chạy được trên mọi máy.
if grep -q '\[NAS\]' "$CONFIG"; then
  echo "Config có [NAS] → mount NAS..."
  if ! MOUNT_POINT="$("$SCRIPT_DIR/nas-mount.sh")"; then
    echo "Không mount được NAS — xem log phía trên." >&2
    exit 1
  fi
  RESOLVED="$SCRIPT_DIR/.tri-config-resolved.json"
  MOUNT_POINT="$MOUNT_POINT" SRC="$CONFIG" DST="$RESOLVED" python3 - <<'PYEOF'
import json, os
src, dst, mp = os.environ["SRC"], os.environ["DST"], os.environ["MOUNT_POINT"]
with open(src, encoding="utf-8") as f:
    cfg = json.load(f)
for key in ("templateFolder", "outputFolder"):
    v = cfg.get(key)
    if isinstance(v, str) and "[NAS]" in v:
        cfg[key] = v.replace("[NAS]", mp.rstrip("/"))
with open(dst, "w", encoding="utf-8") as f:
    json.dump(cfg, f, ensure_ascii=False, indent=2)
print("templateFolder:", cfg.get("templateFolder"))
PYEOF
  CONFIG="$RESOLVED"
fi

# Tên app Photoshop cài trên máy (Adobe Photoshop 2026, 2025, ...).
# Chỉ lấy application bundle: /Applications có thể còn thư mục cài đặt cũ cùng tên.
PS_BUNDLE="$(find /Applications -maxdepth 2 -type d -name 'Adobe Photoshop*.app' -print 2>/dev/null | sort | tail -n 1)"
if [[ -z "$PS_BUNDLE" ]]; then
  echo "Không tìm thấy Adobe Photoshop trong /Applications" >&2
  exit 1
fi
PS_APP="$(basename "$PS_BUNDLE" .app)"

echo "Photoshop: $PS_APP"
echo "Config:    $CONFIG"

# Config được truyền qua `with arguments` — Photoshop đang chạy sẵn không thấy env của shell.
# TRI_CONFIG chỉ là dự phòng khi Photoshop được khởi động mới từ chính shell này.
export TRI_CONFIG="$CONFIG"

MAX_RETRIES="${TRI_MAX_RETRIES:-2}"
attempt=0
while :; do
  if [[ -f "$SCRIPT_DIR/../.cancel-flag" ]]; then
    echo "Có lệnh huỷ — dừng." >&2
    exit 130
  fi
  rm -f "$DONE"
  set +e
  ERR="$(osascript \
    -e "with timeout of ${TRI_OSA_TIMEOUT:-21600} seconds" \
    -e "tell application \"$PS_APP\" to launch" \
    -e "tell application \"$PS_APP\" to do javascript (file (POSIX file \"$JSX\" as text)) with arguments {\"$CONFIG\"}" \
    -e "end timeout" \
    2>&1 >/dev/null)"
  STATUS=$?
  set -e
  if [[ $STATUS -eq 0 ]]; then break; fi
  if [[ "$ERR" == *"-1743"* || "$ERR" == *"Not authorized"* ]]; then break; fi
  attempt=$((attempt+1))
  if [[ $attempt -gt $MAX_RETRIES ]]; then break; fi
  echo "Photoshop bị lỗi/tắt giữa chừng (lần $attempt/$MAX_RETRIES). Tự chạy lại sau 5s..." >&2
  sleep 5
done

# --- Dọn file tạm (.sb-*, ._*) sinh ra khi Photoshop ghi output (thường qua NAS) ---
cleanup_temp() {
  local out
  out="$(python3 -c 'import json,sys
try:
    cfg=json.load(open(sys.argv[1], encoding="utf-8"))
    v=cfg.get("outputFolder","")
    print(v if isinstance(v,str) else "")
except Exception:
    pass' "$CONFIG" 2>/dev/null)"
  [[ -n "$out" ]] || return 0
  [[ "$out" = /* ]] || out="$SCRIPT_DIR/$out"
  [[ -d "$out" ]] || return 0
  find "$out" -maxdepth 1 \( -name '._*' -o -name '*.sb-*' \) -delete 2>/dev/null || true
}
cleanup_temp

if [[ $STATUS -ne 0 ]]; then
  echo "Lỗi khi gọi Photoshop:" >&2
  echo "$ERR" >&2
  # -1743 = macOS chưa cấp quyền Automation. Hộp thoại xin quyền chỉ người dùng bấm được.
  if [[ "$ERR" == *"-1743"* || "$ERR" == *"Not authorized"* ]]; then
    echo >&2
    echo "macOS chưa cho terminal điều khiển Photoshop." >&2
    echo "Mở System Settings → Privacy & Security → Automation → bật quyền cho terminal," >&2
    echo "rồi chạy lại. Đây là hộp thoại hệ thống, AI agent không tự bấm được." >&2
  fi
  exit $STATUS
fi

echo "--- tri-run.log ---"
[[ -f "$LOG" ]] && cat "$LOG"

# Script ghi OK / ERROR vào tri-run.done khi kết thúc
STATUS="$( [[ -f "$DONE" ]] && cat "$DONE" || echo "MISSING" )"
if [[ "$STATUS" != "OK" ]]; then
  echo >&2
  echo "Script không hoàn tất (trạng thái: $STATUS) — xem log ở trên." >&2
  exit 3
fi

#!/bin/bash
# Mount NAS lên /Volumes để Photoshop mở PSD trực tiếp bằng đường dẫn local.
#
# Thử lần lượt các tuyến NAS_URL_1..N trong .env (LAN → Tailscale → WebDAV public),
# tuyến nào PROPFIND được thì mount tuyến đó.
#
# In ra stdout: đường dẫn mount point (đúng 1 dòng) — script khác capture được.
# Exit: 0 = mount OK | 1 = thiếu config | 2 = không tuyến nào vào được

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { echo "[nas-mount] $*" >&2; }

# --- đọc .env ---------------------------------------------------------------
ENV_FILE="$SCRIPT_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  log "LỖI: không thấy $ENV_FILE — copy .env.example rồi điền credentials."
  exit 1
fi
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

: "${WEBDAV_USERNAME:?thiếu WEBDAV_USERNAME trong .env}"
: "${WEBDAV_PASSWORD:?thiếu WEBDAV_PASSWORD trong .env}"
PROBE_TIMEOUT="${NAS_PROBE_TIMEOUT:-4}"

# Gom NAS_URL_1, NAS_URL_2, ... thành danh sách theo thứ tự
URLS=()
for i in 1 2 3 4 5; do
  var="NAS_URL_$i"
  [[ -n "${!var:-}" ]] && URLS+=("${!var}")
done
if [[ ${#URLS[@]} -eq 0 ]]; then
  log "LỖI: .env không khai báo NAS_URL_1..N"
  exit 1
fi

# --- kiểm tra một tuyến có phải WebDAV sống không ----------------------------
# PROPFIND trả 207 (multistatus) mới là WebDAV thật. Cổng DSM 5000 trả 200 → loại.
probe() {
  local url="$1" code
  code=$(curl -sS --connect-timeout "$PROBE_TIMEOUT" --max-time $((PROBE_TIMEOUT * 3)) \
           -u "$WEBDAV_USERNAME:$WEBDAV_PASSWORD" \
           -X PROPFIND -H 'Depth: 0' "$url" -o /dev/null -w '%{http_code}' 2>/dev/null)
  [[ "$code" == "207" ]]
}

host_of() { echo "$1" | sed -E 's#^[a-z]+://##; s#[:/].*$##'; }

# --- mount ------------------------------------------------------------------
mount_url() {
  local url="$1" host mp
  host="$(host_of "$url")"

  # đã mount sẵn thì dùng lại, khỏi mount chồng
  mp="$(mount | grep webdav | grep -F "$host" \
        | sed -E 's#^.* on (/Volumes/[^(]*) \(.*#\1#' | sed 's/ *$//' | head -1)"
  if [[ -n "$mp" && -d "$mp" ]]; then
    log "đã mount sẵn tại $mp"
    echo "$mp"; return 0
  fi

  osascript >/dev/null 2>&1 <<OSA
try
  mount volume "$url" as user name "$WEBDAV_USERNAME" with password "$WEBDAV_PASSWORD"
on error e number n
  error e number n
end try
OSA
  [[ $? -eq 0 ]] || return 1

  # AppleScript có thể đặt tên volume khác hostname → dò lại từ bảng mount
  mp="$(mount | grep webdav | grep -F "$host" \
        | sed -E 's#^.* on (/Volumes/[^(]*) \(.*#\1#' | sed 's/ *$//' | head -1)"
  [[ -n "$mp" && -d "$mp" ]] || return 1
  log "mount OK: $mp"
  echo "$mp"; return 0
}

for url in "${URLS[@]}"; do
  log "thử $url ..."
  if ! probe "$url"; then
    log "  → không với tới được / không phải WebDAV, bỏ qua"
    continue
  fi
  log "  → WebDAV OK"
  if MP="$(mount_url "$url")"; then
    echo "$MP"
    exit 0
  fi
  log "  → PROPFIND được nhưng mount thất bại, thử tuyến kế"
done

log "LỖI: không tuyến nào vào được NAS. Kiểm tra mạng / tailscale / credentials trong .env."
exit 2

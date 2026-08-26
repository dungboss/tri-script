#!/bin/bash
# Duyệt NAS để tìm thư mục chứa template .psd.
#
#   ./nas-browse.sh                        liệt kê thư mục gốc NAS
#   ./nas-browse.sh "Team Media"           liệt kê cấp con, kèm số .psd
#   ./nas-browse.sh --find "Team Media" 4  dò sâu tìm thư mục có .psd (mặc định 4 cấp)
#
# Vì sao cần script này: WebDAV chậm và PSD thường nằm sâu 3-5 cấp, nên `ls` từng cấp
# sẽ thấy 0 file .psd ở mọi thư mục và không biết đi tiếp vào đâu. Cột DEEP dò trước
# vài cấp để biết nhánh nào còn PSD bên dưới.
#
# Mọi lệnh dò đều có timeout — WebDAV treo thì bỏ qua, không đứng vô hạn.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DEEP_PROBE_DEPTH="${NAS_DEEP_DEPTH:-2}"        # số cấp dò thêm cho cột DEEP (chỉ khi --deep)
PROBE_TIMEOUT="${NAS_PROBE_TIMEOUT_LS:-25}"    # giây, cho mỗi lần dò DEEP
FIND_TIMEOUT="${NAS_FIND_TIMEOUT:-90}"         # giây, cho chế độ --find
WANT_DEEP=0

log() { echo "$*" >&2; }

# macOS không có lệnh `timeout` → tự dựng: chạy nền, quá giờ thì kill
# Trả 124 khi hết giờ (giống lệnh `timeout` của GNU) để bên gọi phân biệt được
# "dò xong, không có gì" với "dò chưa xong đã bị cắt".
run_with_timeout() {
  local secs="$1"; shift
  "$@" &
  local pid=$!
  ( sleep "$secs"; kill -9 "$pid" 2>/dev/null ) 2>/dev/null &
  local watcher=$!
  wait "$pid" 2>/dev/null
  local rc=$?
  kill -9 "$watcher" 2>/dev/null
  # bị kill -9 → shell báo 137
  [[ $rc -eq 137 ]] && return 124
  return $rc
}

# --- lấy mount point -------------------------------------------------------
MOUNT_POINT="$("$SCRIPT_DIR/nas-mount.sh")" || {
  log "Không mount được NAS."
  exit 2
}

MODE="list"
while true; do
  case "${1:-}" in
    --find) MODE="find"; shift ;;
    --deep) WANT_DEEP=1; shift ;;
    *) break ;;
  esac
done

REL="${1:-}"
MAXDEPTH="${2:-4}"

# Đường dẫn tuyệt đối thì dùng thẳng, tương đối thì ghép vào mount point
if [[ "$REL" = /* ]]; then
  TARGET="$REL"
else
  TARGET="$MOUNT_POINT${REL:+/$REL}"
fi

if [[ ! -d "$TARGET" ]]; then
  log "Không thấy thư mục: $TARGET"
  exit 1
fi

count_psd_here() { ls -1 "$1" 2>/dev/null | grep -ci '\.psd$'; }

# --- chế độ --find: liệt kê mọi thư mục có .psd trong N cấp ------------------
if [[ "$MODE" == "find" ]]; then
  log "Dò .psd trong \"$TARGET\" (tối đa $MAXDEPTH cấp, timeout ${FIND_TIMEOUT}s)..."
  OUT=$(run_with_timeout "$FIND_TIMEOUT" \
        find "$TARGET" -maxdepth "$MAXDEPTH" -iname "*.psd" -not -path "*/#recycle/*" 2>/dev/null)
  RC=$?

  if [[ $RC -eq 124 ]]; then
    log ""
    log "HẾT GIỜ sau ${FIND_TIMEOUT}s — thư mục quá lớn, CHƯA dò xong."
    log "Đây KHÔNG phải là 'không có .psd'. Hãy thu hẹp phạm vi:"
    log "  ./nas-browse.sh \"$REL\"                 # xem cấp con, chọn nhánh hẹp hơn"
    log "  ./nas-browse.sh --find \"$REL/<nhánh>\" $MAXDEPTH"
    log "hoặc tăng giờ:  NAS_FIND_TIMEOUT=180 ./nas-browse.sh --find \"$REL\" $MAXDEPTH"
    exit 3
  fi

  if [[ -z "$OUT" ]]; then
    log "Dò xong $MAXDEPTH cấp, không có .psd nào. Thử tăng số cấp: ./nas-browse.sh --find \"$REL\" $((MAXDEPTH + 2))"
    exit 0
  fi
  # Gom theo thư mục cha, đếm số file
  echo "$OUT" | sed 's#/[^/]*$##' | sort | uniq -c | sort -rn \
    | awk '{ n=$1; $1=""; sub(/^ /,""); printf "PSD=%-4s %s\n", n, $0 }'
  exit 0
fi

# --- chế độ mặc định: liệt kê cấp con --------------------------------------
echo "# $TARGET"
printf "%-6s %-6s %-6s %s\n" "PSD" "SUB" "DEEP" "TÊN"

here=$(count_psd_here "$TARGET")
printf "%-6s %-6s %-6s %s\n" "$here" "-" "-" "(chính thư mục này)"

# Dò song song cho nhanh — WebDAV chậm chủ yếu vì độ trễ, không phải băng thông
tmp=$(mktemp -d)
i=0
while IFS= read -r d; do
  [[ -z "$d" ]] && continue
  i=$((i + 1))
  (
    name="$(basename "$d")"
    psd=$(count_psd_here "$d")
    sub=$(ls -1 "$d" 2>/dev/null | wc -l | tr -d ' ')
    # DEEP chỉ chạy khi có --deep: trên NAS lớn nó rất chậm và hay hết giờ
    mark="?"
    if [[ $WANT_DEEP -eq 1 ]]; then
      deep=$(run_with_timeout "$PROBE_TIMEOUT" \
             find "$d" -maxdepth "$DEEP_PROBE_DEPTH" -iname "*.psd" 2>/dev/null | head -1)
      drc=$?
      if [[ $drc -eq 124 ]]; then mark="hết giờ"
      elif [[ -n "$deep" ]]; then mark="có"
      else mark="-"; fi
    fi
    printf "%-6s %-6s %-6s %s\n" "$psd" "$sub" "$mark" "$name" > "$tmp/$i.row"
  ) &
done < <(find "$TARGET" -maxdepth 1 -type d -not -path "$TARGET" 2>/dev/null | sort)

wait
cat "$tmp"/*.row 2>/dev/null | sort -k4
rm -rf "$tmp"

echo
echo "# PSD = số .psd ngay trong thư mục | SUB = số mục con"
if [[ $WANT_DEEP -eq 1 ]]; then
  echo "# DEEP = còn .psd sâu hơn không (dò $DEEP_PROBE_DEPTH cấp)"
else
  echo "# DEEP = '?' vì chưa dò sâu. Thêm --deep để dò (chậm trên thư mục lớn)."
fi
echo "# Đi tiếp:  ./nas-browse.sh \"${REL:+$REL/}<tên>\""
echo "# Tìm .psd: ./nas-browse.sh --find \"${REL:-.}\" 4"

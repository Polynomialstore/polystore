#!/usr/bin/env bash
#
# Provider local-deal cleanup helper (trusted devnet).
# - Dry-run by default.
# - Removes only expired/orphan manifest directories when --apply is set.
#
# This is intended for provider hosts where old/partial slabs can create noisy
# system-liveness retries.

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/devnet_provider_cleanup.sh [flags]

Flags:
  --provider-root DIR   Root containing provider homes (default: /var/lib/polystore/providers)
  --lcd URL             LCD base URL (default: http://127.0.0.1:1317)
  --apply               Apply removals (default: dry-run)
  -h, --help            Show this help

Behavior:
  - Scans <provider>/uploads/deals/<deal_id>/<manifest_key>/ directories.
  - Queries deal state from LCD.
  - Marks directory as:
      * orphan  -> deal missing on-chain (404)
      * expired -> current height >= deal end_block
      * stale   -> directory manifest key != current on-chain manifest key
  - --apply removes only orphan + expired directories.
    stale entries are reported only (manual review).
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: missing required command: $1" >&2
    exit 127
  fi
}

PROVIDER_ROOT="/var/lib/polystore/providers"
LCD_BASE="http://127.0.0.1:1317"
APPLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --provider-root)
      PROVIDER_ROOT="$2"
      shift 2
      ;;
    --lcd)
      LCD_BASE="${2%/}"
      shift 2
      ;;
    --apply)
      APPLY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

require_cmd curl
require_cmd python3

if [[ ! -d "$PROVIDER_ROOT" ]]; then
  echo "ERROR: provider root does not exist: $PROVIDER_ROOT" >&2
  exit 1
fi

HEIGHT_JSON="$(curl -fsS "$LCD_BASE/cosmos/base/tendermint/v1beta1/blocks/latest")"
CURRENT_HEIGHT="$(printf '%s' "$HEIGHT_JSON" | python3 -c '
import json, sys
obj = json.load(sys.stdin)
h = ((obj.get("block") or {}).get("header") or {}).get("height", "0")
try:
    print(int(str(h).strip() or "0"))
except Exception:
    print(0)
')"

if [[ "$CURRENT_HEIGHT" -le 0 ]]; then
  echo "ERROR: failed to resolve current height from LCD" >&2
  exit 1
fi

declare -A DEAL_STATUS
declare -A DEAL_END
declare -A DEAL_ROOT

resolve_deal() {
  local deal_id="$1"
  if [[ -n "${DEAL_STATUS[$deal_id]:-}" ]]; then
    return
  fi

  local tmp
  tmp="$(mktemp)"
  local code
  code="$(curl -sS -o "$tmp" -w '%{http_code}' "$LCD_BASE/polystorechain/polystorechain/v1/deals/$deal_id" || true)"
  if [[ "$code" == "404" ]]; then
    DEAL_STATUS[$deal_id]="missing"
    DEAL_END[$deal_id]="0"
    DEAL_ROOT[$deal_id]=""
    rm -f "$tmp"
    return
  fi
  if [[ "$code" != "200" ]]; then
    DEAL_STATUS[$deal_id]="error"
    DEAL_END[$deal_id]="0"
    DEAL_ROOT[$deal_id]=""
    echo "WARN: LCD lookup for deal $deal_id returned HTTP $code" >&2
    rm -f "$tmp"
    return
  fi

  read -r end_block root_key < <(
    python3 - <<'PY' "$tmp"
import base64, json, sys
path=sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    obj=json.load(f)
d=obj.get("deal") or {}
end_raw=d.get("end_block", d.get("endBlock", 0))
try:
    end_block=int(str(end_raw).strip() or "0")
except Exception:
    end_block=0
mr=(d.get("manifest_root", d.get("manifestRoot", "")) or "").strip()
root_key=""
if mr:
    if mr.startswith("0x") or mr.startswith("0X"):
        root_key=mr[2:].lower()
    else:
        try:
            root_key=base64.b64decode(mr).hex()
        except Exception:
            root_key=mr.lower()
print(end_block, root_key)
PY
  )
  DEAL_STATUS[$deal_id]="ok"
  DEAL_END[$deal_id]="$end_block"
  DEAL_ROOT[$deal_id]="$root_key"
  rm -f "$tmp"
}

echo "Provider root: $PROVIDER_ROOT"
echo "LCD base:      $LCD_BASE"
echo "Height:        $CURRENT_HEIGHT"
if [[ "$APPLY" -eq 1 ]]; then
  echo "Mode:          APPLY (removing orphan/expired directories)"
else
  echo "Mode:          DRY-RUN"
fi
echo

count_orphan=0
count_expired=0
count_stale=0
count_removed=0

shopt -s nullglob
for provider_dir in "$PROVIDER_ROOT"/*; do
  [[ -d "$provider_dir" ]] || continue
  deals_root="$provider_dir/uploads/deals"
  [[ -d "$deals_root" ]] || continue

  echo "==> Provider: $provider_dir"
  for deal_dir in "$deals_root"/*; do
    [[ -d "$deal_dir" ]] || continue
    deal_id="$(basename "$deal_dir")"
    if [[ ! "$deal_id" =~ ^[0-9]+$ ]]; then
      continue
    fi

    resolve_deal "$deal_id"
    status="${DEAL_STATUS[$deal_id]}"
    end_block="${DEAL_END[$deal_id]}"
    root_key="${DEAL_ROOT[$deal_id]}"

    for manifest_dir in "$deal_dir"/*; do
      [[ -d "$manifest_dir" ]] || continue
      manifest_key="$(basename "$manifest_dir")"
      reason=""
      removable=0

      if [[ "$status" == "missing" ]]; then
        reason="orphan"
        removable=1
        count_orphan=$((count_orphan + 1))
      elif [[ "$status" == "ok" && "$end_block" -gt 0 && "$CURRENT_HEIGHT" -ge "$end_block" ]]; then
        reason="expired(end_block=$end_block)"
        removable=1
        count_expired=$((count_expired + 1))
      elif [[ "$status" == "ok" && -n "$root_key" && "$manifest_key" != "$root_key" ]]; then
        reason="stale(current_manifest=$root_key)"
        removable=0
        count_stale=$((count_stale + 1))
      fi

      if [[ -n "$reason" ]]; then
        echo "  - $manifest_dir [$reason]"
        if [[ "$APPLY" -eq 1 && "$removable" -eq 1 ]]; then
          rm -rf "$manifest_dir"
          count_removed=$((count_removed + 1))
          echo "    removed"
        fi
      fi
    done

    if [[ "$APPLY" -eq 1 ]] && [[ -d "$deal_dir" ]]; then
      if [[ -z "$(find "$deal_dir" -mindepth 1 -maxdepth 1 -type d -print -quit)" ]]; then
        rmdir "$deal_dir" 2>/dev/null || true
      fi
    fi
  done
done

echo
echo "Summary:"
echo "  orphan dirs:  $count_orphan"
echo "  expired dirs: $count_expired"
echo "  stale dirs:   $count_stale (reported only)"
if [[ "$APPLY" -eq 1 ]]; then
  echo "  removed dirs: $count_removed"
fi

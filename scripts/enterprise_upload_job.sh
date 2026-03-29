#!/usr/bin/env bash
set -euo pipefail

#
# Enterprise upload job runner (devnet):
# - Creates (optional) deal via /gateway/create-deal-evm
# - Uploads a file into a deal via /gateway/upload (Mode 2 fast path when gateway available)
# - Commits manifest_root on-chain via /gateway/update-deal-content-evm
#
# Requires:
# - node/tsx deps installed in `nil-website/` (for signing intents)
# - EVM_PRIVKEY set (delegated uploader key)
#

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

FILE_PATH="${1:-}"
DEAL_ID="${2:-}"
NILFS_PATH="${3:-}"

if [[ -z "${FILE_PATH}" ]]; then
  echo "usage: $0 <file_path> [deal_id] [nilfs_path]" >&2
  exit 1
fi

if [[ ! -f "${FILE_PATH}" ]]; then
  echo "error: file not found: ${FILE_PATH}" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required" >&2
  exit 1
fi

GATEWAY_BASE="${GATEWAY_BASE:-http://localhost:8080}"
LCD_BASE="${LCD_BASE:-http://localhost:1317}"
EVM_CHAIN_ID="${EVM_CHAIN_ID:-31337}"
CHAIN_ID="${CHAIN_ID:-31337}"
SERVICE_HINT="${SERVICE_HINT:-General}"
UPLOAD_STATUS_TIMEOUT_SECS="${UPLOAD_STATUS_TIMEOUT_SECS:-300}"
UPLOAD_STATUS_POLL_INTERVAL_SECS="${UPLOAD_STATUS_POLL_INTERVAL_SECS:-2}"

if [[ -z "${EVM_PRIVKEY:-}" ]]; then
  echo "error: EVM_PRIVKEY env var required" >&2
  exit 1
fi

FILE_NAME="$(basename "${FILE_PATH}")"
FILE_SIZE_BYTES="$(wc -c <"${FILE_PATH}" | tr -d '[:space:]')"

if [[ -z "${NILFS_PATH}" ]]; then
  NILFS_PATH="${FILE_NAME}"
fi

sign_intent() {
  local mode="$1"
  shift
  (
    cd "$ROOT_DIR/nil-website"
    # Ensure dependencies are present (CI/dev stacks do this already).
    if [[ ! -d node_modules ]]; then
      npm install >/dev/null
    fi
    EVM_PRIVKEY="$EVM_PRIVKEY" \
    EVM_CHAIN_ID="$EVM_CHAIN_ID" \
    CHAIN_ID="$CHAIN_ID" \
    SERVICE_HINT="$SERVICE_HINT" \
    "$ROOT_DIR/nil-website/node_modules/.bin/tsx" "$ROOT_DIR/nil-website/scripts/sign_intent.ts" "$mode"
  )
}

if [[ -z "${DEAL_ID}" ]]; then
  echo ">> Creating deal..."
  CREATE_JSON="$(sign_intent create-deal)"
  CREATE_RESP="$(curl -sS -X POST "${GATEWAY_BASE}/gateway/create-deal-evm" \
    -H 'Content-Type: application/json' \
    --data "${CREATE_JSON}")"

  DEAL_ID="$(printf '%s' "${CREATE_RESP}" | jq -r '.deal_id // ""' 2>/dev/null || true)"

  if [[ -z "${DEAL_ID}" ]]; then
    echo "error: failed to create deal. response: ${CREATE_RESP}" >&2
    exit 1
  fi
fi

echo ">> Using deal_id=${DEAL_ID}"

UPLOAD_ID="$(python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
)"

echo ">> Uploading file via gateway (upload_id=${UPLOAD_ID})..."
UPLOAD_RESP="$(curl -sS -X POST "${GATEWAY_BASE}/gateway/upload?deal_id=${DEAL_ID}&upload_id=${UPLOAD_ID}" \
  -F "deal_id=${DEAL_ID}" \
  -F "file_path=${NILFS_PATH}" \
  -F "upload_id=${UPLOAD_ID}" \
  -F "file_size_bytes=${FILE_SIZE_BYTES}" \
  -F "file=@${FILE_PATH}")"

MANIFEST_ROOT="$(printf '%s' "${UPLOAD_RESP}" | jq -r '(.result.manifest_root // .manifest_root // .cid // "") | tostring' 2>/dev/null || true)"
SIZE_BYTES="$(printf '%s' "${UPLOAD_RESP}" | jq -r '(.result.size_bytes // .size_bytes // .result.file_size_bytes // .file_size_bytes // 0) | tonumber? // 0' 2>/dev/null || echo 0)"
TOTAL_MDUS="$(printf '%s' "${UPLOAD_RESP}" | jq -r '(.result.total_mdus // .total_mdus // .result.totalMdus // .totalMdus // .result.allocated_length // .allocated_length // 0) | tonumber? // 0' 2>/dev/null || echo 0)"
WITNESS_MDUS="$(printf '%s' "${UPLOAD_RESP}" | jq -r '(.result.witness_mdus // .witness_mdus // .result.witnessMdus // .witnessMdus // 0) | tonumber? // 0' 2>/dev/null || echo 0)"

UPLOAD_STATUS="$(printf '%s' "${UPLOAD_RESP}" | jq -r '(.status // "") | ascii_downcase' 2>/dev/null || true)"
STATUS_URL="$(printf '%s' "${UPLOAD_RESP}" | jq -r '(.status_url // "") | tostring' 2>/dev/null || true)"

if [[ -z "${MANIFEST_ROOT}" && ( "${UPLOAD_STATUS}" == "accepted" || "${UPLOAD_STATUS}" == "running" || -n "${STATUS_URL}" ) ]]; then
  if [[ -z "${STATUS_URL}" ]]; then
    STATUS_URL="${GATEWAY_BASE}/gateway/upload-status?deal_id=${DEAL_ID}&upload_id=${UPLOAD_ID}"
  fi
  echo ">> Upload accepted asynchronously. Polling status..."

  poll_started_at="$(date +%s)"
  poll_attempt=0
  last_status_payload=""

  while true; do
    poll_attempt=$((poll_attempt + 1))

    now_ts="$(date +%s)"
    if (( now_ts - poll_started_at > UPLOAD_STATUS_TIMEOUT_SECS )); then
      echo "error: timed out waiting for upload completion after ${UPLOAD_STATUS_TIMEOUT_SECS}s. last_status=${last_status_payload}" >&2
      exit 1
    fi

    if ! poll_resp="$(curl -sS -w $'\n%{http_code}' "${STATUS_URL}")"; then
      sleep "${UPLOAD_STATUS_POLL_INTERVAL_SECS}"
      continue
    fi

    poll_http_code="$(printf '%s' "${poll_resp}" | tail -n1)"
    poll_body="$(printf '%s' "${poll_resp}" | sed '$d')"
    last_status_payload="${poll_body}"

    if [[ "${poll_http_code}" != "200" ]]; then
      if [[ "${poll_http_code}" == "404" || "${poll_http_code}" == "429" || "${poll_http_code}" == "503" ]]; then
        sleep "${UPLOAD_STATUS_POLL_INTERVAL_SECS}"
        continue
      fi
      echo "error: upload status poll failed (HTTP ${poll_http_code}): ${poll_body}" >&2
      exit 1
    fi

    poll_status="$(printf '%s' "${poll_body}" | jq -r '(.status // "") | ascii_downcase' 2>/dev/null || true)"
    if [[ "${poll_status}" == "error" ]]; then
      poll_error="$(printf '%s' "${poll_body}" | jq -r '(.error // .message // "unknown upload error") | tostring' 2>/dev/null || true)"
      echo "error: upload failed: ${poll_error}" >&2
      exit 1
    fi

    if [[ "${poll_status}" == "success" ]]; then
      UPLOAD_RESP="${poll_body}"
      MANIFEST_ROOT="$(printf '%s' "${UPLOAD_RESP}" | jq -r '(.result.manifest_root // .manifest_root // .cid // "") | tostring' 2>/dev/null || true)"
      SIZE_BYTES="$(printf '%s' "${UPLOAD_RESP}" | jq -r '(.result.size_bytes // .size_bytes // .result.file_size_bytes // .file_size_bytes // 0) | tonumber? // 0' 2>/dev/null || echo 0)"
      TOTAL_MDUS="$(printf '%s' "${UPLOAD_RESP}" | jq -r '(.result.total_mdus // .total_mdus // .result.totalMdus // .totalMdus // .result.allocated_length // .allocated_length // 0) | tonumber? // 0' 2>/dev/null || echo 0)"
      WITNESS_MDUS="$(printf '%s' "${UPLOAD_RESP}" | jq -r '(.result.witness_mdus // .witness_mdus // .result.witnessMdus // .witnessMdus // 0) | tonumber? // 0' 2>/dev/null || echo 0)"
      break
    fi

    sleep "${UPLOAD_STATUS_POLL_INTERVAL_SECS}"
  done
fi

if [[ -z "${MANIFEST_ROOT}" ]]; then
  echo "error: gateway upload returned no manifest_root. response: ${UPLOAD_RESP}" >&2
  exit 1
fi
if [[ "${SIZE_BYTES}" == "0" ]]; then
  echo "error: gateway upload returned invalid size_bytes. response: ${UPLOAD_RESP}" >&2
  exit 1
fi

echo ">> Upload complete. manifest_root=${MANIFEST_ROOT} size_bytes=${SIZE_BYTES}"
echo ">> Slab counts. total_mdus=${TOTAL_MDUS} witness_mdus=${WITNESS_MDUS}"

echo ">> Committing deal content (EVM intent relay)..."
UPDATE_JSON="$((
  cd "$ROOT_DIR/nil-website"
  EVM_PRIVKEY="$EVM_PRIVKEY" \
  EVM_CHAIN_ID="$EVM_CHAIN_ID" \
  CHAIN_ID="$CHAIN_ID" \
  CID="$MANIFEST_ROOT" \
  DEAL_ID="$DEAL_ID" \
  SIZE_BYTES="$SIZE_BYTES" \
  TOTAL_MDUS="$TOTAL_MDUS" \
  WITNESS_MDUS="$WITNESS_MDUS" \
  "$ROOT_DIR/nil-website/node_modules/.bin/tsx" "$ROOT_DIR/nil-website/scripts/sign_intent.ts" update-content
))"

UPDATE_RESP="$(curl -sS -X POST "${GATEWAY_BASE}/gateway/update-deal-content-evm" \
  -H 'Content-Type: application/json' \
  --data "${UPDATE_JSON}")"

TX_HASH="$(printf '%s' "${UPDATE_RESP}" | jq -r '.tx_hash // ""' 2>/dev/null || true)"

if [[ -z "${TX_HASH}" ]]; then
  echo "error: commit failed. response: ${UPDATE_RESP}" >&2
  exit 1
fi

echo ">> Commit sent: tx_hash=${TX_HASH}"
echo ">> Done."
echo "deal_id=${DEAL_ID}"
echo "manifest_root=${MANIFEST_ROOT}"
echo "nilfs_path=${NILFS_PATH}"

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

GATEWAY_BASE="${GATEWAY_BASE:-http://localhost:8080}"
LCD_BASE="${LCD_BASE:-http://localhost:1317}"
EVM_CHAIN_ID="${EVM_CHAIN_ID:-31337}"
CHAIN_ID="${CHAIN_ID:-31337}"
SERVICE_HINT="${SERVICE_HINT:-General}"

if [[ -z "${EVM_PRIVKEY:-}" ]]; then
  echo "error: EVM_PRIVKEY env var required" >&2
  exit 1
fi

FILE_NAME="$(basename "${FILE_PATH}")"
FILE_SIZE_BYTES="$(python3 - <<'PY'
import os, sys
print(os.path.getsize(sys.argv[1]))
PY
"${FILE_PATH}")"

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

  DEAL_ID="$(python3 - <<'PY'
import json, sys
doc = json.loads(sys.argv[1])
print(doc.get("deal_id",""))
PY
"${CREATE_RESP}")"

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

MANIFEST_ROOT="$(python3 - <<'PY'
import json, sys
doc = json.loads(sys.argv[1])
root = (doc.get("manifest_root") or doc.get("cid") or "").strip()
print(root)
PY
"${UPLOAD_RESP}")"

SIZE_BYTES="$(python3 - <<'PY'
import json, sys
doc = json.loads(sys.argv[1])
size = doc.get("size_bytes") or doc.get("file_size_bytes") or 0
try:
  print(int(size))
except Exception:
  print(0)
PY
"${UPLOAD_RESP}")"

if [[ -z "${MANIFEST_ROOT}" ]]; then
  echo "error: gateway upload returned no manifest_root. response: ${UPLOAD_RESP}" >&2
  exit 1
fi
if [[ "${SIZE_BYTES}" == "0" ]]; then
  echo "error: gateway upload returned invalid size_bytes. response: ${UPLOAD_RESP}" >&2
  exit 1
fi

echo ">> Upload complete. manifest_root=${MANIFEST_ROOT} size_bytes=${SIZE_BYTES}"

echo ">> Committing deal content (EVM intent relay)..."
UPDATE_JSON="$((
  cd "$ROOT_DIR/nil-website"
  EVM_PRIVKEY="$EVM_PRIVKEY" \
  EVM_CHAIN_ID="$EVM_CHAIN_ID" \
  CHAIN_ID="$CHAIN_ID" \
  CID="$MANIFEST_ROOT" \
  DEAL_ID="$DEAL_ID" \
  SIZE_BYTES="$SIZE_BYTES" \
  "$ROOT_DIR/nil-website/node_modules/.bin/tsx" "$ROOT_DIR/nil-website/scripts/sign_intent.ts" update-content
))"

UPDATE_RESP="$(curl -sS -X POST "${GATEWAY_BASE}/gateway/update-deal-content-evm" \
  -H 'Content-Type: application/json' \
  --data "${UPDATE_JSON}")"

TX_HASH="$(python3 - <<'PY'
import json, sys
doc = json.loads(sys.argv[1])
print((doc.get("tx_hash") or "").strip())
PY
"${UPDATE_RESP}")"

if [[ -z "${TX_HASH}" ]]; then
  echo "error: commit failed. response: ${UPDATE_RESP}" >&2
  exit 1
fi

echo ">> Commit sent: tx_hash=${TX_HASH}"
echo ">> Done."
echo "deal_id=${DEAL_ID}"
echo "manifest_root=${MANIFEST_ROOT}"
echo "nilfs_path=${NILFS_PATH}"


#!/usr/bin/env bash
set -euo pipefail

#
# Enterprise upload job runner (devnet):
# - Creates (optional) deal via /gateway/create-deal-evm or direct nilchaind tx
# - Uploads a file into a deal via /gateway/upload (Mode 2 fast path when gateway available)
# - Commits manifest_root on-chain via /gateway/update-deal-content-evm or direct nilchaind tx
#
# Requires:
# - node/tsx deps installed in `nil-website/` (for signing intents)
# - EVM_PRIVKEY set (delegated uploader key)
# - local gateway available at GATEWAY_BASE for /gateway/upload
#

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/load_testnet_public_env.sh"

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
LCD_BASE="${LCD_BASE:-${NILSTORE_TESTNET_LCD_BASE:-http://localhost:1317}}"
NIL_NODE="${NIL_NODE:-${NILSTORE_TESTNET_NODE:-tcp://127.0.0.1:26657}}"
EVM_CHAIN_ID="${EVM_CHAIN_ID:-${NILSTORE_TESTNET_CHAIN_ID:-31337}}"
CHAIN_ID="${CHAIN_ID:-${NILSTORE_TESTNET_CHAIN_ID:-31337}}"
SERVICE_HINT="${SERVICE_HINT:-General}"
UPLOAD_STATUS_TIMEOUT_SECS="${UPLOAD_STATUS_TIMEOUT_SECS:-300}"
UPLOAD_STATUS_POLL_INTERVAL_SECS="${UPLOAD_STATUS_POLL_INTERVAL_SECS:-2}"
TX_SUBMIT_MODE="${NIL_TX_SUBMIT_MODE:-gateway}"
NILCHAIND_BIN="${NILCHAIND_BIN:-nilchaind}"
NIL_GAS_PRICES="${NIL_GAS_PRICES:-${NILSTORE_TESTNET_GAS_PRICES:-0.001aatom}}"
NIL_TX_SENDER_KEY="${NIL_TX_SENDER_KEY:-${NILSTORE_TESTNET_TX_SENDER_KEY:-faucet}}"
NIL_TX_SENDER_HOME="${NIL_TX_SENDER_HOME:-$ROOT_DIR/_artifacts/testnet_tx_sender_home}"
NIL_TX_SENDER_MNEMONIC="${NIL_TX_SENDER_MNEMONIC:-${NILSTORE_TESTNET_TX_SENDER_MNEMONIC:-}}"
CREATE_NONCE="${CREATE_NONCE:-1}"
UPDATE_NONCE="${UPDATE_NONCE:-}"
EVM_NONCE_RETRY_ATTEMPTS="${EVM_NONCE_RETRY_ATTEMPTS:-8}"

if [[ -z "${EVM_PRIVKEY:-}" ]]; then
  echo "error: EVM_PRIVKEY env var required" >&2
  exit 1
fi

require_bin() {
  local bin="$1"
  if [[ "$bin" == */* ]]; then
    if [[ ! -x "$bin" ]]; then
      echo "error: required executable not found: $bin" >&2
      exit 1
    fi
    return
  fi
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "error: required command not found: $bin" >&2
    exit 1
  fi
}

extract_json_body() {
  printf '%s\n' "$1" | sed -n '/^{/,$p'
}

is_bridge_nonce_error() {
  grep -q "bridge nonce must be strictly increasing" <<<"$1"
}

is_account_sequence_error() {
  grep -q "account sequence mismatch" <<<"$1"
}

ensure_tx_sender_key() {
  require_bin "$NILCHAIND_BIN"

  if "$NILCHAIND_BIN" keys show "$NIL_TX_SENDER_KEY" --keyring-backend test --home "$NIL_TX_SENDER_HOME" >/dev/null 2>&1; then
    return
  fi

  if [[ -z "$NIL_TX_SENDER_MNEMONIC" ]]; then
    echo "error: NIL_TX_SENDER_MNEMONIC is required for direct tx submission" >&2
    exit 1
  fi

  mkdir -p "$NIL_TX_SENDER_HOME"
  printf '%s\n' "$NIL_TX_SENDER_MNEMONIC" | "$NILCHAIND_BIN" keys add "$NIL_TX_SENDER_KEY" \
    --recover \
    --keyring-backend test \
    --home "$NIL_TX_SENDER_HOME" >/dev/null
}

poll_tx_body() {
  local tx_hash="$1"
  local attempt

  for attempt in $(seq 1 20); do
    local resp http_code body
    resp="$(curl -sS -w $'\n%{http_code}' "$LCD_BASE/cosmos/tx/v1beta1/txs/$tx_hash" || true)"
    http_code="$(printf '%s' "$resp" | tail -n1)"
    body="$(printf '%s' "$resp" | sed '$d')"

    if [[ "$http_code" == "200" ]]; then
      printf '%s' "$body"
      return 0
    fi

    sleep 1
  done

  return 1
}

direct_create_deal() {
  local payload_json payload_file create_out tx_json tx_hash tx_code tx_body deal_id list_out max_id
  local current_nonce raw_log cmd_status attempt

  ensure_tx_sender_key
  current_nonce="$CREATE_NONCE"

  for attempt in $(seq 1 "$EVM_NONCE_RETRY_ATTEMPTS"); do
    payload_json="$(sign_intent create-deal "$current_nonce")"
    payload_json="$(printf '%s' "$payload_json" | jq -c '
      .intent.duration_blocks = (
        .intent.duration_blocks // .intent.duration_seconds // 0
      )
    ')"
    payload_file="$(mktemp "${TMPDIR:-/tmp}/nilstore-create-deal-XXXXXX")"
    printf '%s\n' "$payload_json" >"$payload_file"

    cmd_status=0
    create_out="$("$NILCHAIND_BIN" tx nilchain create-deal-from-evm "$payload_file" \
      --node "$NIL_NODE" \
      --chain-id "$CHAIN_ID" \
      --from "$NIL_TX_SENDER_KEY" \
      --yes \
      --keyring-backend test \
      --home "$NIL_TX_SENDER_HOME" \
      --gas-prices "$NIL_GAS_PRICES" \
      --broadcast-mode sync \
      --output json 2>&1)" || cmd_status=$?

    if (( cmd_status != 0 )); then
      rm -f "$payload_file"
      if is_bridge_nonce_error "$create_out" && (( attempt < EVM_NONCE_RETRY_ATTEMPTS )); then
        current_nonce=$((current_nonce + 1))
        continue
      fi
      if is_account_sequence_error "$create_out" && (( attempt < EVM_NONCE_RETRY_ATTEMPTS )); then
        sleep 1
        continue
      fi
      echo "error: create-deal-from-evm failed: $create_out" >&2
      exit 1
    fi

    tx_json="$(extract_json_body "$create_out")"
    tx_hash="$(printf '%s' "$tx_json" | jq -r '.txhash // ""' 2>/dev/null || true)"
    tx_code="$(printf '%s' "$tx_json" | jq -r '.code // 0' 2>/dev/null || echo 0)"
    raw_log="$(printf '%s' "$tx_json" | jq -r '.raw_log // ""' 2>/dev/null || true)"
    if [[ -z "$tx_hash" || "$tx_code" != "0" ]]; then
      rm -f "$payload_file"
      if is_bridge_nonce_error "$raw_log" && (( attempt < EVM_NONCE_RETRY_ATTEMPTS )); then
        current_nonce=$((current_nonce + 1))
        continue
      fi
      if is_account_sequence_error "$raw_log" && (( attempt < EVM_NONCE_RETRY_ATTEMPTS )); then
        sleep 1
        continue
      fi
      echo "error: create-deal-from-evm returned invalid response: $create_out" >&2
      exit 1
    fi

    tx_body="$(poll_tx_body "$tx_hash")" || {
      rm -f "$payload_file"
      echo "error: create tx not confirmed on LCD within timeout: $tx_hash" >&2
      exit 1
    }

    raw_log="$(printf '%s' "$tx_body" | jq -r '.tx_response.raw_log // ""' 2>/dev/null || true)"
    if [[ "$(printf '%s' "$tx_body" | jq -r '.tx_response.code // 0' 2>/dev/null || echo 1)" != "0" ]]; then
      rm -f "$payload_file"
      if is_bridge_nonce_error "$raw_log" && (( attempt < EVM_NONCE_RETRY_ATTEMPTS )); then
        current_nonce=$((current_nonce + 1))
        continue
      fi
      if is_account_sequence_error "$raw_log" && (( attempt < EVM_NONCE_RETRY_ATTEMPTS )); then
        sleep 1
        continue
      fi
      echo "error: create tx failed: ${raw_log:-unknown error}" >&2
      exit 1
    fi

    deal_id="$(printf '%s' "$tx_body" | jq -r '
      [
        .tx_response.logs[]?.events[]?,
        .tx_response.events[]?
      ]
      | map(select(.type == "nilchain.nilchain.EventCreateDeal" or .type == "create_deal"))
      | map(.attributes[]?)
      | flatten
      | map(select(.key == "id" or .key == "deal_id"))
      | .[0].value // ""
    ' 2>/dev/null || true)"

    if [[ -z "$deal_id" ]]; then
      list_out="$("$NILCHAIND_BIN" query nilchain list-deals \
        --node "$NIL_NODE" \
        --output json 2>/dev/null || true)"
      max_id="$(printf '%s' "$list_out" | jq -r '[.deals[]?.id | tonumber] | max // empty' 2>/dev/null || true)"
      deal_id="$max_id"
    fi

    if [[ -z "$deal_id" ]]; then
      rm -f "$payload_file"
      echo "error: create tx succeeded but deal_id could not be resolved" >&2
      exit 1
    fi

    rm -f "$payload_file"
    CREATE_NONCE="$current_nonce"
    CREATE_TX_HASH="$tx_hash"
    DEAL_ID="$deal_id"
    return 0
  done

  echo "error: create-deal-from-evm exhausted nonce retry attempts" >&2
  exit 1
}

direct_update_deal_content() {
  local update_json update_file update_out tx_json tx_hash tx_code tx_body
  local current_nonce raw_log cmd_status attempt

  ensure_tx_sender_key
  current_nonce="${UPDATE_NONCE:-$CREATE_NONCE}"

  for attempt in $(seq 1 "$EVM_NONCE_RETRY_ATTEMPTS"); do
    update_json="$(
      cd "$ROOT_DIR/nil-website"
      EVM_PRIVKEY="$EVM_PRIVKEY" \
      EVM_CHAIN_ID="$EVM_CHAIN_ID" \
      CHAIN_ID="$CHAIN_ID" \
      NONCE="$current_nonce" \
      CID="$MANIFEST_ROOT" \
      DEAL_ID="$DEAL_ID" \
      SIZE_BYTES="$SIZE_BYTES" \
      TOTAL_MDUS="$TOTAL_MDUS" \
      WITNESS_MDUS="$WITNESS_MDUS" \
      "$ROOT_DIR/nil-website/node_modules/.bin/tsx" "$ROOT_DIR/nil-website/scripts/sign_intent.ts" update-content
    )"

    update_file="$(mktemp "${TMPDIR:-/tmp}/nilstore-update-content-XXXXXX")"
    printf '%s\n' "$update_json" >"$update_file"

    cmd_status=0
    update_out="$("$NILCHAIND_BIN" tx nilchain update-deal-content-from-evm "$update_file" \
      --node "$NIL_NODE" \
      --chain-id "$CHAIN_ID" \
      --from "$NIL_TX_SENDER_KEY" \
      --yes \
      --keyring-backend test \
      --home "$NIL_TX_SENDER_HOME" \
      --gas-prices "$NIL_GAS_PRICES" \
      --broadcast-mode sync \
      --output json 2>&1)" || cmd_status=$?

    if (( cmd_status != 0 )); then
      rm -f "$update_file"
      if is_bridge_nonce_error "$update_out" && (( attempt < EVM_NONCE_RETRY_ATTEMPTS )); then
        current_nonce=$((current_nonce + 1))
        continue
      fi
      if is_account_sequence_error "$update_out" && (( attempt < EVM_NONCE_RETRY_ATTEMPTS )); then
        sleep 1
        continue
      fi
      echo "error: update-deal-content-from-evm failed: $update_out" >&2
      exit 1
    fi

    tx_json="$(extract_json_body "$update_out")"
    tx_hash="$(printf '%s' "$tx_json" | jq -r '.txhash // ""' 2>/dev/null || true)"
    tx_code="$(printf '%s' "$tx_json" | jq -r '.code // 0' 2>/dev/null || echo 0)"
    raw_log="$(printf '%s' "$tx_json" | jq -r '.raw_log // ""' 2>/dev/null || true)"
    if [[ -z "$tx_hash" || "$tx_code" != "0" ]]; then
      rm -f "$update_file"
      if is_bridge_nonce_error "$raw_log" && (( attempt < EVM_NONCE_RETRY_ATTEMPTS )); then
        current_nonce=$((current_nonce + 1))
        continue
      fi
      if is_account_sequence_error "$raw_log" && (( attempt < EVM_NONCE_RETRY_ATTEMPTS )); then
        sleep 1
        continue
      fi
      echo "error: update-deal-content-from-evm returned invalid response: $update_out" >&2
      exit 1
    fi

    tx_body="$(poll_tx_body "$tx_hash")" || {
      rm -f "$update_file"
      echo "error: update tx not confirmed on LCD within timeout: $tx_hash" >&2
      exit 1
    }

    raw_log="$(printf '%s' "$tx_body" | jq -r '.tx_response.raw_log // ""' 2>/dev/null || true)"
    if [[ "$(printf '%s' "$tx_body" | jq -r '.tx_response.code // 0' 2>/dev/null || echo 1)" != "0" ]]; then
      rm -f "$update_file"
      if is_bridge_nonce_error "$raw_log" && (( attempt < EVM_NONCE_RETRY_ATTEMPTS )); then
        current_nonce=$((current_nonce + 1))
        continue
      fi
      if is_account_sequence_error "$raw_log" && (( attempt < EVM_NONCE_RETRY_ATTEMPTS )); then
        sleep 1
        continue
      fi
      echo "error: update tx failed: ${raw_log:-unknown error}" >&2
      exit 1
    fi

    rm -f "$update_file"
    UPDATE_NONCE="$current_nonce"
    TX_HASH="$tx_hash"
    return 0
  done

  echo "error: update-deal-content-from-evm exhausted nonce retry attempts" >&2
  exit 1
}

FILE_NAME="$(basename "${FILE_PATH}")"
FILE_SIZE_BYTES="$(wc -c <"${FILE_PATH}" | tr -d '[:space:]')"

if [[ -z "${NILFS_PATH}" ]]; then
  NILFS_PATH="${FILE_NAME}"
fi

sign_intent() {
  local mode="$1"
  local nonce="${2:-}"
  (
    cd "$ROOT_DIR/nil-website"
    # Ensure dependencies are present (CI/dev stacks do this already).
    if [[ ! -d node_modules ]]; then
      npm install >/dev/null
    fi
    EVM_PRIVKEY="$EVM_PRIVKEY" \
    EVM_CHAIN_ID="$EVM_CHAIN_ID" \
    CHAIN_ID="$CHAIN_ID" \
    NONCE="$nonce" \
    SERVICE_HINT="$SERVICE_HINT" \
    "$ROOT_DIR/nil-website/node_modules/.bin/tsx" "$ROOT_DIR/nil-website/scripts/sign_intent.ts" "$mode"
  )
}

CREATE_TX_HASH=""
TX_HASH=""

case "$TX_SUBMIT_MODE" in
  gateway|direct)
    ;;
  *)
    echo "error: unsupported NIL_TX_SUBMIT_MODE=$TX_SUBMIT_MODE (expected gateway or direct)" >&2
    exit 1
    ;;
esac

if [[ -z "${DEAL_ID}" ]]; then
  echo ">> Creating deal..."
  if [[ "$TX_SUBMIT_MODE" == "direct" ]]; then
    direct_create_deal
  else
    CREATE_JSON="$(sign_intent create-deal "$CREATE_NONCE")"
    CREATE_RESP="$(curl -sS -X POST "${GATEWAY_BASE}/gateway/create-deal-evm" \
      -H 'Content-Type: application/json' \
      --data "${CREATE_JSON}")"

    DEAL_ID="$(printf '%s' "${CREATE_RESP}" | jq -r '.deal_id // ""' 2>/dev/null || true)"
    CREATE_TX_HASH="$(printf '%s' "${CREATE_RESP}" | jq -r '.tx_hash // ""' 2>/dev/null || true)"

    if [[ -z "${DEAL_ID}" ]]; then
      echo "error: failed to create deal. response: ${CREATE_RESP}" >&2
      exit 1
    fi
  fi
fi

if [[ -z "$UPDATE_NONCE" ]]; then
  if [[ -n "$CREATE_TX_HASH" ]]; then
    UPDATE_NONCE="$((CREATE_NONCE + 1))"
  else
    UPDATE_NONCE="$CREATE_NONCE"
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
if [[ "$TX_SUBMIT_MODE" == "direct" ]]; then
  direct_update_deal_content
else
  UPDATE_JSON="$(
    cd "$ROOT_DIR/nil-website"
    EVM_PRIVKEY="$EVM_PRIVKEY" \
    EVM_CHAIN_ID="$EVM_CHAIN_ID" \
    CHAIN_ID="$CHAIN_ID" \
    NONCE="$UPDATE_NONCE" \
    CID="$MANIFEST_ROOT" \
    DEAL_ID="$DEAL_ID" \
    SIZE_BYTES="$SIZE_BYTES" \
    TOTAL_MDUS="$TOTAL_MDUS" \
    WITNESS_MDUS="$WITNESS_MDUS" \
    "$ROOT_DIR/nil-website/node_modules/.bin/tsx" "$ROOT_DIR/nil-website/scripts/sign_intent.ts" update-content
  )"

  UPDATE_RESP="$(curl -sS -X POST "${GATEWAY_BASE}/gateway/update-deal-content-evm" \
    -H 'Content-Type: application/json' \
    --data "${UPDATE_JSON}")"

  TX_HASH="$(printf '%s' "${UPDATE_RESP}" | jq -r '.tx_hash // ""' 2>/dev/null || true)"

  if [[ -z "${TX_HASH}" ]]; then
    echo "error: commit failed. response: ${UPDATE_RESP}" >&2
    exit 1
  fi
fi

if [[ -z "${TX_HASH}" ]]; then
  echo "error: commit produced no tx hash" >&2
  exit 1
fi

echo ">> Commit sent: tx_hash=${TX_HASH}"
echo ">> Done."
if [[ -n "$CREATE_TX_HASH" ]]; then
  echo "create_tx_hash=${CREATE_TX_HASH}"
fi
echo "deal_id=${DEAL_ID}"
echo "manifest_root=${MANIFEST_ROOT}"
echo "nilfs_path=${NILFS_PATH}"

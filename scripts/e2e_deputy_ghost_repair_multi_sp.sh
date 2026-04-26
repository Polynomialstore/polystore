#!/usr/bin/env bash
# E2E: Mode2 deputy retrieval triggers repair (make-before-break).
#
# Scenario:
# 1) Start devnet alpha multi-SP stack.
# 2) Create a Mode 2 deal.
# 3) Upload + commit a file (PolyFS).
# 4) Plan a retrieval session for the first blob and open it on-chain.
# 5) Kill the assigned slot provider ("ghost").
# 6) Fetch through the router: it should fall back to a deputy provider.
# 7) Deputy submits the on-chain retrieval proof.
# 8) At epoch end, chain marks slot as REPAIRING with PendingProvider and the
#    gateway planner routes around the repairing slot.
# 9) Fetch/prove through the pending provider.
# 10) At the next epoch end, chain promotes the pending provider and returns the
#     slot to ACTIVE.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK_SCRIPT="$ROOT_DIR/scripts/run_devnet_alpha_multi_sp.sh"
# shellcheck source=scripts/chain_cli_helpers.sh
source "$ROOT_DIR/scripts/chain_cli_helpers.sh"

CHAIN_HOME="${POLYSTORE_HOME:-$ROOT_DIR/_artifacts/polystorechain_data_devnet_alpha}"
CHAIN_ID="${CHAIN_ID:-31337}"
NODE_ADDR="${NODE_ADDR:-tcp://127.0.0.1:26657}"
RPC_STATUS="${RPC_STATUS:-http://127.0.0.1:26657/status}"
LCD_BASE="${LCD_BASE:-http://127.0.0.1:1317}"
GATEWAY_BASE="${GATEWAY_BASE:-http://127.0.0.1:8080}"

POLYSTORECHAIND_BIN="${POLYSTORECHAIND_BIN:-$ROOT_DIR/polystorechain/polystorechaind}"
CHAIN_MODULE_CLI_NAME="${POLYSTORE_CHAIN_MODULE_CLI_NAME:-}"
POLYSTORE_CORE_RELEASE_DIR="${POLYSTORE_CORE_RELEASE_DIR:-$ROOT_DIR/polystore_core/target/release}"
export LD_LIBRARY_PATH="$POLYSTORE_CORE_RELEASE_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export DYLD_LIBRARY_PATH="$POLYSTORE_CORE_RELEASE_DIR${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"

PROVIDER_COUNT="${PROVIDER_COUNT:-12}"
DEAL_DURATION_BLOCKS="${DEAL_DURATION_BLOCKS:-1000}"

UPLOAD_FILE="${UPLOAD_FILE:-$ROOT_DIR/test_1mb.bin}"
FILE_PATH="${FILE_PATH:-test_1mb.bin}"

RAW_BLOB_PAYLOAD_BYTES="${RAW_BLOB_PAYLOAD_BYTES:-126976}"

cleanup() {
  echo "==> Stopping devnet alpha multi-SP stack..."
  "$STACK_SCRIPT" stop || true
}
trap cleanup EXIT

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: missing required command: $1" >&2
    exit 1
  fi
}

wait_for_http() {
  local name="$1"
  local url="$2"
  local expect_codes="${3:-200}"
  local max_attempts="${4:-60}"
  local delay_secs="${5:-1}"

  echo "==> Waiting for $name at $url ..."
  for attempt in $(seq 1 "$max_attempts"); do
    local code
    code=$(timeout 10s curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" 2>/dev/null || true)
    code="${code:-000}"
    if echo ",$expect_codes," | grep -q ",$code,"; then
      echo "    $name reachable (HTTP $code) after $attempt attempt(s)."
      return 0
    fi
    sleep "$delay_secs"
  done

  echo "ERROR: $name at $url not reachable" >&2
  return 1
}

rpc_height() {
  timeout 10s curl -s --max-time 2 "$RPC_STATUS" | python3 -c '
import json, sys
try:
  data = json.load(sys.stdin)
  print(int(data["result"]["sync_info"]["latest_block_height"]))
except Exception:
  print(0)
'
}

wait_for_height() {
  local target="$1"
  local attempts="${2:-120}"
  local delay="${3:-1}"
  for _ in $(seq 1 "$attempts"); do
    local h
    h="$(rpc_height)"
    if [ "$h" -ge "$target" ]; then
      return 0
    fi
    sleep "$delay"
  done
  return 1
}

json_get() {
  local key="$1"
  python3 -c '
import json, sys
key = sys.argv[1]
data = json.load(sys.stdin)
cur = data
for part in key.split("."):
  if part == "":
    continue
  if isinstance(cur, dict) and part in cur:
    cur = cur[part]
    continue
  print("")
  sys.exit(0)
if cur is None:
  print("")
elif isinstance(cur, (dict, list)):
  print(json.dumps(cur))
else:
  print(cur)
' "$key"
}

extract_last_json() {
  python3 -c '
import json, sys
s = sys.stdin.read()
decoder = json.JSONDecoder()
last_obj = None
last_end = -1
for i, ch in enumerate(s):
  if ch != "{":
    continue
  try:
    obj, end = decoder.raw_decode(s[i:])
  except Exception:
    continue
  abs_end = i + end
  if isinstance(obj, dict) and abs_end > last_end:
    last_obj = obj
    last_end = abs_end
if last_obj is None:
  print("")
else:
  print(json.dumps(last_obj))
'
}

parse_create_deal_id() {
  python3 -c '
import json, sys
try:
  tx = json.load(sys.stdin)
except Exception:
  print("")
  sys.exit(0)
logs = tx.get("logs") or []
events = []
for item in logs:
  events.extend(item.get("events") or [])
if not events:
  events = tx.get("events") or []
for ev in events:
  if (ev.get("type") or "") != "create_deal":
    continue
  for a in ev.get("attributes") or []:
    if (a.get("key") or "") == "deal_id":
      print(a.get("value") or "")
      sys.exit(0)
print("")
'
}

parse_latest_deal_id_for_owner() {
  local owner="$1"
  python3 -c '
import json, sys
owner = (sys.argv[1] or "").strip()
try:
  data = json.load(sys.stdin)
except Exception:
  print("")
  sys.exit(0)
deals = data.get("deals") or []
best = None
for deal in deals:
  if not isinstance(deal, dict):
    continue
  if owner and (deal.get("owner") or "").strip() != owner:
    continue
  try:
    deal_id = int(deal.get("id"))
  except Exception:
    continue
  if best is None or deal_id > best:
    best = deal_id
print("" if best is None else best)
' "$owner"
}

wait_for_created_deal_id() {
  local txhash="$1"
  local attempts="${2:-40}"
  local delay="${3:-1}"
  DEAL_ID=""
  CREATE_TX_RAW=""
  for _ in $(seq 1 "$attempts"); do
    CREATE_TX_RAW="$("$POLYSTORECHAIND_BIN" query tx "$txhash" --node "$NODE_ADDR" --output json --home "$CHAIN_HOME" 2>/dev/null || true)"
    CREATE_TX="$(echo "$CREATE_TX_RAW" | extract_last_json)"
    DEAL_ID="$(echo "$CREATE_TX" | parse_create_deal_id)"
    if [ -n "$DEAL_ID" ]; then
      return 0
    fi

    local list_raw
    list_raw="$("$POLYSTORECHAIND_BIN" query "$CHAIN_MODULE_CLI_NAME" list-deals --node "$NODE_ADDR" --output json --home "$CHAIN_HOME" 2>/dev/null || true)"
    DEAL_ID="$(echo "$list_raw" | parse_latest_deal_id_for_owner "$FAUCET_ADDR")"
    if [ -n "$DEAL_ID" ]; then
      return 0
    fi
    sleep "$delay"
  done
  return 1
}

decode_session_id_hex() {
  python3 -c '
import base64, json, sys
data = json.load(sys.stdin)
raw = data.get("session_id") or ""
if not raw:
  print("")
  sys.exit(0)
try:
  bz = base64.b64decode(raw)
except Exception:
  try:
    bz = base64.urlsafe_b64decode(raw + "==")
  except Exception:
    print("")
    sys.exit(0)
print("0x" + bz.hex())
'
}

extract_tcp_port() {
  python3 -c '
import re, sys
ep = sys.stdin.read().strip()
m = re.search(r"/tcp/(\d+)(?:/|$)", ep)
print(m.group(1) if m else "")
'
}

urlencode() {
  python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$1"
}

session_id_by_nonce() {
  local deal_id="$1"
  local provider="$2"
  local nonce="$3"
  python3 -c '
import base64, json, os, sys
deal_id = str(sys.argv[1])
provider = (sys.argv[2] or "").strip()
nonce = int(sys.argv[3] or 0)
data = json.load(sys.stdin)
sessions = data.get("sessions") or []
raw = ""
for s in sessions:
  if str(s.get("deal_id","")) != deal_id:
    continue
  if provider and (s.get("provider") or "").strip() != provider:
    continue
  try:
    if int(s.get("nonce",0)) != nonce:
      continue
  except Exception:
    continue
  raw = s.get("session_id") or ""
  break
if not raw:
  print("")
  raise SystemExit(0)
try:
  bz = base64.b64decode(raw)
except Exception:
  try:
    bz = base64.urlsafe_b64decode(raw + "==")
  except Exception:
    print("")
    raise SystemExit(0)
print("0x" + bz.hex())
' "$deal_id" "$provider" "$nonce"
}

open_retrieval_session() {
  local provider="$1"
  local start_mdu="$2"
  local start_blob="$3"
  local blob_count="$4"
  local expires_at nonce
  expires_at="${SESSION_EXPIRES_AT:-0}"
  nonce="$(python3 - <<'PY'
import time
print(time.time_ns())
PY
)"

  echo "==> Opening on-chain retrieval session for provider=$provider ..."
  "$POLYSTORECHAIND_BIN" tx "$CHAIN_MODULE_CLI_NAME" open-retrieval-session \
    --deal-id "$DEAL_ID" \
    --provider "$provider" \
    --manifest-root "$MANIFEST_ROOT" \
    --start-mdu-index "$start_mdu" \
    --start-blob-index "$start_blob" \
    --blob-count "$blob_count" \
    --nonce "$nonce" \
    --expires-at "$expires_at" \
    --from faucet \
    --chain-id "$CHAIN_ID" \
    --node "$NODE_ADDR" \
    --home "$CHAIN_HOME" \
    --keyring-backend test \
    --yes \
    --gas auto \
    --gas-adjustment 1.6 \
    --gas-prices 0.001aatom \
    --broadcast-mode sync \
    --output json >/dev/null

  echo "==> Waiting for retrieval session to appear..."
  OPEN_SESSION_HEX=""
  for _ in $(seq 1 30); do
    SESSIONS_JSON="$(timeout 10s curl -sS "$LCD_BASE/polystorechain/polystorechain/v1/retrieval-sessions/by-owner/$FAUCET_ADDR" || echo "{}")"
    OPEN_SESSION_HEX="$(echo "$SESSIONS_JSON" | session_id_by_nonce "$DEAL_ID" "$provider" "$nonce")"
    if [ -n "$OPEN_SESSION_HEX" ]; then
      break
    fi
    sleep 1
  done
  if [ -z "$OPEN_SESSION_HEX" ]; then
    echo "ERROR: failed to resolve session id" >&2
    echo "$SESSIONS_JSON" >&2
    exit 1
  fi
  echo "    session_id=$OPEN_SESSION_HEX"
}

submit_session_proof() {
  local session_hex="$1"
  local provider="$2"
  echo "==> Asking provider to submit retrieval session proof: provider=$provider ..."
  local proof_submit_resp status
  proof_submit_resp="$(timeout 120s curl -sS -X POST "$GATEWAY_BASE/gateway/session-proof" \
    -H "Content-Type: application/json" \
    -d "{\"session_id\":\"$session_hex\",\"provider\":\"$provider\"}")"
  status="$(echo "$proof_submit_resp" | python3 -c 'import sys, json; print(json.load(sys.stdin).get("status",""))' 2>/dev/null || true)"
  if [ "$status" != "success" ]; then
    echo "ERROR: session proof submission failed" >&2
    echo "$proof_submit_resp" >&2
    exit 1
  fi
}

kill_provider_listener() {
  local port="$1"
  local pids=""
  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)"
  elif command -v fuser >/dev/null 2>&1; then
    pids="$(fuser -n tcp "$port" 2>/dev/null || true)"
  fi
  if [ -n "$pids" ]; then
    kill $pids 2>/dev/null || true
  fi
}

require_cmd curl
require_cmd python3

if [ ! -f "$UPLOAD_FILE" ]; then
  echo "ERROR: UPLOAD_FILE does not exist: $UPLOAD_FILE" >&2
  exit 1
fi

# Speed up the repair loop for E2E.
export PROVIDER_COUNT
export START_WEB="${START_WEB:-0}"
export POLYSTORE_EPOCH_LEN_BLOCKS="${POLYSTORE_EPOCH_LEN_BLOCKS:-20}"
export POLYSTORE_EVICT_AFTER_MISSED_EPOCHS="${POLYSTORE_EVICT_AFTER_MISSED_EPOCHS:-1}"

echo "==> Starting devnet alpha multi-SP stack (providers=$PROVIDER_COUNT)..."
"$STACK_SCRIPT" start
CHAIN_MODULE_CLI_NAME="$(detect_chain_module_cli_name "$POLYSTORECHAIND_BIN" CHAIN_MODULE_CLI_NAME)"
export POLYSTORE_CHAIN_MODULE_CLI_NAME="$CHAIN_MODULE_CLI_NAME"
echo "==> Chain module CLI namespace: $CHAIN_MODULE_CLI_NAME"

wait_for_http "lcd" "$LCD_BASE/cosmos/base/tendermint/v1beta1/node_info" "200" 60 1
wait_for_http "polystorechain lcd" "$LCD_BASE/polystorechain/polystorechain/v1/params" "200" 60 1
wait_for_http "gateway router" "$GATEWAY_BASE/health" "200" 60 1

FAUCET_ADDR="$("$POLYSTORECHAIND_BIN" keys show faucet -a --home "$CHAIN_HOME" --keyring-backend test 2>/dev/null || true)"
if [ -z "$FAUCET_ADDR" ]; then
  echo "ERROR: failed to resolve faucet address" >&2
  exit 1
fi
echo "==> Using deal owner: $FAUCET_ADDR"

SERVICE_HINT="General:rs=8+4"

echo "==> Creating Mode 2 deal..."
CREATE_RES_RAW="$("$POLYSTORECHAIND_BIN" tx "$CHAIN_MODULE_CLI_NAME" create-deal "$DEAL_DURATION_BLOCKS" 1000000 500000 \
  --service-hint "$SERVICE_HINT" \
  --from faucet \
  --chain-id "$CHAIN_ID" \
  --node "$NODE_ADDR" \
  --home "$CHAIN_HOME" \
  --keyring-backend test \
  --yes \
  --gas 250000 \
  --gas-prices 0.001aatom \
  --broadcast-mode sync \
  --output json)"
CREATE_RES="$(echo "$CREATE_RES_RAW" | extract_last_json)"
TXHASH="$(echo "$CREATE_RES" | python3 -c 'import sys, json; print(json.load(sys.stdin).get("txhash", ""))' 2>/dev/null || true)"
if [ -z "$TXHASH" ]; then
  echo "ERROR: failed to parse create-deal txhash" >&2
  echo "$CREATE_RES_RAW" >&2
  exit 1
fi
if ! wait_for_created_deal_id "$TXHASH" 40 1; then
  echo "ERROR: failed to parse deal id from tx" >&2
  echo "$CREATE_TX_RAW" >&2
  exit 1
fi
echo "    Deal ID: $DEAL_ID"

echo "==> Uploading file via router gateway..."
UPLOAD_RESP="$(timeout 120s curl -sS -X POST \
  -F "file=@$UPLOAD_FILE" \
  -F "owner=$FAUCET_ADDR" \
  -F "file_path=$FILE_PATH" \
  "$GATEWAY_BASE/gateway/upload?deal_id=$DEAL_ID")"
MANIFEST_ROOT="$(echo "$UPLOAD_RESP" | python3 -c 'import sys, json; j=json.load(sys.stdin); print(j.get("manifest_root") or j.get("cid") or "")' 2>/dev/null || true)"
SIZE_BYTES="$(echo "$UPLOAD_RESP" | python3 -c 'import sys, json; j=json.load(sys.stdin); print(j.get("size_bytes") or j.get("sizeBytes") or "")' 2>/dev/null || true)"
TOTAL_MDUS="$(echo "$UPLOAD_RESP" | python3 -c 'import sys, json; j=json.load(sys.stdin); print(j.get("total_mdus") or j.get("totalMdus") or "")' 2>/dev/null || true)"
WITNESS_MDUS="$(echo "$UPLOAD_RESP" | python3 -c 'import sys, json; j=json.load(sys.stdin); print(j.get("witness_mdus") or j.get("witnessMdus") or "")' 2>/dev/null || true)"
FILENAME="$(echo "$UPLOAD_RESP" | python3 -c 'import sys, json; j=json.load(sys.stdin); print(j.get("filename") or j.get("file_path") or "")' 2>/dev/null || true)"

if [ -z "$MANIFEST_ROOT" ] || [ -z "$SIZE_BYTES" ] || [ -z "$TOTAL_MDUS" ] || [ -z "$WITNESS_MDUS" ] || [ -z "$FILENAME" ]; then
  echo "ERROR: upload response missing required fields" >&2
  echo "$UPLOAD_RESP" >&2
  exit 1
fi
echo "    manifest_root=$MANIFEST_ROOT size_bytes=$SIZE_BYTES total_mdus=$TOTAL_MDUS witness_mdus=$WITNESS_MDUS file=$FILENAME"

echo "==> Committing deal content on-chain..."
"$POLYSTORECHAIND_BIN" tx "$CHAIN_MODULE_CLI_NAME" update-deal-content \
  --deal-id "$DEAL_ID" \
  --cid "$MANIFEST_ROOT" \
  --size "$SIZE_BYTES" \
  --total-mdus "$TOTAL_MDUS" \
  --witness-mdus "$WITNESS_MDUS" \
  --from faucet \
  --chain-id "$CHAIN_ID" \
  --node "$NODE_ADDR" \
  --home "$CHAIN_HOME" \
  --keyring-backend test \
  --yes \
  --gas auto \
  --gas-adjustment 1.6 \
  --gas-prices 0.001aatom \
  --broadcast-mode sync \
  --output json >/dev/null
sleep 2

echo "==> Waiting for deal manifest_root to be visible..."
for _ in $(seq 1 30); do
  DEAL_JSON="$(timeout 10s curl -sS "$LCD_BASE/polystorechain/polystorechain/v1/deals/$DEAL_ID" || echo "{}")"
  CHAIN_ROOT_HEX="$(echo "$DEAL_JSON" | python3 -c '
import base64, json, sys
d = json.load(sys.stdin)
deal = d.get("deal") or {}
root = deal.get("manifest_root") or ""
if isinstance(root, str) and root.startswith("0x"):
  print(root)
  raise SystemExit(0)
if not root:
  print("")
  raise SystemExit(0)
try:
  bz = base64.b64decode(root)
except Exception:
  try:
    bz = base64.urlsafe_b64decode(root + "==")
  except Exception:
    print("")
    raise SystemExit(0)
print("0x" + bz.hex())
' 2>/dev/null || true)"
  if [ "$CHAIN_ROOT_HEX" = "$MANIFEST_ROOT" ]; then
    break
  fi
  sleep 1
done
if [ "${CHAIN_ROOT_HEX:-}" != "$MANIFEST_ROOT" ]; then
  echo "ERROR: deal manifest_root not updated on-chain" >&2
  echo "    expected=$MANIFEST_ROOT got=${CHAIN_ROOT_HEX:-}" >&2
  echo "$DEAL_JSON" >&2
  exit 1
fi

echo "==> Planning retrieval session for first blob..."
PLAN_RESP="$(timeout 10s curl -sS "$GATEWAY_BASE/gateway/plan-retrieval-session/$MANIFEST_ROOT?deal_id=$DEAL_ID&owner=$FAUCET_ADDR&file_path=$(urlencode "$FILENAME")&range_start=0&range_len=$RAW_BLOB_PAYLOAD_BYTES")"
PLAN_PROVIDER="$(echo "$PLAN_RESP" | python3 -c 'import sys, json; print(json.load(sys.stdin).get("provider",""))' 2>/dev/null || true)"
PLAN_START_MDU="$(echo "$PLAN_RESP" | python3 -c 'import sys, json; print(json.load(sys.stdin).get("start_mdu_index",""))' 2>/dev/null || true)"
PLAN_START_BLOB="$(echo "$PLAN_RESP" | python3 -c 'import sys, json; print(json.load(sys.stdin).get("start_blob_index",""))' 2>/dev/null || true)"
PLAN_BLOB_COUNT="$(echo "$PLAN_RESP" | python3 -c 'import sys, json; print(json.load(sys.stdin).get("blob_count",""))' 2>/dev/null || true)"
if [ -z "$PLAN_PROVIDER" ] || [ -z "$PLAN_START_MDU" ] || [ -z "$PLAN_START_BLOB" ] || [ -z "$PLAN_BLOB_COUNT" ]; then
  echo "ERROR: plan response missing required fields" >&2
  echo "$PLAN_RESP" >&2
  exit 1
fi
echo "    planned slot provider=$PLAN_PROVIDER start_mdu=$PLAN_START_MDU start_blob=$PLAN_START_BLOB blob_count=$PLAN_BLOB_COUNT"

echo "==> Resolving planned provider endpoint..."
PROVIDER_JSON="$(timeout 10s curl -sS "$LCD_BASE/polystorechain/polystorechain/v1/providers/$PLAN_PROVIDER")"
ENDPOINT="$(echo "$PROVIDER_JSON" | python3 -c 'import sys, json; d=json.load(sys.stdin); p=d.get("provider") or {}; eps=p.get("endpoints") or []; print(eps[0] if eps else "")' 2>/dev/null || true)"
PORT="$(echo "$ENDPOINT" | extract_tcp_port)"
if [ -z "$PORT" ]; then
  echo "ERROR: failed to parse provider endpoint port from: $ENDPOINT" >&2
  exit 1
fi
echo "    planned provider endpoint=$ENDPOINT port=$PORT"

open_retrieval_session "$PLAN_PROVIDER" "$PLAN_START_MDU" "$PLAN_START_BLOB" "$PLAN_BLOB_COUNT"
SESSION_HEX="$OPEN_SESSION_HEX"

echo "==> Simulating ghosting: stopping planned provider..."
# Only kill the listener on that port (avoid killing the router, which may have
# outbound connections to the provider port).
kill_provider_listener "$PORT"
sleep 1

echo "==> Fetching first blob via router (should fall back to deputy)..."
OUT_FILE="$(mktemp)"
HDR_FILE="$(mktemp)"
start_end="$((RAW_BLOB_PAYLOAD_BYTES - 1))"
FETCH_EXIT=0
HTTP_CODE="$(timeout 120s curl -sS -D "$HDR_FILE" -o "$OUT_FILE" \
  -H "X-PolyStore-Session-Id: $SESSION_HEX" \
  -H "Range: bytes=0-${start_end}" \
  "$GATEWAY_BASE/gateway/fetch/$MANIFEST_ROOT?deal_id=$DEAL_ID&owner=$FAUCET_ADDR&file_path=$(urlencode "$FILENAME")" \
  -w '%{http_code}')" || FETCH_EXIT=$?

if [ "$FETCH_EXIT" -ne 0 ]; then
  echo "ERROR: fetch request failed (exit=$FETCH_EXIT)" >&2
  if [ -s "$HDR_FILE" ]; then
    echo "---- response headers ----" >&2
    cat "$HDR_FILE" >&2 || true
    echo "--------------------------" >&2
  fi
  exit 1
fi

if [ "$HTTP_CODE" != "200" ] && [ "$HTTP_CODE" != "206" ]; then
  echo "ERROR: fetch returned HTTP $HTTP_CODE" >&2
  echo "---- response headers ----" >&2
  cat "$HDR_FILE" >&2 || true
  echo "--------------------------" >&2
  if [ -s "$OUT_FILE" ]; then
    echo "---- response body (first 4KB) ----" >&2
    head -c 4096 "$OUT_FILE" >&2 || true
    echo "-----------------------------------" >&2
  fi
  exit 1
fi

DEPUTY_PROVIDER="$(grep -i '^X-PolyStore-Provider:' "$HDR_FILE" | tail -n 1 | awk '{print $2}' | tr -d '\r')"
if [ -z "$DEPUTY_PROVIDER" ]; then
  echo "ERROR: missing X-PolyStore-Provider header" >&2
  cat "$HDR_FILE" >&2 || true
  exit 1
fi
echo "    fetch HTTP $HTTP_CODE via provider=$DEPUTY_PROVIDER"
if [ "$DEPUTY_PROVIDER" = "$PLAN_PROVIDER" ]; then
  echo "ERROR: expected a deputy provider (got planned provider)" >&2
  exit 1
fi

OUT_BYTES="$(python3 - <<PY
import os
print(os.path.getsize("$OUT_FILE"))
PY
)"
if [ "$OUT_BYTES" -le 0 ]; then
  echo "ERROR: fetched zero bytes" >&2
  exit 1
fi

submit_session_proof "$SESSION_HEX" "$DEPUTY_PROVIDER"

echo "==> Waiting for epoch end to trigger deputy-miss repair..."
EPOCH_LEN="$POLYSTORE_EPOCH_LEN_BLOCKS"
CUR_H="$(rpc_height)"
NEXT_EPOCH_END="$(( ( (CUR_H + EPOCH_LEN - 1) / EPOCH_LEN ) * EPOCH_LEN ))"
if [ "$NEXT_EPOCH_END" -le "$CUR_H" ]; then
  NEXT_EPOCH_END="$((CUR_H + EPOCH_LEN))"
fi
wait_for_height "$NEXT_EPOCH_END" 180 1 || { echo "ERROR: timed out waiting for epoch end" >&2; exit 1; }
sleep 2

DEAL_JSON="$(timeout 10s curl -sS "$LCD_BASE/polystorechain/polystorechain/v1/deals/$DEAL_ID")"
REPAIR_SLOT_JSON="$(echo "$DEAL_JSON" | PLANNED_PROVIDER="$PLAN_PROVIDER" python3 -c '
import json, os, sys
planned = (os.environ.get("PLANNED_PROVIDER","") or "").strip()
data = json.load(sys.stdin)
deal = data.get("deal") or {}
slots = deal.get("mode2_slots") or []
for s in slots:
  if not s:
    continue
  if (s.get("provider") or "").strip() != planned:
    continue
  print(json.dumps(s))
  sys.exit(0)
print("")
')"
if [ -z "$REPAIR_SLOT_JSON" ]; then
  echo "ERROR: failed to find slot for planned provider in deal state" >&2
  echo "$DEAL_JSON" >&2
  exit 1
fi
SLOT_STATUS="$(echo "$REPAIR_SLOT_JSON" | python3 -c 'import sys, json; print((json.load(sys.stdin).get("status") or ""))' 2>/dev/null || true)"
PENDING_PROVIDER="$(echo "$REPAIR_SLOT_JSON" | python3 -c 'import sys, json; print((json.load(sys.stdin).get("pending_provider") or ""))' 2>/dev/null || true)"
REPAIR_SLOT_INDEX="$(echo "$REPAIR_SLOT_JSON" | python3 -c 'import sys, json; print(json.load(sys.stdin).get("slot",""))' 2>/dev/null || true)"
REPAIR_TARGET_GEN="$(echo "$REPAIR_SLOT_JSON" | python3 -c 'import sys, json; print(json.load(sys.stdin).get("repair_target_gen","0"))' 2>/dev/null || true)"
if [ "$SLOT_STATUS" != "SLOT_STATUS_REPAIRING" ] && [ "$SLOT_STATUS" != "2" ]; then
  echo "ERROR: expected slot to be REPAIRING, got status=$SLOT_STATUS" >&2
  echo "$REPAIR_SLOT_JSON" >&2
  exit 1
fi
if [ -z "$PENDING_PROVIDER" ]; then
  echo "ERROR: expected pending_provider to be set" >&2
  echo "$REPAIR_SLOT_JSON" >&2
  exit 1
fi
if [ -z "$REPAIR_SLOT_INDEX" ]; then
  echo "ERROR: expected repairing slot index to be set" >&2
  echo "$REPAIR_SLOT_JSON" >&2
  exit 1
fi
echo "    repair started: slot=$REPAIR_SLOT_INDEX pending_provider=$PENDING_PROVIDER repair_target_gen=$REPAIR_TARGET_GEN"

echo "==> Confirming planner routes around repairing slots..."
PLAN2_RESP="$(timeout 10s curl -sS "$GATEWAY_BASE/gateway/plan-retrieval-session/$MANIFEST_ROOT?deal_id=$DEAL_ID&owner=$FAUCET_ADDR&file_path=$(urlencode "$FILENAME")&range_start=0&range_len=$RAW_BLOB_PAYLOAD_BYTES")"
PLAN2_PROVIDER="$(echo "$PLAN2_RESP" | python3 -c 'import sys, json; print(json.load(sys.stdin).get("provider",""))' 2>/dev/null || true)"
PLAN2_START_MDU="$(echo "$PLAN2_RESP" | python3 -c 'import sys, json; print(json.load(sys.stdin).get("start_mdu_index",""))' 2>/dev/null || true)"
PLAN2_START_BLOB="$(echo "$PLAN2_RESP" | python3 -c 'import sys, json; print(json.load(sys.stdin).get("start_blob_index",""))' 2>/dev/null || true)"
PLAN2_BLOB_COUNT="$(echo "$PLAN2_RESP" | python3 -c 'import sys, json; print(json.load(sys.stdin).get("blob_count",""))' 2>/dev/null || true)"
if [ "$PLAN2_PROVIDER" != "$PENDING_PROVIDER" ]; then
  echo "ERROR: expected planner to return pending provider $PENDING_PROVIDER, got $PLAN2_PROVIDER" >&2
  echo "$PLAN2_RESP" >&2
  exit 1
fi
if [ -z "$PLAN2_START_MDU" ] || [ -z "$PLAN2_START_BLOB" ] || [ -z "$PLAN2_BLOB_COUNT" ]; then
  echo "ERROR: repair plan response missing required fields" >&2
  echo "$PLAN2_RESP" >&2
  exit 1
fi

open_retrieval_session "$PENDING_PROVIDER" "$PLAN2_START_MDU" "$PLAN2_START_BLOB" "$PLAN2_BLOB_COUNT"
PENDING_SESSION_HEX="$OPEN_SESSION_HEX"

echo "==> Fetching first blob via pending provider..."
PENDING_OUT_FILE="$(mktemp)"
PENDING_HDR_FILE="$(mktemp)"
PENDING_FETCH_EXIT=0
PENDING_HTTP_CODE="$(timeout 120s curl -sS -D "$PENDING_HDR_FILE" -o "$PENDING_OUT_FILE" \
  -H "X-PolyStore-Session-Id: $PENDING_SESSION_HEX" \
  -H "Range: bytes=0-${start_end}" \
  "$GATEWAY_BASE/gateway/fetch/$MANIFEST_ROOT?deal_id=$DEAL_ID&owner=$FAUCET_ADDR&file_path=$(urlencode "$FILENAME")" \
  -w '%{http_code}')" || PENDING_FETCH_EXIT=$?
if [ "$PENDING_FETCH_EXIT" -ne 0 ]; then
  echo "ERROR: pending-provider fetch request failed (exit=$PENDING_FETCH_EXIT)" >&2
  cat "$PENDING_HDR_FILE" >&2 || true
  exit 1
fi
if [ "$PENDING_HTTP_CODE" != "200" ] && [ "$PENDING_HTTP_CODE" != "206" ]; then
  echo "ERROR: pending-provider fetch returned HTTP $PENDING_HTTP_CODE" >&2
  cat "$PENDING_HDR_FILE" >&2 || true
  if [ -s "$PENDING_OUT_FILE" ]; then
    head -c 4096 "$PENDING_OUT_FILE" >&2 || true
  fi
  exit 1
fi
PENDING_FETCH_PROVIDER="$(grep -i '^X-PolyStore-Provider:' "$PENDING_HDR_FILE" | tail -n 1 | awk '{print $2}' | tr -d '\r')"
if [ "$PENDING_FETCH_PROVIDER" != "$PENDING_PROVIDER" ]; then
  echo "ERROR: expected pending-provider fetch via $PENDING_PROVIDER, got $PENDING_FETCH_PROVIDER" >&2
  cat "$PENDING_HDR_FILE" >&2 || true
  exit 1
fi
PENDING_OUT_BYTES="$(python3 - <<PY
import os
print(os.path.getsize("$PENDING_OUT_FILE"))
PY
)"
if [ "$PENDING_OUT_BYTES" -le 0 ]; then
  echo "ERROR: pending-provider fetch returned zero bytes" >&2
  exit 1
fi

submit_session_proof "$PENDING_SESSION_HEX" "$PENDING_PROVIDER"

echo "==> Waiting for next epoch end to complete repair promotion..."
CUR_H="$(rpc_height)"
NEXT_EPOCH_END="$(( ( (CUR_H + EPOCH_LEN - 1) / EPOCH_LEN ) * EPOCH_LEN ))"
if [ "$NEXT_EPOCH_END" -le "$CUR_H" ]; then
  NEXT_EPOCH_END="$((CUR_H + EPOCH_LEN))"
fi
wait_for_height "$NEXT_EPOCH_END" 180 1 || { echo "ERROR: timed out waiting for repair-completion epoch end" >&2; exit 1; }
sleep 2

FINAL_DEAL_JSON="$(timeout 10s curl -sS "$LCD_BASE/polystorechain/polystorechain/v1/deals/$DEAL_ID")"
FINAL_SLOT_JSON="$(echo "$FINAL_DEAL_JSON" | REPAIR_SLOT_INDEX="$REPAIR_SLOT_INDEX" python3 -c '
import json, os, sys
slot_index = str(os.environ.get("REPAIR_SLOT_INDEX",""))
data = json.load(sys.stdin)
deal = data.get("deal") or {}
slots = deal.get("mode2_slots") or []
for s in slots:
  if not s:
    continue
  if str(s.get("slot","")) == slot_index:
    print(json.dumps(s))
    sys.exit(0)
print("")
')"
if [ -z "$FINAL_SLOT_JSON" ]; then
  echo "ERROR: failed to find final slot $REPAIR_SLOT_INDEX" >&2
  echo "$FINAL_DEAL_JSON" >&2
  exit 1
fi
FINAL_STATUS="$(echo "$FINAL_SLOT_JSON" | python3 -c 'import sys, json; print((json.load(sys.stdin).get("status") or ""))' 2>/dev/null || true)"
FINAL_PROVIDER="$(echo "$FINAL_SLOT_JSON" | python3 -c 'import sys, json; print((json.load(sys.stdin).get("provider") or ""))' 2>/dev/null || true)"
FINAL_PENDING="$(echo "$FINAL_SLOT_JSON" | python3 -c 'import sys, json; print((json.load(sys.stdin).get("pending_provider") or ""))' 2>/dev/null || true)"
FINAL_REPAIR_TARGET_GEN="$(echo "$FINAL_SLOT_JSON" | python3 -c 'import sys, json; print((json.load(sys.stdin).get("repair_target_gen") or "0"))' 2>/dev/null || true)"
FINAL_CURRENT_GEN="$(echo "$FINAL_DEAL_JSON" | python3 -c 'import sys, json; print(((json.load(sys.stdin).get("deal") or {}).get("current_gen") or "0"))' 2>/dev/null || true)"
if [ "$FINAL_STATUS" != "SLOT_STATUS_ACTIVE" ] && [ "$FINAL_STATUS" != "1" ]; then
  echo "ERROR: expected repaired slot to be ACTIVE, got status=$FINAL_STATUS" >&2
  echo "$FINAL_SLOT_JSON" >&2
  exit 1
fi
if [ "$FINAL_PROVIDER" != "$PENDING_PROVIDER" ]; then
  echo "ERROR: expected repaired slot provider to be promoted pending provider $PENDING_PROVIDER, got $FINAL_PROVIDER" >&2
  echo "$FINAL_SLOT_JSON" >&2
  exit 1
fi
if [ -n "$FINAL_PENDING" ]; then
  echo "ERROR: expected pending_provider to be cleared after repair completion" >&2
  echo "$FINAL_SLOT_JSON" >&2
  exit 1
fi
if [ "$FINAL_REPAIR_TARGET_GEN" != "0" ]; then
  echo "ERROR: expected repair_target_gen to be cleared after repair completion, got $FINAL_REPAIR_TARGET_GEN" >&2
  echo "$FINAL_SLOT_JSON" >&2
  exit 1
fi
echo "    repair completed: slot=$REPAIR_SLOT_INDEX provider=$FINAL_PROVIDER current_gen=$FINAL_CURRENT_GEN"
echo "==> Deputy ghost repair E2E passed."

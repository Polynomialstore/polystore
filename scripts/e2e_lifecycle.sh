#!/usr/bin/env bash
# End-to-end lifecycle test for NilStore:
# 1. Upload a file via Gateway -> get Manifest Root & Size.
# 2. Create a Deal via Gateway (EVM signed) -> get Deal ID.
# 3. Commit Content via Gateway (EVM signed) -> update Deal with Manifest Root.
# 4. Verify Deal state on Chain (LCD).
# 5. Fetch file via Gateway -> verify content.

set -euo pipefail
set -x

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK_SCRIPT="$ROOT_DIR/scripts/run_local_stack.sh"

LCD_BASE="${LCD_BASE:-http://localhost:1317}"
GATEWAY_BASE="${GATEWAY_BASE:-http://localhost:8080}"
FAUCET_BASE="${FAUCET_BASE:-http://localhost:8081}"
RPC_BASE="${RPC_BASE:-http://127.0.0.1:${RPC_ADDR##*:}}"
EVM_RPC="${EVM_RPC:-http://localhost:${EVM_RPC_PORT:-8545}}"

CHAIN_ID="${CHAIN_ID:-test-1}"
EVM_CHAIN_ID="${EVM_CHAIN_ID:-31337}"
VERIFYING_CONTRACT="0x0000000000000000000000000000000000000000"
# Deterministic dev key (Foundry default #0).
EVM_PRIVKEY="${EVM_PRIVKEY:-0x4f3edf983ac636a65a842ce7c78d9aa706d3b113b37a2b2d6f6fcf7e9f59b5f1}"
UPLOAD_FILE="${UPLOAD_FILE:-$ROOT_DIR/README.md}"

export EVM_PRIVKEY EVM_CHAIN_ID CHAIN_ID VERIFYING_CONTRACT

# This E2E script exercises the gateway "tx relay" endpoints (e.g. /gateway/create-deal-evm),
# so ensure the local stack is started with the relay enabled by default. The stack itself
# can still default to relay-off for manual/wallet-first runs.
export NIL_ENABLE_TX_RELAY="${NIL_ENABLE_TX_RELAY:-1}"
# This script also relies on the faucet to fund the EVM-derived NIL address.
export NIL_START_FAUCET="${NIL_START_FAUCET:-1}"

if ! command -v curl >/dev/null 2>&1; then echo "ERROR: curl required" >&2; exit 1; fi
if ! command -v python3 >/dev/null 2>&1; then echo "ERROR: python3 required" >&2; exit 1; fi

# Ensure fetches fail loudly on non-2xx responses, otherwise curl may write a JSON
# error body to disk and later `cmp` will look like "corruption".
CURL_FAIL_ARGS=()
if curl --help all 2>/dev/null | grep -q -- '--fail-with-body'; then
  CURL_FAIL_ARGS+=(--fail-with-body)
else
  CURL_FAIL_ARGS+=(--fail)
fi

# --- Helper Functions ---

wait_for_http() {
  local name="$1"
  local url="$2"
  local max_attempts="${3:-30}"
  local delay_secs="${4:-2}"

  echo "==> Waiting for $name at $url ..."
  for attempt in $(seq 1 "$max_attempts"); do
    local code
    # curl prints "000" when it cannot connect; don't treat that as reachable.
    code=$(timeout 10s curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" || true)
    if [ -n "$code" ] && [ "$code" != "000" ]; then
      echo "    $name reachable (HTTP $code) after $attempt attempt(s)."
      return 0
    fi
    sleep "$delay_secs"
  done
  echo "ERROR: $name at $url not reachable" >&2
  return 1
}

latest_height() {
  timeout 10s curl -sS "$RPC_BASE/status" \
    | python3 -c "import sys, json; print(int(json.load(sys.stdin)['result']['sync_info']['latest_block_height']))"
}

wait_for_next_block() {
  local max_attempts="${1:-20}"
  local delay_secs="${2:-0.2}"
  local start_h cur_h
  start_h="$(latest_height || echo 0)"
  for _ in $(seq 1 "$max_attempts"); do
    cur_h="$(latest_height || echo 0)"
    if [ "$cur_h" -gt "$start_h" ]; then
      return 0
    fi
    sleep "$delay_secs"
  done
  return 1
}

wait_for_positive_balance() {
  local addr="$1"
  local lcd_base="$2"
  local max_attempts="${3:-30}"
  local delay_secs="${4:-0.5}"
  local amt
  for attempt in $(seq 1 "$max_attempts"); do
    amt=$(timeout 10s curl -sS "$lcd_base/cosmos/bank/v1beta1/balances/$addr" \
      | python3 -c "import sys, json; j=json.load(sys.stdin); b=(j.get('balances') or []); print(next((int(x.get('amount','0')) for x in b if x.get('denom')=='stake'), 0))" \
      || echo 0)
    if [ "$amt" -gt 0 ]; then
      echo "    Balance detected for $addr: $amt stake"
      return 0
    fi
    echo "    Waiting for funded balance (attempt $attempt/$max_attempts)..."
    sleep "$delay_secs"
  done
  echo "ERROR: funded balance not observed for $addr" >&2
  return 1
}

wait_for_manifest_root() {
  local deal_id="$1"
  local expected_root="$2"
  local lcd_base="$3"
  local max_attempts="${4:-40}"
  local delay_secs="${5:-0.5}"
  local observed_root
  for attempt in $(seq 1 "$max_attempts"); do
    observed_root=$(timeout 10s curl -sS "$lcd_base/nilchain/nilchain/v1/deals/$deal_id" \
      | python3 -c "import sys, json, base64; j=json.load(sys.stdin); r=(j.get('deal') or {}).get('manifest_root') or ''; print(r if r.startswith('0x') else ('0x'+base64.b64decode(r).hex() if r else ''))" \
      || echo "")
    if [ "$observed_root" == "$expected_root" ]; then
      return 0
    fi
    echo "    Waiting for manifest root index (attempt $attempt/$max_attempts)..."
    sleep "$delay_secs"
  done
  echo "ERROR: manifest root did not index for deal $deal_id (expected $expected_root)" >&2
  return 1
}

cleanup() {
  echo "==> Stopping local stack..."
  "$STACK_SCRIPT" stop || true
}
trap cleanup EXIT

get_account_sequence() {
  local addr="$1"
  local lcd_base="$2"
  local max_attempts="${3:-10}"
  local delay_secs="${4:-2}"

  echo "==> Getting account sequence for $addr ..." >&2
  for attempt in $(seq 1 "$max_attempts"); do
    resp=$(timeout 10s curl -sS "$lcd_base/cosmos/auth/v1beta1/accounts/$addr")
    seq=$(echo "$resp" | python3 -c "import sys, json; print(json.load(sys.stdin).get('account', {}).get('sequence', ''))")
    if [ -n "$seq" ]; then
      echo "$seq"
      return 0
    fi
    echo "    Account sequence not found (attempt $attempt/$max_attempts); sleeping ${delay_secs}s..." >&2
    sleep "$delay_secs"
  done
  echo "ERROR: Failed to get account sequence for $addr" >&2
  return 1
}

fund_account() {
  local addr="$1"
  local faucet_base="$2"
  echo "==> Funding account $addr ..."
  # Allow failure in case already funded or faucet flake, subsequent steps will catch it
  timeout 10s curl -sS -X POST -H "Content-Type: application/json" -d "{\"address\":\"$addr\"}" "$faucet_base/faucet" || true
  echo ""
}

# --- Main Script ---

echo "==> Starting local stack..."
"$STACK_SCRIPT" start

wait_for_http "LCD" "$LCD_BASE/cosmos/base/tendermint/v1beta1/node_info" 40 3
wait_for_http "Gateway" "$GATEWAY_BASE/gateway/create-deal-evm" 40 3
if [ "${CHECK_GATEWAY_STATUS:-0}" = "1" ]; then
  wait_for_http "Gateway status" "$GATEWAY_BASE/status" 40 3
fi

# 1. Derive Addresses
echo "==> Deriving addresses..."
ADDR_JSON=$(python3 - <<PY
from eth_account import Account
import bech32, os
priv = os.environ["EVM_PRIVKEY"]
acct = Account.from_key(priv)
hex_addr = acct.address
data = bytes.fromhex(hex_addr[2:])
five = bech32.convertbits(data, 8, 5)
nil_addr = bech32.bech32_encode("nil", five)
print(hex_addr)
print(nil_addr)
PY
)
EVM_ADDRESS=$(echo "$ADDR_JSON" | sed -n '1p')
NIL_ADDRESS=$(echo "$ADDR_JSON" | sed -n '2p')
echo "    EVM: $EVM_ADDRESS"
echo "    NIL: $NIL_ADDRESS"

fund_account "$NIL_ADDRESS" "$FAUCET_BASE"
wait_for_positive_balance "$NIL_ADDRESS" "$LCD_BASE" 30 0.5
echo "==> Verifying balance for $NIL_ADDRESS..."
BAL_JSON=$(timeout 10s curl -sS "$LCD_BASE/cosmos/bank/v1beta1/balances/$NIL_ADDRESS" || echo "{}")
echo "$BAL_JSON" | python3 -c "import sys, json; print(json.dumps(json.load(sys.stdin), indent=2))"

# 2. Create Deal (EVM)
echo "==> Creating Deal (EVM-signed)..."

EVM_NONCE=1

CREATE_RESP=""
for i in $(seq 1 5); do
  CREATE_PAYLOAD=$(
    NONCE="$EVM_NONCE" \
    DURATION_BLOCKS=100 \
    SERVICE_HINT="General" \
    INITIAL_ESCROW="1000000" \
    MAX_MONTHLY_SPEND="500000" \
    "$ROOT_DIR/nil-website/node_modules/.bin/tsx" "$ROOT_DIR/nil-website/scripts/sign_intent.ts" create-deal
  )
  CREATE_RESP=$(timeout 10s curl -v -X POST "$GATEWAY_BASE/gateway/create-deal-evm" \
    -H "Content-Type: application/json" \
    -d "$CREATE_PAYLOAD")

  if echo "$CREATE_RESP" | grep -q "account sequence mismatch"; then
    echo "    Account sequence mismatch, retrying (attempt $i/5)..."
    wait_for_next_block 20 0.2 || true
    continue
  fi
  if echo "$CREATE_RESP" | grep -q "bridge nonce must be strictly increasing"; then
    echo "    Bridge nonce mismatch, retrying with incremented nonce (attempt $i/5)..."
    EVM_NONCE=$((EVM_NONCE + 1))
    wait_for_next_block 20 0.2 || true
    continue
  fi
  break
done

echo "    Response: $CREATE_RESP"

DEAL_ID=$(echo "$CREATE_RESP" | python3 -c "import sys, json; print(json.load(sys.stdin).get('deal_id', ''))" 2>/dev/null || echo "")

if [ -z "$DEAL_ID" ]; then
    echo "ERROR: Failed to create deal (no deal_id returned)"
    exit 1
fi
echo "    Deal ID: $DEAL_ID"
EVM_NONCE=$((EVM_NONCE + 1))

# 3. Upload File into Deal (Gateway)
if [ ! -f "$UPLOAD_FILE" ]; then
  echo "ERROR: UPLOAD_FILE does not exist: $UPLOAD_FILE" >&2
  exit 1
fi
UPLOAD_BYTES="$(python3 - "$UPLOAD_FILE" <<'PY'
import os
import sys
print(os.path.getsize(sys.argv[1]))
PY
)"
echo "==> Uploading file '$(basename "$UPLOAD_FILE")' (${UPLOAD_BYTES} bytes) to Gateway (deal_id=$DEAL_ID)..."
# Canonical NilFS ingest should be fast; enforce a bounded timeout (override with UPLOAD_TIMEOUT=...).
UPLOAD_TIMEOUT="${UPLOAD_TIMEOUT:-60s}"
UPLOAD_START_TS="$(python3 -c 'import time; print(time.time())')"
UPLOAD_RESP=$(timeout "$UPLOAD_TIMEOUT" curl --verbose -X POST -F "file=@$UPLOAD_FILE" \
  -F "owner=$NIL_ADDRESS" \
  "$GATEWAY_BASE/gateway/upload?deal_id=$DEAL_ID")
UPLOAD_END_TS="$(python3 -c 'import time; print(time.time())')"
python3 - <<PY
import math
start = float("$UPLOAD_START_TS")
end = float("$UPLOAD_END_TS")
elapsed = max(0.0, end - start)
bytes_total = int("$UPLOAD_BYTES")
mib = bytes_total / (1024.0 * 1024.0)
mbps = 0.0 if elapsed <= 0 else mib / elapsed
print(f"    Upload wall time: {elapsed:.2f}s ({mib:.2f} MiB @ {mbps:.2f} MiB/s)")
PY
echo "    Response: $UPLOAD_RESP"

MANIFEST_ROOT=$(echo "$UPLOAD_RESP" | python3 -c "import sys, json; j=json.load(sys.stdin); print(j.get('manifest_root') or j.get('cid') or '')")
SIZE_BYTES=$(echo "$UPLOAD_RESP" | python3 -c "import sys, json; j=json.load(sys.stdin); print(j.get('size_bytes') or j.get('sizeBytes') or '')")
TOTAL_MDUS=$(echo "$UPLOAD_RESP" | python3 -c "import sys, json; j=json.load(sys.stdin); print(j.get('total_mdus') or j.get('totalMdus') or j.get('allocated_length') or '')")
WITNESS_MDUS=$(echo "$UPLOAD_RESP" | python3 -c "import sys, json; j=json.load(sys.stdin); print(j.get('witness_mdus') or j.get('witnessMdus') or '')")
echo "    Manifest Root: $MANIFEST_ROOT"
echo "    Size: $SIZE_BYTES"
echo "    Total MDUs: $TOTAL_MDUS"
echo "    Witness MDUs: $WITNESS_MDUS"

if [ -z "$MANIFEST_ROOT" ] || [ -z "$SIZE_BYTES" ] || [ "$MANIFEST_ROOT" == "null" ]; then
    echo "ERROR: Failed to extract manifest_root or size_bytes"
    exit 1
fi
if [ -z "$TOTAL_MDUS" ] || [ -z "$WITNESS_MDUS" ]; then
    echo "ERROR: Failed to extract total_mdus or witness_mdus"
    exit 1
fi

# 4. Update Deal Content (EVM)
echo "==> Updating Deal Content (Commit Manifest)..."

UPDATE_RESP=""
for i in $(seq 1 5); do
  UPDATE_PAYLOAD=$(
    NONCE="$EVM_NONCE" \
    DEAL_ID="$DEAL_ID" \
    CID="$MANIFEST_ROOT" \
    SIZE_BYTES="$SIZE_BYTES" \
    TOTAL_MDUS="$TOTAL_MDUS" \
    WITNESS_MDUS="$WITNESS_MDUS" \
    "$ROOT_DIR/nil-website/node_modules/.bin/tsx" "$ROOT_DIR/nil-website/scripts/sign_intent.ts" update-content
  )
  UPDATE_RESP=$(timeout 10s curl -v -X POST "$GATEWAY_BASE/gateway/update-deal-content-evm" \
    -H "Content-Type: application/json" \
    -d "$UPDATE_PAYLOAD")

  if echo "$UPDATE_RESP" | grep -q "account sequence mismatch"; then
    echo "    Account sequence mismatch, retrying (attempt $i/5)..."
    wait_for_next_block 20 0.2 || true
    continue
  fi
  if echo "$UPDATE_RESP" | grep -q "bridge nonce must be strictly increasing"; then
    echo "    Bridge nonce mismatch, retrying with incremented nonce (attempt $i/5)..."
    EVM_NONCE=$((EVM_NONCE + 1))
    wait_for_next_block 20 0.2 || true
    continue
  fi
  break
done

echo "    Response: $UPDATE_RESP"

STATUS=$(echo "$UPDATE_RESP" | python3 -c "import sys, json; print(json.loads(sys.stdin.read()).get('status', ''))" 2>/dev/null || echo "")
if [ "$STATUS" != "success" ]; then
    echo "ERROR: Update content failed"
    exit 1
fi
EVM_NONCE=$((EVM_NONCE + 1))

# 5. Verify on LCD
echo "==> Verifying Deal on LCD..."
wait_for_manifest_root "$DEAL_ID" "$MANIFEST_ROOT" "$LCD_BASE" 40 0.5
DEAL_JSON=$(timeout 10s curl -sS "$LCD_BASE/nilchain/nilchain/v1/deals/$DEAL_ID")

TMP_DEAL_JSON_FILE=$(mktemp)
echo "$DEAL_JSON" > "$TMP_DEAL_JSON_FILE"

CHAIN_CID=$(python3 - <<PY
import sys, json, base64

with open("$TMP_DEAL_JSON_FILE", "r") as f:
    raw_json_input = f.read()

raw_manifest_root = json.loads(raw_json_input).get('deal', {}).get('manifest_root', '')

if raw_manifest_root:
    # Check if it's already a 0x-prefixed hex string
    if raw_manifest_root.startswith('0x'):
        print(raw_manifest_root)
    else:
        # Assume it's base64 and decode to hex
        try:
            decoded_bytes = base64.b64decode(raw_manifest_root)
            print('0x' + decoded_bytes.hex())
        except Exception as e:
            # Fallback if base64 decoding fails, print raw for debugging
            print(f"Error decoding base64: {e}. Raw manifest_root: {raw_manifest_root}", file=sys.stderr)
            print(raw_manifest_root) # Fallback, likely still incorrect but better than empty
else:
    print('')
PY
)
rm "$TMP_DEAL_JSON_FILE" # Clean up temporary file


if [ "$CHAIN_CID" != "$MANIFEST_ROOT" ]; then
    echo "ERROR: Chain CID ($CHAIN_CID) does not match Manifest Root ($MANIFEST_ROOT)"
    exit 1
fi
echo "    Success: Deal $DEAL_ID has correct CID $CHAIN_CID"

# 5.5 Restart gateway to prove NilFS is restart-safe source of truth.
echo "==> Restarting gateway (restart-safety check)..."
"$STACK_SCRIPT" restart-gateway
wait_for_http "Gateway" "$GATEWAY_BASE/gateway/create-deal-evm" 40 1

# 6. Fetch File (Gateway)
echo "==> Fetching file from Gateway..."
echo "==> Opening on-chain retrieval session (precompile)..."
# Resolve file layout from NilFS (start_offset and file length).
LIST_JSON=$(timeout 10s curl -sS "$GATEWAY_BASE/gateway/list-files/$MANIFEST_ROOT?deal_id=$DEAL_ID&owner=$NIL_ADDRESS")
START_OFFSET=$(echo "$LIST_JSON" | python3 -c "import sys,json; j=json.load(sys.stdin); p='README.md'; f=next((x for x in (j.get('files') or []) if x.get('path')==p), {}); print(int(f.get('start_offset') or f.get('startOffset') or 0))")
FILE_LEN=$(echo "$LIST_JSON" | python3 -c "import sys,json; j=json.load(sys.stdin); p='README.md'; f=next((x for x in (j.get('files') or []) if x.get('path')==p), {}); print(int(f.get('size_bytes') or f.get('sizeBytes') or 0))")
if [ "$FILE_LEN" -le 0 ]; then
  echo "ERROR: failed to resolve file length for README.md"
  exit 1
fi

# On-chain retrieval sessions are mandatory; open a 1+ blob session first (bounded by blob alignment).
# For gateway fetch, we need deal_id + owner + file_path AND a signed RetrievalRequest.
REQ_NONCE=1
REQ_EXPIRES_AT=$(( $(date +%s) + 120 ))
REQ_SIG_JSON=$(
  NONCE="$REQ_NONCE" \
  DEAL_ID="$DEAL_ID" \
  FILE_PATH="README.md" \
  RANGE_START="0" \
  RANGE_LEN="$FILE_LEN" \
  EXPIRES_AT="$REQ_EXPIRES_AT" \
  "$ROOT_DIR/nil-website/node_modules/.bin/tsx" "$ROOT_DIR/nil-website/scripts/sign_intent.ts" sign-fetch-request
)
REQ_SIG=$(echo "$REQ_SIG_JSON" | python3 -c "import sys, json; print(json.load(sys.stdin).get('evm_signature',''))")
if [ -z "$REQ_SIG" ]; then
  echo "ERROR: failed to sign retrieval request"
  exit 1
fi

# Compute the MDU/blob location for the first byte of the file.
START_MDU_INDEX=$(python3 - "$START_OFFSET" "$WITNESS_MDUS" <<'PY'
import sys
start_offset = int(sys.argv[1])
witness = int(sys.argv[2])
RAW_MDU_CAP = 8126464
print(1 + witness + (start_offset // RAW_MDU_CAP))
PY
)
START_BLOB_INDEX=$(python3 - "$START_OFFSET" <<'PY'
import sys
start_offset = int(sys.argv[1])
BLOB = 128 * 1024
RAW_MDU_CAP = 8126464
SCALAR_BYTES = 32
SCALAR_PAYLOAD = 31
offset_in_mdu = start_offset % RAW_MDU_CAP
scalar_idx = offset_in_mdu // SCALAR_PAYLOAD
payload_offset = offset_in_mdu % SCALAR_PAYLOAD
encoded_pos = scalar_idx * SCALAR_BYTES + 1 + payload_offset
blob_idx = encoded_pos // BLOB
print(blob_idx)
PY
)
SESSION_BLOB_COUNT=$(python3 - "$START_OFFSET" "$FILE_LEN" <<'PY'
import sys
start_offset = int(sys.argv[1])
file_len = int(sys.argv[2])
BLOB = 128 * 1024
RAW_MDU_CAP = 8126464
SCALAR_BYTES = 32
SCALAR_PAYLOAD = 31
def blob_index(raw_offset):
    offset_in_mdu = raw_offset % RAW_MDU_CAP
    scalar_idx = offset_in_mdu // SCALAR_PAYLOAD
    payload_offset = offset_in_mdu % SCALAR_PAYLOAD
    encoded_pos = scalar_idx * SCALAR_BYTES + 1 + payload_offset
    return encoded_pos // BLOB
start_blob = blob_index(start_offset)
end_offset = start_offset + max(0, file_len - 1)
end_blob = blob_index(end_offset)
count = end_blob - start_blob + 1
if count < 1:
    count = 1
if count > 64:
    count = 64
print(count)
PY
)

# Pick the first assigned provider from the deal state.
PROVIDER_ADDR=$(echo "$DEAL_JSON" | python3 -c "import sys, json; d=json.load(sys.stdin).get('deal') or {}; provs=d.get('providers') or []; print((provs[0] if provs else ''))")
if [ -z "$PROVIDER_ADDR" ]; then
  echo "ERROR: failed to resolve provider for session open"
  exit 1
fi

# For direct-to-provider retrieval runs (NIL_FORCE_DIRECT_FETCH=1), fetch must
# go to the provider that owns the relevant slot. Resolve its HTTP endpoint
# from chain.
DIRECT_PROVIDER_FETCH="${NIL_FORCE_DIRECT_FETCH:-${NIL_DISABLE_GATEWAY:-0}}"
FETCH_GATEWAY_BASE="$GATEWAY_BASE"
FETCH_PATH_PREFIX="/gateway/fetch"
FETCH_EXTRA_QUERY="&deputy=1"
if [ "$DIRECT_PROVIDER_FETCH" = "1" ]; then
  PROVIDER_JSON="$(timeout 10s curl -sS "$LCD_BASE/nilchain/nilchain/v1/providers/$PROVIDER_ADDR" || echo "{}")"
  FETCH_GATEWAY_BASE="$(echo "$PROVIDER_JSON" | python3 -c '
import json, re, sys
obj = json.load(sys.stdin)
provider = obj.get("provider") or {}
endpoints = provider.get("endpoints") or []
http_ma = ""
for ep in endpoints:
  if isinstance(ep, str) and "/http" in ep:
    http_ma = ep
    break
if not http_ma:
  raise SystemExit(0)
for pat in (
  r"^/ip4/([^/]+)/tcp/(\d+)/http$",
  r"^/dns4/([^/]+)/tcp/(\d+)/http$",
  r"^/dns/([^/]+)/tcp/(\d+)/http$",
):
  m = re.match(pat, http_ma)
  if m:
    host, port = m.group(1), m.group(2)
    print(f"http://{host}:{port}")
    raise SystemExit(0)
' )"
  if [ -z "$FETCH_GATEWAY_BASE" ]; then
    echo "ERROR: failed to resolve provider HTTP endpoint for $PROVIDER_ADDR" >&2
    echo "$PROVIDER_JSON" >&2
    exit 1
  fi
  FETCH_PATH_PREFIX="/sp/retrieval/fetch"
  FETCH_EXTRA_QUERY=""
fi

HEIGHT=$(timeout 10s curl -sS "$RPC_BASE/status" | python3 -c "import sys, json; print(int(json.load(sys.stdin)['result']['sync_info']['latest_block_height']))")
SESSION_EXPIRES_AT=$((HEIGHT + 20))
SESSION_NONCE=$(python3 -c "import time; print(time.time_ns())")

SESSION_OPEN_JSON=$(
  DEAL_ID="$DEAL_ID" \
  PROVIDER="$PROVIDER_ADDR" \
  MANIFEST_ROOT="$MANIFEST_ROOT" \
  START_MDU_INDEX="$START_MDU_INDEX" \
  START_BLOB_INDEX="$START_BLOB_INDEX" \
  BLOB_COUNT="$SESSION_BLOB_COUNT" \
  NONCE="$SESSION_NONCE" \
  EXPIRES_AT="$SESSION_EXPIRES_AT" \
  EVM_RPC="$EVM_RPC" \
  "$ROOT_DIR/nil-website/node_modules/.bin/tsx" "$ROOT_DIR/nil-website/scripts/open_retrieval_session.ts"
)
SESSION_ID=$(echo "$SESSION_OPEN_JSON" | python3 -c "import sys, json; print(json.load(sys.stdin).get('session_id',''))")
if [ -z "$SESSION_ID" ]; then
  echo "ERROR: failed to open retrieval session"
  echo "$SESSION_OPEN_JSON"
  exit 1
fi

FETCH_URL="$FETCH_GATEWAY_BASE$FETCH_PATH_PREFIX/$MANIFEST_ROOT?deal_id=$DEAL_ID&owner=$NIL_ADDRESS&file_path=README.md$FETCH_EXTRA_QUERY"
FETCH_RANGE_START=0
FETCH_RANGE_LEN="$FILE_LEN"
FETCH_RANGE_END=$((FETCH_RANGE_START + FETCH_RANGE_LEN - 1))
if ! timeout 10s curl "${CURL_FAIL_ARGS[@]}" -sS -o fetched_README.md "$FETCH_URL" \
  -H "X-Nil-Session-Id: $SESSION_ID" \
  -H "X-Nil-Req-Sig: $REQ_SIG" \
  -H "X-Nil-Req-Nonce: $REQ_NONCE" \
  -H "X-Nil-Req-Expires-At: $REQ_EXPIRES_AT" \
  -H "X-Nil-Req-Range-Start: $FETCH_RANGE_START" \
  -H "X-Nil-Req-Range-Len: $FETCH_RANGE_LEN" \
  -H "Range: bytes=$FETCH_RANGE_START-$FETCH_RANGE_END"; then
  echo "ERROR: Fetch request failed (non-2xx) for README.md" >&2
  if [ -s fetched_README.md ]; then
    echo "Response (first 1KB):" >&2
    head -c 1024 fetched_README.md >&2 || true
    echo "" >&2
  fi
  exit 1
fi

# Compare
if cmp -s "$ROOT_DIR/README.md" fetched_README.md; then
    echo "    Success: Fetched file matches original."
else
    echo "ERROR: Fetched file differs."
    ls -l "$ROOT_DIR/README_DIR" fetched_README.md
    exit 1
fi

rm fetched_README.md

# 7. Upload Second File into Existing Deal
echo "==> Uploading second file 'ECONOMY.md' into existing deal..."
UPLOAD2_RESP=$(timeout 600s curl --verbose -X POST -F "file=@$ROOT_DIR/ECONOMY.md" \
  -F "owner=$NIL_ADDRESS" \
  "$GATEWAY_BASE/gateway/upload?deal_id=$DEAL_ID")
echo "    Response: $UPLOAD2_RESP"

MANIFEST_ROOT_2=$(echo "$UPLOAD2_RESP" | python3 -c "import sys, json; j=json.load(sys.stdin); print(j.get('manifest_root') or j.get('cid') or '')")
SIZE_BYTES_2=$(echo "$UPLOAD2_RESP" | python3 -c "import sys, json; j=json.load(sys.stdin); print(j.get('size_bytes') or j.get('sizeBytes') or '')")
TOTAL_MDUS_2=$(echo "$UPLOAD2_RESP" | python3 -c "import sys, json; j=json.load(sys.stdin); print(j.get('total_mdus') or j.get('totalMdus') or j.get('allocated_length') or '')")
WITNESS_MDUS_2=$(echo "$UPLOAD2_RESP" | python3 -c "import sys, json; j=json.load(sys.stdin); print(j.get('witness_mdus') or j.get('witnessMdus') or '')")
echo "    New Manifest Root: $MANIFEST_ROOT_2"
echo "    New File Size: $SIZE_BYTES_2"
echo "    Total MDUs: $TOTAL_MDUS_2"
echo "    Witness MDUs: $WITNESS_MDUS_2"

if [ -z "$MANIFEST_ROOT_2" ] || [ "$MANIFEST_ROOT_2" == "null" ]; then
    echo "ERROR: Failed to extract new manifest_root"
    exit 1
fi
if [ -z "$TOTAL_MDUS_2" ] || [ -z "$WITNESS_MDUS_2" ]; then
    echo "ERROR: Failed to extract total_mdus or witness_mdus"
    exit 1
fi

# 8. Update Deal Content again (EVM)
echo "==> Updating Deal Content again (Commit New Manifest)..."

UPDATE2_RESP=""
for i in $(seq 1 5); do
  UPDATE2_PAYLOAD=$(
    NONCE="$EVM_NONCE" \
    DEAL_ID="$DEAL_ID" \
    CID="$MANIFEST_ROOT_2" \
    SIZE_BYTES="$SIZE_BYTES_2" \
    TOTAL_MDUS="$TOTAL_MDUS_2" \
    WITNESS_MDUS="$WITNESS_MDUS_2" \
    "$ROOT_DIR/nil-website/node_modules/.bin/tsx" "$ROOT_DIR/nil-website/scripts/sign_intent.ts" update-content
  )
  UPDATE2_RESP=$(timeout 10s curl -v -X POST "$GATEWAY_BASE/gateway/update-deal-content-evm" \
    -H "Content-Type: application/json" \
    -d "$UPDATE2_PAYLOAD")

  if echo "$UPDATE2_RESP" | grep -q "account sequence mismatch"; then
    echo "    Account sequence mismatch, retrying (attempt $i/5)..."
    wait_for_next_block 20 0.2 || true
    continue
  fi
  if echo "$UPDATE2_RESP" | grep -q "bridge nonce must be strictly increasing"; then
    echo "    Bridge nonce mismatch, retrying with incremented nonce (attempt $i/5)..."
    EVM_NONCE=$((EVM_NONCE + 1))
    wait_for_next_block 20 0.2 || true
    continue
  fi
  break
done

echo "    Response: $UPDATE2_RESP"

STATUS2=$(echo "$UPDATE2_RESP" | python3 -c "import sys, json; print(json.loads(sys.stdin.read()).get('status', ''))" 2>/dev/null || echo "")
if [ "$STATUS2" != "success" ]; then
    echo "ERROR: Second update content failed"
    exit 1
fi
EVM_NONCE=$((EVM_NONCE + 1))

# 9. Verify on LCD (new manifest root)
echo "==> Verifying Deal on LCD after append..."
wait_for_manifest_root "$DEAL_ID" "$MANIFEST_ROOT_2" "$LCD_BASE" 40 0.5
DEAL_JSON_2=$(timeout 10s curl -sS "$LCD_BASE/nilchain/nilchain/v1/deals/$DEAL_ID")

TMP_DEAL_JSON_FILE_2=$(mktemp)
echo "$DEAL_JSON_2" > "$TMP_DEAL_JSON_FILE_2"

CHAIN_CID_2=$(python3 - <<PY
import sys, json, base64

with open("$TMP_DEAL_JSON_FILE_2", "r") as f:
    raw_json_input = f.read()

raw_manifest_root = json.loads(raw_json_input).get('deal', {}).get('manifest_root', '')

if raw_manifest_root:
    if raw_manifest_root.startswith('0x'):
        print(raw_manifest_root)
    else:
        try:
            decoded_bytes = base64.b64decode(raw_manifest_root)
            print('0x' + decoded_bytes.hex())
        except Exception:
            print(raw_manifest_root)
else:
    print('')
PY
)
rm "$TMP_DEAL_JSON_FILE_2"

if [ "$CHAIN_CID_2" != "$MANIFEST_ROOT_2" ]; then
    echo "ERROR: Chain CID ($CHAIN_CID_2) does not match New Manifest Root ($MANIFEST_ROOT_2)"
    exit 1
fi
echo "    Success: Deal $DEAL_ID updated to CID $CHAIN_CID_2"

# 10. Fetch Both Files by Path from New Slab (verify sizes)
echo "==> Fetching both files by path from new slab..."
echo "==> Opening on-chain retrieval session for README (precompile)..."
LIST_JSON_2=$(timeout 10s curl -sS "$GATEWAY_BASE/gateway/list-files/$MANIFEST_ROOT_2?deal_id=$DEAL_ID&owner=$NIL_ADDRESS")
START_OFFSET_1=$(echo "$LIST_JSON_2" | python3 -c "import sys,json; j=json.load(sys.stdin); p='README.md'; f=next((x for x in (j.get('files') or []) if x.get('path')==p), {}); print(int(f.get('start_offset') or f.get('startOffset') or 0))")
FILE_LEN_1=$(echo "$LIST_JSON_2" | python3 -c "import sys,json; j=json.load(sys.stdin); p='README.md'; f=next((x for x in (j.get('files') or []) if x.get('path')==p), {}); print(int(f.get('size_bytes') or f.get('sizeBytes') or 0))")
START_MDU_INDEX_1=$(python3 - "$START_OFFSET_1" "$WITNESS_MDUS_2" <<'PY'
import sys
start_offset = int(sys.argv[1])
witness = int(sys.argv[2])
RAW_MDU_CAP = 8126464
print(1 + witness + (start_offset // RAW_MDU_CAP))
PY
)
START_BLOB_INDEX_1=$(python3 - "$START_OFFSET_1" <<'PY'
import sys
start_offset = int(sys.argv[1])
BLOB = 128 * 1024
RAW_MDU_CAP = 8126464
SCALAR_BYTES = 32
SCALAR_PAYLOAD = 31
offset_in_mdu = start_offset % RAW_MDU_CAP
scalar_idx = offset_in_mdu // SCALAR_PAYLOAD
payload_offset = offset_in_mdu % SCALAR_PAYLOAD
encoded_pos = scalar_idx * SCALAR_BYTES + 1 + payload_offset
blob_idx = encoded_pos // BLOB
print(blob_idx)
PY
)
SESSION_BLOB_COUNT_1=$(python3 - "$START_OFFSET_1" "$FILE_LEN_1" <<'PY'
import sys
start_offset = int(sys.argv[1])
file_len = int(sys.argv[2])
BLOB = 128 * 1024
RAW_MDU_CAP = 8126464
SCALAR_BYTES = 32
SCALAR_PAYLOAD = 31
def blob_index(raw_offset):
    offset_in_mdu = raw_offset % RAW_MDU_CAP
    scalar_idx = offset_in_mdu // SCALAR_PAYLOAD
    payload_offset = offset_in_mdu % SCALAR_PAYLOAD
    encoded_pos = scalar_idx * SCALAR_BYTES + 1 + payload_offset
    return encoded_pos // BLOB
start_blob = blob_index(start_offset)
end_offset = start_offset + max(0, file_len - 1)
end_blob = blob_index(end_offset)
count = end_blob - start_blob + 1
if count < 1:
    count = 1
if count > 64:
    count = 64
print(count)
PY
)
HEIGHT_2=$(timeout 10s curl -sS "$RPC_BASE/status" | python3 -c "import sys, json; print(int(json.load(sys.stdin)['result']['sync_info']['latest_block_height']))")
SESSION_EXPIRES_AT_1=$((HEIGHT_2 + 20))
SESSION_NONCE_1=$(python3 -c "import time; print(time.time_ns())")
SESSION_OPEN_JSON_1=$(
  DEAL_ID="$DEAL_ID" \
  PROVIDER="$PROVIDER_ADDR" \
  MANIFEST_ROOT="$MANIFEST_ROOT_2" \
  START_MDU_INDEX="$START_MDU_INDEX_1" \
  START_BLOB_INDEX="$START_BLOB_INDEX_1" \
  BLOB_COUNT="$SESSION_BLOB_COUNT_1" \
  NONCE="$SESSION_NONCE_1" \
  EXPIRES_AT="$SESSION_EXPIRES_AT_1" \
  EVM_RPC="$EVM_RPC" \
  "$ROOT_DIR/nil-website/node_modules/.bin/tsx" "$ROOT_DIR/nil-website/scripts/open_retrieval_session.ts"
)
SESSION_ID_1=$(echo "$SESSION_OPEN_JSON_1" | python3 -c "import sys, json; print(json.load(sys.stdin).get('session_id',''))")
if [ -z "$SESSION_ID_1" ]; then
  echo "ERROR: failed to open session for README"
  echo "$SESSION_OPEN_JSON_1"
  exit 1
fi

echo "==> Opening on-chain retrieval session for ECONOMY (precompile)..."
START_OFFSET_2=$(echo "$LIST_JSON_2" | python3 -c "import sys,json; j=json.load(sys.stdin); p='ECONOMY.md'; f=next((x for x in (j.get('files') or []) if x.get('path')==p), {}); print(int(f.get('start_offset') or f.get('startOffset') or 0))")
FILE_LEN_2=$(echo "$LIST_JSON_2" | python3 -c "import sys,json; j=json.load(sys.stdin); p='ECONOMY.md'; f=next((x for x in (j.get('files') or []) if x.get('path')==p), {}); print(int(f.get('size_bytes') or f.get('sizeBytes') or 0))")
START_MDU_INDEX_2=$(python3 - "$START_OFFSET_2" "$WITNESS_MDUS_2" <<'PY'
import sys
start_offset = int(sys.argv[1])
witness = int(sys.argv[2])
RAW_MDU_CAP = 8126464
print(1 + witness + (start_offset // RAW_MDU_CAP))
PY
)
START_BLOB_INDEX_2=$(python3 - "$START_OFFSET_2" <<'PY'
import sys
start_offset = int(sys.argv[1])
BLOB = 128 * 1024
RAW_MDU_CAP = 8126464
SCALAR_BYTES = 32
SCALAR_PAYLOAD = 31
offset_in_mdu = start_offset % RAW_MDU_CAP
scalar_idx = offset_in_mdu // SCALAR_PAYLOAD
payload_offset = offset_in_mdu % SCALAR_PAYLOAD
encoded_pos = scalar_idx * SCALAR_BYTES + 1 + payload_offset
blob_idx = encoded_pos // BLOB
print(blob_idx)
PY
)
SESSION_BLOB_COUNT_2=$(python3 - "$START_OFFSET_2" "$FILE_LEN_2" <<'PY'
import sys
start_offset = int(sys.argv[1])
file_len = int(sys.argv[2])
BLOB = 128 * 1024
RAW_MDU_CAP = 8126464
SCALAR_BYTES = 32
SCALAR_PAYLOAD = 31
def blob_index(raw_offset):
    offset_in_mdu = raw_offset % RAW_MDU_CAP
    scalar_idx = offset_in_mdu // SCALAR_PAYLOAD
    payload_offset = offset_in_mdu % SCALAR_PAYLOAD
    encoded_pos = scalar_idx * SCALAR_BYTES + 1 + payload_offset
    return encoded_pos // BLOB
start_blob = blob_index(start_offset)
end_offset = start_offset + max(0, file_len - 1)
end_blob = blob_index(end_offset)
count = end_blob - start_blob + 1
if count < 1:
    count = 1
if count > 64:
    count = 64
print(count)
PY
)
SESSION_EXPIRES_AT_2=$((HEIGHT_2 + 20))
SESSION_NONCE_2=$(python3 -c "import time; print(time.time_ns())")
SESSION_OPEN_JSON_2=$(
  DEAL_ID="$DEAL_ID" \
  PROVIDER="$PROVIDER_ADDR" \
  MANIFEST_ROOT="$MANIFEST_ROOT_2" \
  START_MDU_INDEX="$START_MDU_INDEX_2" \
  START_BLOB_INDEX="$START_BLOB_INDEX_2" \
  BLOB_COUNT="$SESSION_BLOB_COUNT_2" \
  NONCE="$SESSION_NONCE_2" \
  EXPIRES_AT="$SESSION_EXPIRES_AT_2" \
  EVM_RPC="$EVM_RPC" \
  "$ROOT_DIR/nil-website/node_modules/.bin/tsx" "$ROOT_DIR/nil-website/scripts/open_retrieval_session.ts"
)
SESSION_ID_2=$(echo "$SESSION_OPEN_JSON_2" | python3 -c "import sys, json; print(json.load(sys.stdin).get('session_id',''))")
if [ -z "$SESSION_ID_2" ]; then
  echo "ERROR: failed to open session for ECONOMY"
  echo "$SESSION_OPEN_JSON_2"
  exit 1
fi

REQ_NONCE_1=2
REQ_EXPIRES_AT_1=$(( $(date +%s) + 120 ))
REQ_SIG_JSON_1=$(
  NONCE="$REQ_NONCE_1" \
  DEAL_ID="$DEAL_ID" \
  FILE_PATH="README.md" \
  RANGE_START="0" \
  RANGE_LEN="$FILE_LEN_1" \
  EXPIRES_AT="$REQ_EXPIRES_AT_1" \
  "$ROOT_DIR/nil-website/node_modules/.bin/tsx" "$ROOT_DIR/nil-website/scripts/sign_intent.ts" sign-fetch-request
)
REQ_SIG_1=$(echo "$REQ_SIG_JSON_1" | python3 -c "import sys, json; print(json.load(sys.stdin).get('evm_signature',''))")

REQ_NONCE_2=3
REQ_EXPIRES_AT_2=$(( $(date +%s) + 120 ))
REQ_SIG_JSON_2=$(
  NONCE="$REQ_NONCE_2" \
  DEAL_ID="$DEAL_ID" \
  FILE_PATH="ECONOMY.md" \
  RANGE_START="0" \
  RANGE_LEN="$FILE_LEN_2" \
  EXPIRES_AT="$REQ_EXPIRES_AT_2" \
  "$ROOT_DIR/nil-website/node_modules/.bin/tsx" "$ROOT_DIR/nil-website/scripts/sign_intent.ts" sign-fetch-request
)
REQ_SIG_2=$(echo "$REQ_SIG_JSON_2" | python3 -c "import sys, json; print(json.load(sys.stdin).get('evm_signature',''))")

FETCH_URL_1="$FETCH_GATEWAY_BASE$FETCH_PATH_PREFIX/$MANIFEST_ROOT_2?deal_id=$DEAL_ID&owner=$NIL_ADDRESS&file_path=README.md$FETCH_EXTRA_QUERY"
FETCH_URL_2="$FETCH_GATEWAY_BASE$FETCH_PATH_PREFIX/$MANIFEST_ROOT_2?deal_id=$DEAL_ID&owner=$NIL_ADDRESS&file_path=ECONOMY.md$FETCH_EXTRA_QUERY"

if ! timeout 10s curl "${CURL_FAIL_ARGS[@]}" -sS -o fetched_README.bin "$FETCH_URL_1" \
  -H "X-Nil-Session-Id: $SESSION_ID_1" \
  -H "X-Nil-Req-Sig: $REQ_SIG_1" \
  -H "X-Nil-Req-Nonce: $REQ_NONCE_1" \
  -H "X-Nil-Req-Expires-At: $REQ_EXPIRES_AT_1" \
  -H "X-Nil-Req-Range-Start: 0" \
  -H "X-Nil-Req-Range-Len: $FILE_LEN_1" \
  -H "Range: bytes=0-$((FILE_LEN_1 - 1))"; then
  echo "ERROR: Fetch request failed (non-2xx) for README.md (multi-file)" >&2
  if [ -s fetched_README.bin ]; then
    echo "Response (first 1KB):" >&2
    head -c 1024 fetched_README.bin >&2 || true
    echo "" >&2
  fi
  exit 1
fi

if ! timeout 10s curl "${CURL_FAIL_ARGS[@]}" -sS -o fetched_ECONOMY.bin "$FETCH_URL_2" \
  -H "X-Nil-Session-Id: $SESSION_ID_2" \
  -H "X-Nil-Req-Sig: $REQ_SIG_2" \
  -H "X-Nil-Req-Nonce: $REQ_NONCE_2" \
  -H "X-Nil-Req-Expires-At: $REQ_EXPIRES_AT_2" \
  -H "X-Nil-Req-Range-Start: 0" \
  -H "X-Nil-Req-Range-Len: $FILE_LEN_2" \
  -H "Range: bytes=0-$((FILE_LEN_2 - 1))"; then
  echo "ERROR: Fetch request failed (non-2xx) for ECONOMY.md (multi-file)" >&2
  if [ -s fetched_ECONOMY.bin ]; then
    echo "Response (first 1KB):" >&2
    head -c 1024 fetched_ECONOMY.bin >&2 || true
    echo "" >&2
  fi
  exit 1
fi

ORIG1_SIZE=$(wc -c < "$ROOT_DIR/README.md" | tr -d ' ')
ORIG2_SIZE=$(wc -c < "$ROOT_DIR/ECONOMY.md" | tr -d ' ')
FETCH1_SIZE=$(wc -c < fetched_README.bin | tr -d ' ')
FETCH2_SIZE=$(wc -c < fetched_ECONOMY.bin | tr -d ' ')

if [ "$ORIG1_SIZE" != "$FETCH1_SIZE" ]; then
    echo "ERROR: README size mismatch after append (orig $ORIG1_SIZE, fetched $FETCH1_SIZE)"
    exit 1
fi
if [ "$ORIG2_SIZE" != "$FETCH2_SIZE" ]; then
    echo "ERROR: ECONOMY size mismatch after append (orig $ORIG2_SIZE, fetched $FETCH2_SIZE)"
    exit 1
fi

rm fetched_README.bin fetched_ECONOMY.bin
echo "==> E2E Lifecycle Test Passed!"

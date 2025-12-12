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

CHAIN_ID="${CHAIN_ID:-test-1}"
EVM_CHAIN_ID="${EVM_CHAIN_ID:-31337}"
VERIFYING_CONTRACT="0x0000000000000000000000000000000000000000"
# Deterministic dev key (Foundry default #0).
EVM_PRIVKEY="${EVM_PRIVKEY:-0x4f3edf983ac636a65a842ce7c78d9aa706d3b113b37a2b2d6f6fcf7e9f59b5f1}"

export EVM_PRIVKEY EVM_CHAIN_ID CHAIN_ID VERIFYING_CONTRACT

if ! command -v curl >/dev/null 2>&1; then echo "ERROR: curl required" >&2; exit 1; fi
if ! command -v python3 >/dev/null 2>&1; then echo "ERROR: python3 required" >&2; exit 1; fi

# --- Helper Functions ---

wait_for_http() {
  local name="$1"
  local url="$2"
  local max_attempts="${3:-30}"
  local delay_secs="${4:-2}"

  echo "==> Waiting for $name at $url ..."
  for attempt in $(seq 1 "$max_attempts"); do
    local code
    code=$(timeout 10s curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" || echo "000")
    if [ "$code" != "000" ]; then
      echo "    $name reachable (HTTP $code) after $attempt attempt(s)."
      return 0
    fi
    sleep "$delay_secs"
  done
  echo "ERROR: $name at $url not reachable" >&2
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
sleep 5 # Give chain time to process funding transaction
echo "==> Verifying balance for $NIL_ADDRESS..."
BAL_JSON=$(timeout 10s curl -sS "$LCD_BASE/cosmos/bank/v1beta1/balances/$NIL_ADDRESS" || echo "{}")
echo "$BAL_JSON" | python3 -c "import sys, json; print(json.dumps(json.load(sys.stdin), indent=2))"

# 2. Upload File
echo "==> Uploading file 'README.md' to Gateway..."
# Canonical NilFS ingest can take a few minutes (nil_cli shard + witness + mdu0),
# so allow a larger timeout here while still avoiding indefinite hangs.
UPLOAD_RESP=$(timeout 600s curl --verbose -X POST -F "file=@$ROOT_DIR/README.md" \
  -F "owner=$NIL_ADDRESS" \
  "$GATEWAY_BASE/gateway/upload")
echo "    Response: $UPLOAD_RESP"

MANIFEST_ROOT=$(echo "$UPLOAD_RESP" | python3 -c "import sys, json; print(json.load(sys.stdin)['manifest_root'])")
SIZE_BYTES=$(echo "$UPLOAD_RESP" | python3 -c "import sys, json; print(json.load(sys.stdin)['size_bytes'])")
echo "    Manifest Root: $MANIFEST_ROOT"
echo "    Size: $SIZE_BYTES"

if [ -z "$MANIFEST_ROOT" ] || [ -z "$SIZE_BYTES" ] || [ "$MANIFEST_ROOT" == "null" ]; then
    echo "ERROR: Failed to extract manifest_root or size_bytes"
    exit 1
fi

# 3. Create Deal (EVM)
echo "==> Creating Deal (EVM-signed)..."

# Get current account sequence for the NIL_ADDRESS
CURRENT_NIL_SEQUENCE=$(get_account_sequence "$NIL_ADDRESS" "$LCD_BASE")
if [ "$CURRENT_NIL_SEQUENCE" == "" ]; then
    echo "ERROR: Could not get current NIL_ADDRESS sequence"
    exit 1
fi
echo "    Current account sequence for NIL_ADDRESS: $CURRENT_NIL_SEQUENCE"

CREATE_RESP=""
for i in $(seq 1 5); do
  initial_nonce=$((CURRENT_NIL_SEQUENCE + i - 1))
  CREATE_PAYLOAD=$(
    NONCE="$initial_nonce" \
    DURATION_BLOCKS=100 \
    SERVICE_HINT="General" \
    INITIAL_ESCROW="1000000" \
    MAX_MONTHLY_SPEND="500000" \
    SIZE_TIER=0 \
    "$ROOT_DIR/nil-website/node_modules/.bin/tsx" "$ROOT_DIR/nil-website/scripts/sign_intent.ts" create-deal
  )
  CREATE_RESP=$(timeout 10s curl -v -X POST "$GATEWAY_BASE/gateway/create-deal-evm" \
    -H "Content-Type: application/json" \
    -d "$CREATE_PAYLOAD")

  if echo "$CREATE_RESP" | grep -q "account sequence mismatch"; then
    echo "    Account sequence mismatch, retrying with incremented nonce (attempt $i/5)..."
    # Re-fetch sequence to be safe, though simple increment should also work most times
    CURRENT_NIL_SEQUENCE=$(get_account_sequence "$NIL_ADDRESS" "$LCD_BASE")
    sleep 1 # Give chain a moment
  else
    break
  fi
done

echo "    Response: $CREATE_RESP"

DEAL_ID=$(echo "$CREATE_RESP" | python3 -c "import sys, json; print(json.load(sys.stdin).get('deal_id', ''))" 2>/dev/null || echo "")

if [ -z "$DEAL_ID" ]; then
    echo "ERROR: Failed to create deal (no deal_id returned)"
    exit 1
fi
echo "    Deal ID: $DEAL_ID"

# 4. Update Deal Content (EVM)
echo "==> Updating Deal Content (Commit Manifest)..."
# Get current account sequence for the NIL_ADDRESS
# This should be the previous sequence + 1, but we fetch it to be robust
CURRENT_NIL_SEQUENCE_FOR_UPDATE=$(get_account_sequence "$NIL_ADDRESS" "$LCD_BASE")
if [ "$CURRENT_NIL_SEQUENCE_FOR_UPDATE" == "" ]; then
    echo "ERROR: Could not get current NIL_ADDRESS sequence for update"
    exit 1
fi
echo "    Current account sequence for NIL_ADDRESS for update: $CURRENT_NIL_SEQUENCE_FOR_UPDATE"

UPDATE_RESP=""
for i in $(seq 1 5); do
  update_nonce=$((CURRENT_NIL_SEQUENCE_FOR_UPDATE + i - 1))
  UPDATE_PAYLOAD=$(
    NONCE="$update_nonce" \
    DEAL_ID="$DEAL_ID" \
    CID="$MANIFEST_ROOT" \
    SIZE_BYTES="$SIZE_BYTES" \
    "$ROOT_DIR/nil-website/node_modules/.bin/tsx" "$ROOT_DIR/nil-website/scripts/sign_intent.ts" update-content
  )
  UPDATE_RESP=$(timeout 10s curl -v -X POST "$GATEWAY_BASE/gateway/update-deal-content-evm" \
    -H "Content-Type: application/json" \
    -d "$UPDATE_PAYLOAD")

  if echo "$UPDATE_RESP" | grep -q "account sequence mismatch"; then
    echo "    Account sequence mismatch, retrying with incremented nonce (attempt $i/5)..."
    CURRENT_NIL_SEQUENCE_FOR_UPDATE=$(get_account_sequence "$NIL_ADDRESS" "$LCD_BASE")
    sleep 1 # Give chain a moment
  else
    break
  fi
done

echo "    Response: $UPDATE_RESP"

STATUS=$(echo "$UPDATE_RESP" | python3 -c "import sys, json; print(json.loads(sys.stdin.read()).get('status', ''))" 2>/dev/null || echo "")
if [ "$STATUS" != "success" ]; then
    echo "ERROR: Update content failed"
    exit 1
fi

# 5. Verify on LCD
echo "==> Verifying Deal on LCD..."
sleep 3 # Give it a moment to index if needed
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

# 6. Fetch File (Gateway)
echo "==> Fetching file from Gateway..."
# For gateway fetch, we need deal_id and owner
FETCH_URL="$GATEWAY_BASE/gateway/fetch/$MANIFEST_ROOT?deal_id=$DEAL_ID&owner=$NIL_ADDRESS"
timeout 10s curl -sS -o fetched_README.md "$FETCH_URL"

# Compare
if cmp -s "$ROOT_DIR/README.md" fetched_README.md; then
    echo "    Success: Fetched file matches original."
else
    echo "ERROR: Fetched file differs."
    ls -l "$ROOT_DIR/README_DIR" fetched_README.md
    exit 1
fi

rm fetched_README.md
echo "==> E2E Lifecycle Test Passed!"

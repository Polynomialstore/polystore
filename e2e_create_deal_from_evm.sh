#!/usr/bin/env bash
# End-to-end smoke test for MsgCreateDealFromEvm bridged via the gateway.
# Spins up the local stack, funds a known EVM-mapped account, creates a deal
# through /gateway/create-deal-evm, and verifies that the deal appears on LCD
# with the expected owner and CID.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_SCRIPT="$ROOT_DIR/scripts/run_local_stack.sh"
NILCHAIND_BIN="$ROOT_DIR/nilchain/nilchaind"

LCD_BASE="${LCD_BASE:-http://localhost:1317}"
GATEWAY_BASE="${GATEWAY_BASE:-http://localhost:8080}"
FAUCET_BASE="${FAUCET_BASE:-http://localhost:8081}"

if ! command -v curl >/dev/null 2>&1; then
  echo "ERROR: curl is required for this script" >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 is required for this script" >&2
  exit 1
fi

cleanup() {
  echo "==> Stopping local stack..."
  "$STACK_SCRIPT" stop || true
}
trap cleanup EXIT

wait_for_http() {
  local name="$1"
  local url="$2"
  local max_attempts="${3:-30}"
  local delay_secs="${4:-2}"

  echo "==> Waiting for $name at $url ..."
  local attempt
  for attempt in $(seq 1 "$max_attempts"); do
    # Treat any HTTP response code as "reachable"; 000 means connection error.
    local code
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "$url" || echo "000")
    if [ "$code" != "000" ]; then
      echo "    $name reachable (HTTP $code) after $attempt attempt(s)."
      return 0
    fi
    echo "    $name not yet reachable (attempt $attempt/$max_attempts); sleeping ${delay_secs}s..."
    sleep "$delay_secs"
  done

  echo "ERROR: $name at $url not reachable after $max_attempts attempts" >&2
  return 1
}

# Static dev key material (matches tools generated vector in this repo).
EVM_ADDRESS="0x29c8e5bC2c3DA80e7629661c5fa33a82eCFe411d"
NIL_ADDRESS="nil198ywt0pv8k5qua3fvcw9lge6stk0usgag8ehcl"
DEAL_CID="bafybridgedeale2e"

echo "==> Starting local stack..."
"$STACK_SCRIPT" start

wait_for_http "LCD" "$LCD_BASE/cosmos/base/tendermint/v1beta1/node_info" 40 3
wait_for_http "gateway" "$GATEWAY_BASE/gateway/create-deal-evm" 40 3

echo "==> Assuming pre-funded nil address from genesis..."

echo "==> Creating EVM-bridged deal via gateway..."
PAYLOAD=$(cat <<EOF
{
  "intent": {
    "creator_evm": "$EVM_ADDRESS",
    "cid": "$DEAL_CID",
    "size_bytes": 1048576,
    "duration_blocks": 100,
    "service_hint": "General",
    "initial_escrow": "1000000",
    "max_monthly_spend": "500000",
    "nonce": 1,
    "chain_id": "test-1"
  },
  "evm_signature": "0x4aa406871392611fe033bd652b8aeb8ccf8b9080f4665dc913ac9ba28adcbc4060ef264a2300963393a81771ef54cde8522744e835ce4e9455cea7d8464de46200"
}
EOF
)

RESP=$(curl -sS -X POST "$GATEWAY_BASE/gateway/create-deal-evm" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")
echo "Gateway response: $RESP"

# Extract tx_hash from gateway response.
TX_HASH=$(python3 - "$RESP" << 'PY'
import json, sys
try:
    data = json.loads(sys.argv[1])
except Exception:
    data = {}
txh = data.get("tx_hash") or ""
if not txh:
    sys.exit(1)
print(txh, end="")
PY
) || {
  echo "ERROR: gateway did not return a tx_hash" >&2
  exit 1
}

echo "==> Polling LCD for tx $TX_HASH..."
tx_ok=0
for attempt in $(seq 1 20); do
  TX_JSON=$(curl -sS "$LCD_BASE/cosmos/tx/v1beta1/txs/$TX_HASH" || true)
  status=$(printf '%s' "$TX_JSON" | python3 - << 'PY'
import json, sys
raw = sys.stdin.read()
if not raw.strip():
    print("NOTFOUND")
    sys.exit(0)
try:
    data = json.loads(raw)
except Exception:
    print("NOTFOUND")
    sys.exit(0)
resp = data.get("tx_response")
if not resp:
    print("NOTFOUND")
    sys.exit(0)
code = int(resp.get("code", 0))
if code == 0:
    print("OK")
    sys.exit(0)
raw_log = resp.get("raw_log", "")
print(f"ERR:{code}:{raw_log}")
PY
)
  if [ "$status" = "OK" ]; then
    tx_ok=1
    break
  elif [[ "$status" == ERR:* ]]; then
    echo "ERROR: tx failed: ${status#ERR:}" >&2
    exit 1
  fi
  echo "  tx attempt $attempt: not yet found, sleeping..."
  sleep 2
done

if [ "$tx_ok" -ne 1 ]; then
  echo "WARNING: tx $TX_HASH not confirmed via LCD after polling; proceeding to check deals directly" >&2
fi

echo "==> Polling LCD for created deal..."
TMP_JSON="$(mktemp)"
found=0
for attempt in $(seq 1 20); do
  curl -sS "$LCD_BASE/nilchain/nilchain/v1/deals" > "$TMP_JSON" || true
  if python3 - "$TMP_JSON" "$NIL_ADDRESS" "$DEAL_CID" << 'PY'
import json, sys
path, owner, cid = sys.argv[1], sys.argv[2], sys.argv[3]
data = json.load(open(path))
for d in data.get("deals", []):
    if d.get("owner") == owner and d.get("cid") == cid:
        print(f"Found deal id={d.get('id')} owner={owner}")
        sys.exit(0)
sys.exit(1)
PY
  then
    found=1
    break
  fi
  echo "  attempt $attempt: deal not yet visible, sleeping..."
  sleep 2
done

rm -f "$TMP_JSON"

if [ "$found" -ne 1 ]; then
  echo "ERROR: deal not found on LCD after polling" >&2
  exit 1
fi

echo "==> EVM-bridged deal creation succeeded."

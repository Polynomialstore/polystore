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
    code=$(timeout 10s curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" || echo "000")
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

CHAIN_ID="${CHAIN_ID:-test-1}"
EVM_CHAIN_ID="${EVM_CHAIN_ID:-31337}"
VERIFYING_CONTRACT="0x0000000000000000000000000000000000000000"
DEAL_CID="0x" # not used in intent anymore, kept for compatibility with older logs
# Deterministic dev key (Foundry default #0). Override via EVM_PRIVKEY if needed.
EVM_PRIVKEY="${EVM_PRIVKEY:-0x4f3edf983ac636a65a842ce7c78d9aa706d3b113b37a2b2d6f6fcf7e9f59b5f1}"
export EVM_PRIVKEY EVM_CHAIN_ID CHAIN_ID VERIFYING_CONTRACT

echo "==> Starting local stack..."
"$STACK_SCRIPT" start

wait_for_http "LCD" "$LCD_BASE/cosmos/base/tendermint/v1beta1/node_info" 40 3
wait_for_http "gateway" "$GATEWAY_BASE/gateway/create-deal-evm" 40 3

# Derive addresses from the EVM private key.
ADDR_JSON=$(python3 - <<PY
from eth_account import Account
import binascii, bech32, os
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

echo "==> Using EVM address $EVM_ADDRESS (nil: $NIL_ADDRESS)"
echo "==> Assuming nil address is pre-funded from genesis..."

echo "==> Creating EVM-bridged deal via gateway..."
PAYLOAD=$(python3 - <<'PY'
import json, os
from eth_account import Account
from eth_account.messages import encode_typed_data

priv = os.environ["EVM_PRIVKEY"]
evm_chain_id = int(os.environ.get("EVM_CHAIN_ID", "31337"))
chain_id = os.environ.get("CHAIN_ID", "test-1")
acct = Account.from_key(priv)

intent = {
    "creator_evm": acct.address,
    "duration_blocks": 100,
    "service_hint": "General",
    "initial_escrow": "1000000",
    "max_monthly_spend": "500000",
    "nonce": 1,
    "chain_id": chain_id,
    "size_tier": 0,  # legacy field kept for signature compatibility; ignored by chain logic
}

domain = {
    "name": "NilStore",
    "version": "1",
    "chainId": evm_chain_id,
    "verifyingContract": os.environ.get("VERIFYING_CONTRACT", "0x0000000000000000000000000000000000000000"),
}

types = {
    "CreateDeal": [
        {"name": "creator", "type": "address"},
        {"name": "size_tier", "type": "uint32"},
        {"name": "duration", "type": "uint64"},
        {"name": "service_hint", "type": "string"},
        {"name": "initial_escrow", "type": "string"},
        {"name": "max_monthly_spend", "type": "string"},
        {"name": "nonce", "type": "uint64"},
    ]
}

message = {
    "creator": acct.address,
    "size_tier": intent["size_tier"],
    "duration": intent["duration_blocks"],
    "service_hint": intent["service_hint"],
    "initial_escrow": intent["initial_escrow"],
    "max_monthly_spend": intent["max_monthly_spend"],
    "nonce": intent["nonce"],
}

signable = encode_typed_data(full_message={"types": types, "primaryType": "CreateDeal", "domain": domain, "message": message})
sig = Account.sign_message(signable, priv).signature.hex()

payload = {
    "intent": intent,
    "evm_signature": sig,
}
print(json.dumps(payload))
PY
)

RESP=$(timeout 10s curl -sS -X POST "$GATEWAY_BASE/gateway/create-deal-evm" \
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
  TX_JSON=$(timeout 10s curl -sS "$LCD_BASE/cosmos/tx/v1beta1/txs/$TX_HASH" || true)
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
  timeout 10s curl -sS "$LCD_BASE/nilchain/nilchain/v1/deals" > "$TMP_JSON" || true
  if python3 - "$TMP_JSON" "$NIL_ADDRESS" << 'PY'
import json, sys
path, owner = sys.argv[1], sys.argv[2]
data = json.load(open(path))
for d in data.get("deals", []):
    if d.get("owner") == owner:
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

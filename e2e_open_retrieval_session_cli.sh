#!/usr/bin/env bash
set -euo pipefail

# CLI integration test for opening a retrieval session.
# Uses a local chain harness and verifies the session is created.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHAIN_DIR="$ROOT_DIR/nilchain"
CORE_DIR="$ROOT_DIR/nil_core"
HOME_DIR="$ROOT_DIR/.nilchain_open_session"
CHAIN_ID="nilchain"
LOG_FILE="$ROOT_DIR/e2e_open_retrieval_session.log"
TRUSTED_SETUP="$ROOT_DIR/nilchain/trusted_setup.txt"
BINARY="$ROOT_DIR/nilchaind"
LCD_BASE="http://127.0.0.1:1317"
RPC_STATUS="http://127.0.0.1:26657/status"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1"
    exit 1
  fi
}

run_yes() {
  set +o pipefail
  yes | "$@"
  local status=$?
  set -o pipefail
  return $status
}

banner() {
  printf '\n>>> %s\n' "$*"
}

wait_for_height() {
  local target="$1"
  local attempts="${2:-60}"
  local delay="${3:-1}"
  local i
  for i in $(seq 1 "$attempts"); do
    local height
    height=$(timeout 10s curl -s --max-time 2 "$RPC_STATUS" | jq -r '.result.sync_info.latest_block_height' 2>/dev/null || echo "")
    if [ -n "$height" ] && [ "$height" != "null" ] && [ "$height" -ge "$target" ]; then
      return 0
    fi
    sleep "$delay"
  done
  return 1
}

wait_for_lcd() {
  local attempts="${1:-40}"
  local delay="${2:-1}"
  local i
  for i in $(seq 1 "$attempts"); do
    if timeout 10s curl -s --max-time 2 "$LCD_BASE/nilchain/nilchain/v1/params" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$delay"
  done
  return 1
}

wait_for_tx() {
  local hash="$1"
  local attempts="${2:-20}"
  local delay="${3:-1}"
  local i
  for i in $(seq 1 "$attempts"); do
    local out
    out=$("$BINARY" query tx "$hash" --home "$HOME_DIR" --node tcp://127.0.0.1:26657 --output json 2>/dev/null || true)
    if [ -n "$out" ] && echo "$out" | jq -e '.txhash' >/dev/null 2>&1; then
      echo "$out"
      return 0
    fi
    sleep "$delay"
  done
  return 1
}

cleanup() {
  if [ -n "${CHAIN_PID:-}" ]; then
    kill "$CHAIN_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

require_cmd cargo
require_cmd go
require_cmd jq
require_cmd curl
require_cmd python3

banner "Building nil_core"
pushd "$CORE_DIR" >/dev/null
cargo build --release
popd >/dev/null

export LD_LIBRARY_PATH="${LD_LIBRARY_PATH:-}:$CORE_DIR/target/release"
export DYLD_LIBRARY_PATH="${DYLD_LIBRARY_PATH:-}:$CORE_DIR/target/release"

banner "Building nilchaind"
pushd "$CHAIN_DIR" >/dev/null
export CGO_LDFLAGS="-L$CORE_DIR/target/release -lnil_core"
go build -o "$BINARY" ./cmd/nilchaind
popd >/dev/null

banner "Resetting chain"
pkill -f nilchaind >/dev/null 2>&1 || true
rm -rf "$HOME_DIR"
"$BINARY" init opensession --chain-id "$CHAIN_ID" --home "$HOME_DIR" >/dev/null 2>&1
"$BINARY" config set client chain-id "$CHAIN_ID" --home "$HOME_DIR"
"$BINARY" config set client keyring-backend test --home "$HOME_DIR"

banner "Creating accounts"
run_yes "$BINARY" keys add alice --home "$HOME_DIR" --keyring-backend test >/dev/null 2>&1
run_yes "$BINARY" keys add provider1 --home "$HOME_DIR" --keyring-backend test >/dev/null 2>&1

ALICE_ADDR=$("$BINARY" keys show alice -a --home "$HOME_DIR" --keyring-backend test | tail -n 1)
PROVIDER_ADDR=$("$BINARY" keys show provider1 -a --home "$HOME_DIR" --keyring-backend test | tail -n 1)
"$BINARY" genesis add-genesis-account "$ALICE_ADDR" 100000000000token,200000000stake --home "$HOME_DIR"
"$BINARY" genesis add-genesis-account "$PROVIDER_ADDR" 1000000000token,200000000stake --home "$HOME_DIR"

run_yes "$BINARY" genesis gentx alice 100000000stake --chain-id "$CHAIN_ID" --home "$HOME_DIR" --keyring-backend test >/dev/null 2>&1
"$BINARY" genesis collect-gentxs --home "$HOME_DIR" >/dev/null 2>&1

python3 - "$HOME_DIR/config/genesis.json" <<'PY' || true
import json, sys
path = sys.argv[1]
data = json.load(open(path))
bank = data.get("app_state", {}).get("bank", {})
md = bank.get("denom_metadata", [])
if not any(m.get("base") == "aatom" for m in md):
    md.append({
        "description": "EVM fee token metadata",
        "denom_units": [
            {"denom": "aatom", "exponent": 0, "aliases": ["uatom"]},
            {"denom": "atom", "exponent": 18, "aliases": []},
        ],
        "base": "aatom",
        "display": "atom",
        "name": "",
        "symbol": "",
        "uri": "",
        "uri_hash": ""
    })
bank["denom_metadata"] = md
data["app_state"]["bank"] = bank
json.dump(data, open(path, "w"), indent=1)
PY

sed -i.bak 's/timeout_commit = "5s"/timeout_commit = "1s"/' "$HOME_DIR/config/config.toml"
sed -i.bak 's/minimum-gas-prices = ""/minimum-gas-prices = "0token"/' "$HOME_DIR/config/app.toml"
sed -i.bak '/\[api\]/,/\[/{s/^enable = false/enable = true/;}' "$HOME_DIR/config/app.toml"

banner "Starting chain"
export KZG_TRUSTED_SETUP="$TRUSTED_SETUP"
"$BINARY" start --home "$HOME_DIR" --log_level info > "$LOG_FILE" 2>&1 &
CHAIN_PID=$!

banner "Waiting for chain/LCD"
wait_for_height 1 60 1 || { echo "Chain failed to start"; exit 1; }
wait_for_lcd 40 1 || { echo "LCD failed to start"; exit 1; }

banner "Registering provider"
run_yes "$BINARY" tx nilchain register-provider General 1000000000 \
  --from provider1 \
  --endpoint "/ip4/127.0.0.1/tcp/8082/http" \
  --chain-id "$CHAIN_ID" \
  --yes --home "$HOME_DIR" --keyring-backend test --broadcast-mode sync >/dev/null
sleep 2

banner "Creating deal"
CREATE_RES=$(run_yes "$BINARY" tx nilchain create-deal 50 1000000 5000 --service-hint "General" \
  --from alice --chain-id "$CHAIN_ID" --yes --home "$HOME_DIR" --keyring-backend test --broadcast-mode sync --output json)
CREATE_HASH=$(echo "$CREATE_RES" | jq -r '.txhash')
CREATE_TX=$(wait_for_tx "$CREATE_HASH" 30 1) || { echo "CreateDeal tx not found"; exit 1; }
DEAL_ID=$(echo "$CREATE_TX" | jq -r '(.logs[0].events[]? // .events[]?) | select(.type=="create_deal") | .attributes[] | select(.key=="deal_id") | .value' | head -n 1)
if [ -z "$DEAL_ID" ] || [ "$DEAL_ID" = "null" ]; then
  echo "Failed to parse deal id"
  exit 1
fi
echo "Deal ID: $DEAL_ID"

MANIFEST_ROOT="0x$(python3 - <<'PY'
print("22" * 48)
PY
)"
SIZE_BYTES=131072

banner "Updating deal content"
run_yes "$BINARY" tx nilchain update-deal-content --deal-id "$DEAL_ID" --cid "$MANIFEST_ROOT" --size "$SIZE_BYTES" \
  --from alice --chain-id "$CHAIN_ID" --yes --home "$HOME_DIR" --keyring-backend test --broadcast-mode sync >/dev/null
sleep 2

HEIGHT=$(timeout 10s curl -s "$RPC_STATUS" | jq -r '.result.sync_info.latest_block_height')
EXPIRES_AT=$((HEIGHT + 20))
NONCE=$(python3 - <<'PY'
import time
print(time.time_ns())
PY
)

banner "Opening retrieval session (CLI)"
run_yes "$BINARY" tx nilchain open-retrieval-session \
  --deal-id "$DEAL_ID" \
  --provider "$PROVIDER_ADDR" \
  --manifest-root "$MANIFEST_ROOT" \
  --start-mdu-index 0 \
  --start-blob-index 0 \
  --blob-count 1 \
  --nonce "$NONCE" \
  --expires-at "$EXPIRES_AT" \
  --from alice --chain-id "$CHAIN_ID" --yes --home "$HOME_DIR" --keyring-backend test --broadcast-mode sync >/dev/null

SESSION_ID=""
for i in {1..30}; do
  SESSION_JSON=$(timeout 10s curl -s "$LCD_BASE/nilchain/nilchain/v1/retrieval-sessions/by-owner/$ALICE_ADDR")
  SESSION_ID=$(echo "$SESSION_JSON" | jq -r --arg deal "$DEAL_ID" '.sessions[]? | select((.deal_id | tostring) == $deal) | .session_id' | head -n 1)
  if [ -n "$SESSION_ID" ] && [ "$SESSION_ID" != "null" ]; then
    break
  fi
  sleep 1
done

if [ -z "$SESSION_ID" ] || [ "$SESSION_ID" = "null" ]; then
  echo "Failed to resolve session id"
  exit 1
fi

STATUS=$(echo "$SESSION_JSON" | jq -r --arg deal "$DEAL_ID" '.sessions[]? | select((.deal_id | tostring) == $deal) | .status' | head -n 1)
if [ "$STATUS" != "RETRIEVAL_SESSION_STATUS_OPEN" ] && [ "$STATUS" != "1" ]; then
  echo "Unexpected session status: $STATUS"
  exit 1
fi

banner "Retrieval session CLI test passed"

#!/bin/bash
set -e

# Basic end-to-end smoke test for current (dynamic sizing) protocol:
#   - Initialize a local chain with test keyring (no OS keychain).
#   - Register providers.
#   - Create a deal (capacity only) and commit dummy content.
# This avoids legacy submit-proof flows which no longer exist.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHAIN_DIR="$ROOT_DIR/nilchain"
CORE_DIR="$ROOT_DIR/nil_core"
HOME_DIR="$ROOT_DIR/.nilchain_test"
CHAIN_ID="nilchain"
LOG_FILE="$ROOT_DIR/e2e_chain.log"
TRUSTED_SETUP="$ROOT_DIR/nilchain/trusted_setup.txt"

echo "[E2E] Starting End-to-End Test..."

echo "[E2E] Building nil_core..."
pushd "$CORE_DIR" >/dev/null
cargo build --release
popd >/dev/null

echo "[E2E] Building nilchaind..."
pushd "$CHAIN_DIR" >/dev/null
cp "$ROOT_DIR/demos/kzg/trusted_setup.txt" ./trusted_setup.txt
export CGO_LDFLAGS="-L$CORE_DIR/target/release -lnil_core"
go build -o "$ROOT_DIR/nilchaind" ./cmd/nilchaind
popd >/dev/null

BINARY="$ROOT_DIR/nilchaind"

echo "[E2E] Resetting chain..."
pkill -f nilchaind || true
rm -rf "$HOME_DIR"
"$BINARY" init testnode --chain-id "$CHAIN_ID" --home "$HOME_DIR" >/dev/null 2>&1
"$BINARY" config set client chain-id "$CHAIN_ID" --home "$HOME_DIR"
"$BINARY" config set client keyring-backend test --home "$HOME_DIR"

echo "[E2E] Creating accounts..."
yes | "$BINARY" keys add alice --home "$HOME_DIR" --keyring-backend test >/dev/null 2>&1
for i in {1..12}; do
  yes | "$BINARY" keys add "provider$i" --home "$HOME_DIR" --keyring-backend test >/dev/null 2>&1
done

ALICE_ADDR=$("$BINARY" keys show alice -a --home "$HOME_DIR" --keyring-backend test | tail -n 1)
"$BINARY" genesis add-genesis-account "$ALICE_ADDR" 100000000000token,200000000stake --home "$HOME_DIR"
for i in {1..12}; do
  PROV_ADDR=$("$BINARY" keys show "provider$i" -a --home "$HOME_DIR" --keyring-backend test | tail -n 1)
  "$BINARY" genesis add-genesis-account "$PROV_ADDR" 1000000000token,200000000stake --home "$HOME_DIR"
done

"$BINARY" genesis gentx alice 100000000stake --chain-id "$CHAIN_ID" --home "$HOME_DIR" --keyring-backend test >/dev/null 2>&1
"$BINARY" genesis collect-gentxs --home "$HOME_DIR" >/dev/null 2>&1

# Inject aatom denom metadata for Ethermint.
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

echo "[E2E] Starting chain..."
export KZG_TRUSTED_SETUP="$TRUSTED_SETUP"
"$BINARY" start --home "$HOME_DIR" --log_level info > "$LOG_FILE" 2>&1 &
CHAIN_PID=$!

echo "[E2E] Waiting for chain start..."
for i in {1..60}; do
  STATUS=$(timeout 10s curl -s --max-time 2 http://127.0.0.1:26657/status || echo "")
  if [ -n "$STATUS" ]; then
    HEIGHT=$(echo "$STATUS" | jq -r '.result.sync_info.latest_block_height' 2>/dev/null)
    if [[ -n "$HEIGHT" && "$HEIGHT" != "null" && "$HEIGHT" != "0" ]]; then
      echo "[E2E] Chain started at height $HEIGHT."
      break
    fi
  fi
  sleep 1
done

echo "[E2E] Registering providers..."
for i in {1..12}; do
  yes | "$BINARY" tx nilchain register-provider General 1000000000 --from "provider$i" --chain-id "$CHAIN_ID" --yes --home "$HOME_DIR" --keyring-backend test --broadcast-mode sync >/dev/null
done
sleep 2

echo "[E2E] Creating deal (capacity)..."
CREATE_RES=$(yes | "$BINARY" tx nilchain create-deal 50 1000000 5000 --from alice --chain-id "$CHAIN_ID" --yes --home "$HOME_DIR" --keyring-backend test --broadcast-mode sync --output json)
CREATE_HASH=$(echo "$CREATE_RES" | jq -r '.txhash')
sleep 4
CREATE_TX=$("$BINARY" query tx "$CREATE_HASH" --home "$HOME_DIR" --node tcp://127.0.0.1:26657 --output json 2>/dev/null | tail -n 1)
CREATE_CODE=$(echo "$CREATE_TX" | jq -r '.code // 0')
if [ "$CREATE_CODE" != "0" ]; then
  echo "[E2E] CreateDeal failed: $(echo "$CREATE_TX" | jq -r '.raw_log')"
  kill "$CHAIN_PID"
  exit 1
fi
DEAL_ID=$(echo "$CREATE_TX" | jq -r '(.logs[0].events[]? // .events[]?) | select(.type=="create_deal") | .attributes[] | select(.key=="deal_id") | .value' 2>/dev/null | head -n 1 || echo "0")
echo "[E2E] Deal ID: $DEAL_ID"

echo "[E2E] Committing dummy content..."
DUMMY_MANIFEST_ROOT="0x000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
UPDATE_RES=$(yes | "$BINARY" tx nilchain update-deal-content --deal-id "$DEAL_ID" --cid "$DUMMY_MANIFEST_ROOT" --size 1024 --from alice --chain-id "$CHAIN_ID" --yes --home "$HOME_DIR" --keyring-backend test --broadcast-mode sync --output json)
UPDATE_HASH=$(echo "$UPDATE_RES" | jq -r '.txhash')
sleep 4
UPDATE_TX=$("$BINARY" query tx "$UPDATE_HASH" --home "$HOME_DIR" --node tcp://127.0.0.1:26657 --output json 2>/dev/null | tail -n 1)
UPDATE_CODE=$(echo "$UPDATE_TX" | jq -r '.code // 0')
if [ "$UPDATE_CODE" != "0" ]; then
  echo "[E2E] UpdateDealContent failed: $(echo "$UPDATE_TX" | jq -r '.raw_log')"
  kill "$CHAIN_PID"
  exit 1
fi

echo "[E2E] SUCCESS: Smoke test completed."
kill "$CHAIN_PID"
rm -rf "$HOME_DIR"

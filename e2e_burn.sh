#!/bin/bash
set -e

# End-to-end burn/slash test.
# Current protocol slashes for missed proofs (EndBlock), not for invalid KZG openings.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHAIN_DIR="$ROOT_DIR/nilchain"
CORE_DIR="$ROOT_DIR/nil_core"
HOME_DIR="$ROOT_DIR/.nilchain_burn"
CHAIN_ID="nilchain"
LOG_FILE="$ROOT_DIR/e2e_burn.log"
TRUSTED_SETUP="$ROOT_DIR/nilchain/trusted_setup.txt"

echo "[E2E-BURN] Building..."
pushd "$CHAIN_DIR" >/dev/null
cp "$ROOT_DIR/demos/kzg/trusted_setup.txt" ./trusted_setup.txt
export CGO_LDFLAGS="-L$CORE_DIR/target/release -lnil_core"
go build -o "$ROOT_DIR/nilchaind" ./cmd/nilchaind
popd >/dev/null

BINARY="$ROOT_DIR/nilchaind"

echo "[E2E-BURN] Resetting chain..."
pkill -f nilchaind || true
rm -rf "$HOME_DIR"
"$BINARY" init burnnode --chain-id "$CHAIN_ID" --home "$HOME_DIR" >/dev/null 2>&1
"$BINARY" config set client chain-id "$CHAIN_ID" --home "$HOME_DIR"
"$BINARY" config set client keyring-backend test --home "$HOME_DIR"

echo "[E2E-BURN] Creating accounts..."
yes | "$BINARY" keys add user --home "$HOME_DIR" --keyring-backend test >/dev/null 2>&1
for i in {1..12}; do
  yes | "$BINARY" keys add "provider$i" --home "$HOME_DIR" --keyring-backend test >/dev/null 2>&1
done

USER_ADDR=$("$BINARY" keys show user -a --home "$HOME_DIR" --keyring-backend test | tail -n 1)

# Fund user + providers with enough stake to cover slashes (10_000_000 stake).
"$BINARY" genesis add-genesis-account "$USER_ADDR" 100000000000token,200000000stake --home "$HOME_DIR"
for i in {1..12}; do
  PROV_ADDR=$("$BINARY" keys show "provider$i" -a --home "$HOME_DIR" --keyring-backend test | tail -n 1)
  "$BINARY" genesis add-genesis-account "$PROV_ADDR" 1000000000token,200000000stake --home "$HOME_DIR"
done

"$BINARY" genesis gentx user 100000000stake --chain-id "$CHAIN_ID" --home "$HOME_DIR" --keyring-backend test >/dev/null 2>&1
"$BINARY" genesis collect-gentxs --home "$HOME_DIR" >/dev/null 2>&1

# Inject aatom denom metadata for Ethermint (older init flows omit this).
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

echo "[E2E-BURN] Starting chain..."
export KZG_TRUSTED_SETUP="$TRUSTED_SETUP"
"$BINARY" start --home "$HOME_DIR" --log_level info > "$LOG_FILE" 2>&1 &
CHAIN_PID=$!

echo "[E2E-BURN] Waiting for chain start..."
for i in {1..60}; do
  STATUS=$(timeout 10s curl -s --max-time 2 http://127.0.0.1:26657/status || echo "")
  if [ -n "$STATUS" ]; then
    HEIGHT=$(echo "$STATUS" | jq -r '.result.sync_info.latest_block_height' 2>/dev/null)
    if [[ -n "$HEIGHT" && "$HEIGHT" != "null" && "$HEIGHT" != "0" ]]; then
      echo "[E2E-BURN] Chain started at height $HEIGHT."
      break
    fi
  fi
  sleep 1
done

echo "[E2E-BURN] Registering providers..."
for i in {1..12}; do
  yes | "$BINARY" tx nilchain register-provider General 1000000000 --from "provider$i" --chain-id "$CHAIN_ID" --yes --home "$HOME_DIR" --keyring-backend test --broadcast-mode sync >/dev/null
done
sleep 2

echo "[E2E-BURN] Creating deal (capacity only)..."
CREATE_RES=$(yes | "$BINARY" tx nilchain create-deal 50 1000000 5000 --from user --chain-id "$CHAIN_ID" --yes --home "$HOME_DIR" --keyring-backend test --broadcast-mode sync --output json)
CREATE_HASH=$(echo "$CREATE_RES" | jq -r '.txhash')
sleep 4
CREATE_TX=$("$BINARY" query tx "$CREATE_HASH" --home "$HOME_DIR" --node tcp://127.0.0.1:26657 --output json 2>/dev/null | tail -n 1)
CREATE_CODE=$(echo "$CREATE_TX" | jq -r '.code // 0')
if [ "$CREATE_CODE" != "0" ]; then
  echo "[E2E-BURN] CreateDeal failed: $(echo "$CREATE_TX" | jq -r '.raw_log')"
  kill "$CHAIN_PID"
  exit 1
fi

PROVIDER1_ADDR=$("$BINARY" keys show provider1 -a --home "$HOME_DIR" --keyring-backend test | tail -n 1)
BAL_BEFORE=$("$BINARY" query bank balances "$PROVIDER1_ADDR" --home "$HOME_DIR" --output json | jq -r '.balances[] | select(.denom=="stake") | .amount')
echo "[E2E-BURN] Provider1 stake before: $BAL_BEFORE"

echo "[E2E-BURN] Waiting for missed-proof slashing (proof window + buffer)..."
sleep 20

BAL_AFTER=$("$BINARY" query bank balances "$PROVIDER1_ADDR" --home "$HOME_DIR" --output json | jq -r '.balances[] | select(.denom=="stake") | .amount')
echo "[E2E-BURN] Provider1 stake after: $BAL_AFTER"

if [ "$BAL_AFTER" -lt "$BAL_BEFORE" ]; then
  echo "[E2E-BURN] SUCCESS: Provider1 slashed and stake burned."
else
  echo "[E2E-BURN] FAILURE: Provider1 was not slashed."
  tail -n 80 "$LOG_FILE" || true
  kill "$CHAIN_PID"
  exit 1
fi

kill "$CHAIN_PID"
rm -rf "$HOME_DIR"

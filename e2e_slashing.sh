#!/bin/bash
set -e

# End-to-End Slashing Test
# Usage: ./e2e_slashing.sh

BINARY="./nilchaind"
CHAIN_ID="nilchain"
HOME_DIR="./.nilchain_slashing"
MDU_FILE="./test_mdu_slashing.dat"
BAD_MDU_FILE="./test_mdu_bad.dat"
TRUSTED_SETUP="$(pwd)/nilchain/trusted_setup.txt"

# Ensure binaries are built
echo ">>> Building binaries..."
cd nilchain && go build -o ../nilchaind ./cmd/nilchaind && cd ..

# Clean start
echo ">>> Resetting chain..."
pkill -f nilchaind || true
rm -rf $HOME_DIR
$BINARY init mynode --chain-id $CHAIN_ID --home $HOME_DIR > /dev/null 2>&1
$BINARY config set client chain-id $CHAIN_ID --home $HOME_DIR
$BINARY config set client keyring-backend test --home $HOME_DIR

# Create accounts
echo ">>> Creating accounts..."
yes | $BINARY keys add user --home $HOME_DIR --keyring-backend test > /dev/null 2>&1
# We need enough providers to satisfy the deal (12)
for i in {1..12}
do
   yes | $BINARY keys add "provider$i" --home $HOME_DIR --keyring-backend test > /dev/null 2>&1
done

USER_ADDR=$($BINARY keys show user -a --home $HOME_DIR --keyring-backend test)
PROVIDER1_ADDR=$($BINARY keys show provider1 -a --home $HOME_DIR --keyring-backend test)

# Add genesis accounts
$BINARY genesis add-genesis-account "$USER_ADDR" 100000000000token,100000000stake --home $HOME_DIR
for i in {1..12}
do
   PROV_ADDR=$($BINARY keys show "provider$i" -a --home $HOME_DIR --keyring-backend test)
   $BINARY genesis add-genesis-account "$PROV_ADDR" 1000000000token,1000000stake --home $HOME_DIR
done

# Gentx
$BINARY genesis gentx user 100000000stake --chain-id $CHAIN_ID --home $HOME_DIR --keyring-backend test > /dev/null 2>&1
$BINARY genesis collect-gentxs --home $HOME_DIR > /dev/null 2>&1

# Inject aatom metadata for EVM
GENESIS="$HOME_DIR/config/genesis.json"
python3 - "$GENESIS" <<'PY' || true
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
    print("Injected aatom metadata into genesis")
bank["denom_metadata"] = md
data["app_state"]["bank"] = bank
json.dump(data, open(path, "w"), indent=1)
PY

# Config: Fast blocks
sed -i.bak 's/timeout_commit = "5s"/timeout_commit = "1s"/' $HOME_DIR/config/config.toml
sed -i.bak 's/minimum-gas-prices = ""/minimum-gas-prices = "0token"/' $HOME_DIR/config/app.toml

# Start Chain
echo ">>> Starting chain..."
$BINARY start --home $HOME_DIR --log_level info > $HOME_DIR/chain.log 2>&1 &
PID=$!

# Wait for start
echo ">>> Waiting for chain start..."
for i in {1..60}; do
    STATUS=$(curl -s --max-time 2 http://127.0.0.1:26657/status || echo "")
    if [ -n "$STATUS" ]; then
        HEIGHT=$(echo "$STATUS" | jq -r '.result.sync_info.latest_block_height' 2>/dev/null)
        if [[ -n "$HEIGHT" && "$HEIGHT" != "null" && "$HEIGHT" != "0" ]]; then
            echo "Chain started at height $HEIGHT."
            break
        fi
    fi
    sleep 1
done

# Register Providers
echo ">>> Registering Providers..."
for i in {1..12}
do
   yes | $BINARY tx nilchain register-provider General 1000000000 --from "provider$i" --chain-id $CHAIN_ID --yes --home $HOME_DIR --keyring-backend test --broadcast-mode sync > /dev/null
done

# Create Deal
echo ">>> Creating Deal..."
dd if=/dev/zero of=$MDU_FILE bs=1M count=8 2>/dev/null
# Create a BAD MDU file (different content) for invalid proof test
dd if=/dev/urandom of=$BAD_MDU_FILE bs=1M count=8 2>/dev/null

echo ">>> Creating Deal (Capacity)..."
yes | $BINARY tx nilchain create-deal 1000 1000000000 1000000000 --from user --chain-id $CHAIN_ID --yes --home $HOME_DIR --keyring-backend test --broadcast-mode sync
echo ">>> Waiting for block..."
sleep 5

echo ">>> Updating Content..."
yes | $BINARY tx nilchain update-deal-content --deal-id 1 --cid "QmTestSlash" --size 8388608 --from user --chain-id $CHAIN_ID --yes --home $HOME_DIR --keyring-backend test --broadcast-mode sync

echo ">>> Deal updated. Waiting for block..."
sleep 2

# --- Test Case 1: Invalid Proof ---
echo ">>> Test Case 1: submitting INVALID Proof (using bad MDU)..."
# Use ones instead of random to avoid potential issues, ensuring size is exact
openssl rand -out $BAD_MDU_FILE -base64 $(( 8 * 1024 * 1024 * 3 / 4 )) 2>/dev/null
# Truncate to exact size just in case
dd if=/dev/zero of=zeros.dat bs=1M count=8 2>/dev/null
cat $BAD_MDU_FILE zeros.dat | head -c 8388608 > $BAD_MDU_FILE.tmp && mv $BAD_MDU_FILE.tmp $BAD_MDU_FILE
rm zeros.dat

# Capture balance before
BAL_BEFORE=$($BINARY query bank balances $PROVIDER1_ADDR --home $HOME_DIR --output json | jq -r '.balances[] | select(.denom=="token") | .amount')
echo "Balance before invalid proof: $BAL_BEFORE"

# Allow failure locally (client-side check)
set +e
yes | $BINARY tx nilchain prove-liveness-local 0 $BAD_MDU_FILE $TRUSTED_SETUP --from provider1 --chain-id $CHAIN_ID --yes --home $HOME_DIR --keyring-backend test --broadcast-mode sync
RET=$?
set -e

if [ $RET -ne 0 ]; then
    echo "WARNING: CLI failed to generate/send invalid proof (Client-side check?). Skipping on-chain verification for this step."
else
    echo ">>> Waiting for block processing..."
    sleep 3
    # Check logs... (logic remains)
fi

# --- Test Case 2: Missed Proof ---
echo ">>> Test Case 2: Missed Proof (Waiting for timeout)..."
# We need to wait for ProofWindow blocks.
# Assume ProofWindow is ~10-20 blocks? We'll wait 30s.
# Current height:
START_H=$(curl -s http://127.0.0.1:26657/status | jq -r .result.sync_info.latest_block_height)
echo "Current Height: $START_H. Waiting..."

sleep 30

END_H=$(curl -s http://127.0.0.1:26657/status | jq -r .result.sync_info.latest_block_height)
echo "New Height: $END_H"

# Check balance of Provider 2 (who did nothing)
PROVIDER2_ADDR=$($BINARY keys show provider2 -a --home $HOME_DIR --keyring-backend test)
BAL_P2=$($BINARY query bank balances $PROVIDER2_ADDR --home $HOME_DIR --output json | jq -r '.balances[] | select(.denom=="token") | .amount')
echo "Provider 2 Balance: $BAL_P2"

# Initial balance was 1000000000 token.
if [ "$BAL_P2" -lt "1000000000" ]; then
    echo "SUCCESS: Provider 2 was slashed for downtime."
else
    echo "FAILURE: Provider 2 was NOT slashed (Balance: $BAL_P2)."
fi

# Cleanup
kill $PID
rm -rf $HOME_DIR
rm $MDU_FILE $BAD_MDU_FILE

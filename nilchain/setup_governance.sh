#!/bin/bash
set -e

# Params
CHAIN_ID="nilchain"
BINARY="./nilchaind"
KEYRING="--keyring-backend test"

echo "[Gov] Starting chain for setup..."
pkill nilchaind || true
$BINARY start > gov_setup.log 2>&1 &
CHAIN_PID=$!
echo "[Gov] Chain PID: $CHAIN_PID"
sleep 10

echo "[Gov] Fetching Alice address..."
ALICE_ADDR=$($BINARY keys show alice -a $KEYRING)
echo "Alice: $ALICE_ADDR"

# 1. Create the Group
# Metadata: "NilStore Emergency Council"
# Members: defined in members.json
echo "[Gov] Creating Group..."
$BINARY tx group create-group "$ALICE_ADDR" "NilStore Emergency Council" members.json --from alice --chain-id $CHAIN_ID --yes $KEYRING

sleep 6

# 2. Get Group ID (assuming it's 1 if first)
GROUP_ID=1
echo "[Gov] Using Group ID: $GROUP_ID"

# 3. Create Group Policy
# Threshold: 2 (Alice + Bob both must sign)
# Windows: 1 day voting period
echo "[Gov] Creating Group Policy (Threshold 2)..."
$BINARY tx group create-group-policy "$ALICE_ADDR" $GROUP_ID "Emergency Policy" policy.json --from alice --chain-id $CHAIN_ID --yes $KEYRING

sleep 6

# 4. Verify
echo "[Gov] Emergency Council Setup Complete."
$BINARY q group groups-by-admin "$ALICE_ADDR" --output json

echo "[Gov] Stopping chain..."
kill $CHAIN_PID

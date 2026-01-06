#!/bin/bash
set -euo pipefail

# E2E Regression Test: Multi-SP Retrieval Proofs
# Tests that a Gateway can submit a retrieval proof for a deal owned by a DIFFERENT
# account (e.g. Provider A owns deal, Provider B hosts data).
#
# Requires: run_devnet_alpha_multi_sp.sh stack to be running.

GATEWAY_ROUTER="http://localhost:8080"
NILCHAIND="nilchain/nilchaind"
CHAIN_HOME="_artifacts/nilchain_data_devnet_alpha"
TMP_DIR="_artifacts/e2e_multi_sp_tmp"
mkdir -p "$TMP_DIR"

banner() { printf '\n>>> %s\n' "$*"; }
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

# 1. Setup
banner "Generating Test Data"
dd if=/dev/urandom of="$TMP_DIR/payload.bin" bs=1024 count=1024 2>/dev/null # 1MB

# 2. Identify Test Accounts (Provider1 = Owner)
banner "Resolving Accounts"
OWNER_ADDR=$($NILCHAIND keys show provider1 -a --home "$CHAIN_HOME" --keyring-backend test)
echo "Owner (Provider1): $OWNER_ADDR"

# 3. Create Deal
banner "Creating Deal"
CREATE_OUT=$($NILCHAIND tx nilchain create-deal 1000 1000000 1000000 --service-hint General --chain-id 31337 --from provider1 --yes --keyring-backend test --home "$CHAIN_HOME" --gas-prices 0.001aatom --output json)
TX_HASH=$(echo "$CREATE_OUT" | jq -r '.txhash')
echo "Create Deal Tx: $TX_HASH"

banner "Waiting for Deal on Chain..."
sleep 6
DEAL_LIST=$($NILCHAIND query nilchain list-deals --output json)
DEAL_ID=$(echo "$DEAL_LIST" | jq -r '.deals[-1].id')
echo "Deal ID: $DEAL_ID"

# 4. Upload Content (via Router)
banner "Uploading Content"
UPLOAD_RESP=$(curl -s -X POST -F "file=@$TMP_DIR/payload.bin;filename=payload.bin" "$GATEWAY_ROUTER/gateway/upload?deal_id=$DEAL_ID")
CID=$(echo "$UPLOAD_RESP" | jq -r '.cid')
SIZE=$(echo "$UPLOAD_RESP" | jq -r '.size_bytes')
TOTAL_MDUS=$(echo "$UPLOAD_RESP" | jq -r '.total_mdus')
WITNESS_MDUS=$(echo "$UPLOAD_RESP" | jq -r '.witness_mdus')

if [ "$CID" == "null" ]; then
    echo "Upload failed: $UPLOAD_RESP"
    exit 1
fi
echo "CID: $CID"

# 5. Commit Content
banner "Committing Content"
COMMIT_OUT=$($NILCHAIND tx nilchain update-deal-content --deal-id "$DEAL_ID" --cid "$CID" --size "$SIZE" --total-mdus "$TOTAL_MDUS" --witness-mdus "$WITNESS_MDUS" --chain-id 31337 --from provider1 --yes --keyring-backend test --home "$CHAIN_HOME" --gas-prices 0.001aatom --output json)
echo "Commit Tx: $(echo "$COMMIT_OUT" | jq -r '.txhash')"
sleep 6

# 6. Resolve Assigned Provider
banner "Resolving Assigned Provider"
DEAL_INFO=$($NILCHAIND query nilchain get-deal --id "$DEAL_ID" --output json)
ASSIGNED_ADDR=$(echo "$DEAL_INFO" | jq -r '.deal.providers[0]')
echo "Assigned Provider: $ASSIGNED_ADDR"

if [ "$ASSIGNED_ADDR" == "$OWNER_ADDR" ]; then
    echo "WARNING: Assigned provider IS the owner. This test works best when they differ."
    echo "Continuing anyway, as signature mismatch could still occur if code is wrong."
else
    echo "Confirmed: Assigned provider != Owner. Testing cross-account signing."
fi

PROVIDER_INFO=$($NILCHAIND query nilchain get-provider --address "$ASSIGNED_ADDR" --output json)
ENDPOINT=$(echo "$PROVIDER_INFO" | jq -r '.provider.endpoints[0]')
# Extract port from /ip4/127.0.0.1/tcp/PORT/http
PORT=$(echo "$ENDPOINT" | awk -F/ '{print $5}')
echo "Provider Port: $PORT"

# 7. Prove Retrieval (The Regression Test)
banner "Proving Retrieval (via Provider :$PORT)"
# This call triggers 'submitRetrievalProofNew' on the provider.
# BEFORE FIX: It would sign with the Provider's key -> Fail "unauthorized" on chain.
# AFTER FIX: It should look up Owner's key in shared keyring -> Sign with Owner key -> Success.
PROVE_RESP=$(curl -s -X POST -H "Content-Type: application/json" -d '{
    "deal_id": '$DEAL_ID',
    "manifest_root": "'$CID'",
    "file_path": "payload.bin",
    "owner": "'$OWNER_ADDR'",
    "epoch_id": 1
}' "http://localhost:$PORT/gateway/prove-retrieval")

echo "Prove Response: $PROVE_RESP"

ERR=$(echo "$PROVE_RESP" | jq -r '.error // empty')
if [ -n "$ERR" ]; then
    echo "❌ TEST FAILED: $ERR"
    exit 1
fi

TX_HASH_PROOF=$(echo "$PROVE_RESP" | jq -r '.tx_hash')
if [ "$TX_HASH_PROOF" == "null" ]; then
    echo "❌ TEST FAILED: No tx_hash in response"
    exit 1
fi

echo "✅ TEST PASSED: Retrieval proof submitted successfully."

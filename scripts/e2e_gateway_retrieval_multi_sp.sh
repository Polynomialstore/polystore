#!/bin/bash
set -euo pipefail

# E2E Regression Test: Multi-SP Retrieval Proofs
# Tests that a Gateway can submit a retrieval proof for a deal owned by a DIFFERENT
# account (e.g. Provider A owns deal, Provider B hosts data).
#
# Requires: run_devnet_alpha_multi_sp.sh stack to be running.

GATEWAY_ROUTER="http://localhost:8080"
POLYSTORECHAIND="polystorechain/polystorechaind"
CHAIN_HOME="_artifacts/polystorechain_data_devnet_alpha"
TMP_DIR="_artifacts/e2e_multi_sp_tmp"
mkdir -p "$TMP_DIR"

banner() { printf '\n>>> %s\n' "$*"; }
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

current_epoch() {
  local epoch_len height

  epoch_len=$($POLYSTORECHAIND query polystorechain params --home "$CHAIN_HOME" --output json | jq -r '.params.epoch_len_blocks // "0"')
  if [ -z "$epoch_len" ] || [ "$epoch_len" = "null" ]; then
    epoch_len="0"
  fi

  # Prefer CometBFT RPC directly (faster than polystorechaind status).
  height=$(curl -s "http://127.0.0.1:26657/status" | jq -r '.result.sync_info.latest_block_height // "1"')
  if [ -z "$height" ] || [ "$height" = "null" ]; then
    height="1"
  fi

  if [ "$epoch_len" -le 0 ]; then
    echo "1"
    return 0
  fi

  # epoch_id is 1-indexed: epoch=(height-1)/epoch_len + 1
  echo $(( (height - 1) / epoch_len + 1 ))
}

# 1. Setup
banner "Generating Test Data"
dd if=/dev/urandom of="$TMP_DIR/payload.bin" bs=1024 count=1024 2>/dev/null # 1MB

# 2. Identify Test Accounts (Provider1 = Owner)
banner "Resolving Accounts"
OWNER_ADDR=$($POLYSTORECHAIND keys show provider1 -a --home "$CHAIN_HOME" --keyring-backend test)
echo "Owner (Provider1): $OWNER_ADDR"

# 3. Create Deal
banner "Creating Deal"
# Use a 3-slot Mode 2 stripe for the multi-SP devnet (K=2,M=1).
# The gateway /gateway/prove-retrieval endpoint reconstructs the full MDU from per-slot shards on the router
# and submits the proof "as" the assigned provider.
CREATE_OUT=$($POLYSTORECHAIND tx polystorechain create-deal 1000 1000000 1000000 --service-hint "General:rs=2+1" --chain-id 31337 --from provider1 --yes --keyring-backend test --home "$CHAIN_HOME" --gas-prices 0.001aatom --output json)
TX_HASH=$(echo "$CREATE_OUT" | jq -r '.txhash')
echo "Create Deal Tx: $TX_HASH"

banner "Waiting for Deal on Chain..."
sleep 6
TX_QUERY=$($POLYSTORECHAIND query tx "$TX_HASH" --output json 2>/dev/null || echo "")
DEAL_ID=$(echo "$TX_QUERY" | jq -r '
  .events? // []
  | map(select(.type == "polystorechain.polystorechain.v1.EventCreateDeal" or .type == "create_deal"))
  | map(.attributes // [])
  | add
  | map(select(.key == "deal_id" or .key == "id"))
  | .[0].value // empty
')
if [ -z "$DEAL_ID" ]; then
  DEAL_LIST=$($POLYSTORECHAIND query polystorechain list-deals --output json)
  DEAL_ID=$(echo "$DEAL_LIST" | jq -r '.deals[-1].id')
fi
echo "Deal ID: $DEAL_ID"
if [ -z "$DEAL_ID" ] || [ "$DEAL_ID" == "null" ]; then
    echo "Create deal failed: deal_id not found"
    exit 1
fi

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
COMMIT_OUT=$($POLYSTORECHAIND tx polystorechain update-deal-content --deal-id "$DEAL_ID" --cid "$CID" --size "$SIZE" --total-mdus "$TOTAL_MDUS" --witness-mdus "$WITNESS_MDUS" --chain-id 31337 --from provider1 --yes --keyring-backend test --home "$CHAIN_HOME" --gas-prices 0.001aatom --output json)
echo "Commit Tx: $(echo "$COMMIT_OUT" | jq -r '.txhash')"
sleep 6

# 6. Resolve Assigned Provider
banner "Resolving Assigned Provider"
DEAL_INFO=$($POLYSTORECHAIND query polystorechain get-deal --id "$DEAL_ID" --output json)
ASSIGNED_ADDR=$(echo "$DEAL_INFO" | jq -r --arg owner "$OWNER_ADDR" '.deal.providers[] | select(. != $owner) | . ' | head -n1)
if [ -z "$ASSIGNED_ADDR" ] || [ "$ASSIGNED_ADDR" == "null" ]; then
  ASSIGNED_ADDR=$(echo "$DEAL_INFO" | jq -r '.deal.providers[0]')
fi
echo "Assigned Provider: $ASSIGNED_ADDR"

if [ "$ASSIGNED_ADDR" == "$OWNER_ADDR" ]; then
    echo "WARNING: Assigned provider IS the owner. This test works best when they differ."
    echo "Continuing anyway, as signature mismatch could still occur if code is wrong."
else
    echo "Confirmed: Assigned provider != Owner. Testing cross-account signing."
fi

PROVIDER_INFO=$($POLYSTORECHAIND query polystorechain get-provider --address "$ASSIGNED_ADDR" --output json)
ENDPOINT=$(echo "$PROVIDER_INFO" | jq -r '.provider.endpoints[0]')
# Extract port from /ip4/127.0.0.1/tcp/PORT/http
PORT=$(echo "$ENDPOINT" | awk -F/ '{print $5}')
echo "Provider Port: $PORT"

# 7. Prove Retrieval (The Regression Test)
banner "Proving Retrieval (via Router, submitting as assigned provider)"
EPOCH_ID="$(current_epoch)"
echo "Current Epoch: $EPOCH_ID"
# This call triggers 'submitRetrievalProofNew' on the router gateway, which reconstructs the Mode 2 MDU and
# submits the proof using the assigned provider key (shared keyring in local devnet).
PROVE_RESP=$(curl -s -X POST -H "Content-Type: application/json" -d '{
    "deal_id": '$DEAL_ID',
    "manifest_root": "'$CID'",
    "file_path": "payload.bin",
    "owner": "'$OWNER_ADDR'",
    "provider": "'$ASSIGNED_ADDR'",
    "epoch_id": '$EPOCH_ID'
}' "$GATEWAY_ROUTER/gateway/prove-retrieval")

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

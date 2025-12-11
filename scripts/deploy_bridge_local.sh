#!/bin/bash
set -euo pipefail

# Minimal helper to deploy NilBridge to the local EVM and capture the address.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
MNEMONIC="${MNEMONIC:-course what neglect valley visual ride common cricket bachelor rigid vessel mask actor pumpkin edit follow sorry used divorce odor ask exclude crew hole}"
PRIVATE_KEY="${PRIVATE_KEY:-}"

if ! command -v forge >/dev/null 2>&1; then
  echo "forge is required (foundry). Install via https://getfoundry.sh" >&2
  exit 1
fi
if ! command -v cast >/dev/null 2>&1; then
  echo "cast is required (foundry)." >&2
  exit 1
fi

if [ -z "$PRIVATE_KEY" ]; then
  # Derive the faucet dev key used by the local stack (index 0).
  PRIVATE_KEY=$(cast wallet private-key --mnemonic "$MNEMONIC" | sed 's/^0x//')
fi

echo ">>> Deploying NilBridge to $RPC_URL ..."
export PRIVATE_KEY
pushd "$REPO_ROOT/nil_bridge" >/dev/null
DEPLOY_LOG=$(forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$RPC_URL" \
  --broadcast \
  --legacy 2>&1 | tee /dev/fd/3 3>/dev/null)
popd >/dev/null

BRIDGE_ADDR=$(echo "$DEPLOY_LOG" | grep -Eo "0x[a-fA-F0-9]{40}" | tail -n 1)
if [ -z "$BRIDGE_ADDR" ]; then
  echo "✖ Could not parse NilBridge address from deploy output." >&2
  exit 1
fi

mkdir -p "$REPO_ROOT/_artifacts"
echo "$BRIDGE_ADDR" > "$REPO_ROOT/_artifacts/bridge_address.txt"
echo ">>> NilBridge deployed at $BRIDGE_ADDR"
echo ">>> Address written to _artifacts/bridge_address.txt"
echo ">>> Set VITE_BRIDGE_ADDRESS=$BRIDGE_ADDR for the dashboard bridge widgets."

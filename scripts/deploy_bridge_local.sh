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
  # Prefer the shared dev EVM key (used in e2e tests and pre-funded in genesis)
  # if provided, otherwise derive from the local mnemonic.
  if [ -n "${NIL_EVM_DEV_PRIVKEY:-}" ]; then
    PRIVATE_KEY="${NIL_EVM_DEV_PRIVKEY}"
  else
    # Derive the faucet dev key used by the local stack (index 0).
    PRIVATE_KEY=$(cast wallet private-key --mnemonic "$MNEMONIC")
  fi
fi

# Ensure 0x prefix for vm.envUint
if [[ ! "$PRIVATE_KEY" =~ ^0x ]]; then
  PRIVATE_KEY="0x$PRIVATE_KEY"
fi

echo ">>> Deploying NilBridge to $RPC_URL ..."
export PRIVATE_KEY
pushd "$REPO_ROOT/nil_bridge" >/dev/null

# Clean previous broadcast logs to avoid confusion
rm -rf broadcast/ cache/

# Run forge and capture output. 
# We disable 'set -e' temporarily to handle forge failure gracefully.
set +e
DEPLOY_LOG=$(forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$RPC_URL" \
  --broadcast \
  --legacy 2>&1)
FORGE_EXIT=$?
set -e
popd >/dev/null

# Check if forge failed
if [ $FORGE_EXIT -ne 0 ]; then
  echo "✖ Forge script failed. Output:" >&2
  echo "$DEPLOY_LOG" >&2
  
  # Special case: if tx is already in mempool or timed out, we might be able to recover if we can find the address in the log
  if echo "$DEPLOY_LOG" | grep -q "tx already in mempool"; then
     echo "⚠ Tx already in mempool. Attempting to parse address anyway..." >&2
  elif echo "$DEPLOY_LOG" | grep -q "request timed out"; then
     echo "⚠ Broadcast timed out. Attempting to parse address anyway..." >&2
  else
     exit 1
  fi
fi

BRIDGE_ADDR=$(echo "$DEPLOY_LOG" | grep -Eo "0x[a-fA-F0-9]{40}" | tail -n 1)
if [ -z "$BRIDGE_ADDR" ]; then
  echo "✖ Could not parse NilBridge address from deploy output." >&2
  exit 1
fi

echo ">>> Verifying NilBridge code at $BRIDGE_ADDR ..."
VERIFY_TIMEOUT_SECS="${VERIFY_TIMEOUT_SECS:-60}"
VERIFY_DEADLINE=$(( $(date +%s) + VERIFY_TIMEOUT_SECS ))
while true; do
  CODE=$(cast code --rpc-url "$RPC_URL" "$BRIDGE_ADDR" 2>/dev/null || true)
  if [ -n "$CODE" ] && [ "$CODE" != "0x" ]; then
    break
  fi
  if [ "$(date +%s)" -ge "$VERIFY_DEADLINE" ]; then
    echo "✖ NilBridge not deployed (eth_getCode returned 0x after ${VERIFY_TIMEOUT_SECS}s)." >&2
    exit 1
  fi
  sleep 2
done

mkdir -p "$REPO_ROOT/_artifacts"
echo "$BRIDGE_ADDR" > "$REPO_ROOT/_artifacts/bridge_address.txt"
echo ">>> NilBridge deployed at $BRIDGE_ADDR"
echo ">>> Address written to _artifacts/bridge_address.txt"
echo ">>> Set VITE_BRIDGE_ADDRESS=$BRIDGE_ADDR for the dashboard bridge widgets."

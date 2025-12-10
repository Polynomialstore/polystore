#!/bin/bash
set -e

# Configuration
RPC_URL="http://127.0.0.1:8545"
PRIVATE_KEY="0000000000000000000000000000000000000000000000000000000000000001" # Default faucet key? 
# Wait, faucet key in `nilchaind` is stored in keyring.
# To deploy via Forge, we need a private key.
# The `faucet` key in `nilchaind` usually corresponds to a known mnemonic.
# Mnemonic: "course what neglect valley visual ride common cricket bachelor rigid vessel mask actor pumpkin edit follow sorry used divorce odor ask exclude crew hole"
# We can derive the private key from this.
# Or we can export the key from `nilchaind` if it supports unsafe export.
# `nilchaind keys export faucet --unsafe --unarmored-hex`

# Let's try to export the faucet key from nilchaind to use with forge.
NILCHAIND="./nilchain/nilchaind"
HOME_DIR="./_artifacts/nilchain_data"

echo ">>> Exporting Faucet Private Key..."
# Note: modern cosmos-sdk might not support --unsafe --unarmored-hex easily in CLI.
# Alternative: Use the known mnemonic with cast (foundry tool).

MNEMONIC="course what neglect valley visual ride common cricket bachelor rigid vessel mask actor pumpkin edit follow sorry used divorce odor ask exclude crew hole"
PRIVATE_KEY=$(cast wallet private-key --mnemonic "$MNEMONIC" | sed 's/0x//')

echo ">>> Deploying NilBridge to Local EVM..."
cd nil_bridge
forge script script/Deploy.s.sol:Deploy \
    --rpc-url $RPC_URL \
    --private-key $PRIVATE_KEY \
    --broadcast \
    --legacy # Cosmos EVM sometimes needs legacy txs

echo ">>> Deployment Complete."

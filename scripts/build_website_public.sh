#!/usr/bin/env bash
set -euo pipefail

# Build nil-website with public endpoint env vars embedded at build time.
# Usage:
#   scripts/build_website_public.sh <domain>
# Example:
#   scripts/build_website_public.sh nilstore.org

if [ $# -lt 1 ]; then
  echo "usage: $0 <domain>" >&2
  exit 1
fi

DOMAIN="$1"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_DIR="$ROOT_DIR/nil-website"

CHAIN_ID="${CHAIN_ID:-31337}"
ENABLE_FAUCET="${ENABLE_FAUCET:-1}"
FAUCET_AUTH_TOKEN="${FAUCET_AUTH_TOKEN:-${VITE_FAUCET_AUTH_TOKEN:-}}"

VITE_API_BASE="${VITE_API_BASE:-https://faucet.${DOMAIN}}"
VITE_LCD_BASE="${VITE_LCD_BASE:-https://lcd.${DOMAIN}}"
# Gateway is sidecar-only for trusted devnet: keep localhost by default.
VITE_GATEWAY_BASE="${VITE_GATEWAY_BASE:-http://localhost:8080}"
VITE_EVM_RPC="${VITE_EVM_RPC:-https://evm.${DOMAIN}}"

cd "$WEB_DIR"
npm ci

echo "Building nil-website with:"
echo "  VITE_API_BASE=$VITE_API_BASE"
echo "  VITE_LCD_BASE=$VITE_LCD_BASE"
echo "  VITE_GATEWAY_BASE=$VITE_GATEWAY_BASE"
echo "  VITE_EVM_RPC=$VITE_EVM_RPC"
echo "  VITE_COSMOS_CHAIN_ID=$CHAIN_ID"
echo "  VITE_CHAIN_ID=$CHAIN_ID"
echo "  VITE_ENABLE_FAUCET=$ENABLE_FAUCET"
if [ -n "$FAUCET_AUTH_TOKEN" ]; then
  echo "  VITE_FAUCET_AUTH_TOKEN=(set)"
else
  echo "  VITE_FAUCET_AUTH_TOKEN=(not set)"
fi

VITE_API_BASE="$VITE_API_BASE" \
VITE_LCD_BASE="$VITE_LCD_BASE" \
VITE_GATEWAY_BASE="$VITE_GATEWAY_BASE" \
VITE_EVM_RPC="$VITE_EVM_RPC" \
VITE_COSMOS_CHAIN_ID="$CHAIN_ID" \
VITE_CHAIN_ID="$CHAIN_ID" \
VITE_ENABLE_FAUCET="$ENABLE_FAUCET" \
VITE_FAUCET_AUTH_TOKEN="$FAUCET_AUTH_TOKEN" \
npm run build

echo "Build complete: $WEB_DIR/dist"

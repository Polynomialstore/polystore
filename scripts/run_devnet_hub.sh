#!/usr/bin/env bash
set -euo pipefail

# Hub launcher for a multi-machine devnet.
#
# Starts:
# - nilchaind (RPC/LCD/EVM)
# - nil_faucet
# - nil_gateway in router mode (:8080)
# - nil-website (optional, on by default)
#
# Does NOT start any local providers. Remote providers can register and join.
#
# Usage:
#   ./scripts/run_devnet_hub.sh start
#   ./scripts/run_devnet_hub.sh stop

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ACTION="${1:-start}"

case "$ACTION" in
  start)
    PROVIDER_COUNT=0 START_WEB="${START_WEB:-1}" "$ROOT_DIR/scripts/run_devnet_alpha_multi_sp.sh" start
    ;;
  stop)
    PROVIDER_COUNT=0 START_WEB="${START_WEB:-1}" "$ROOT_DIR/scripts/run_devnet_alpha_multi_sp.sh" stop
    ;;
  *)
    echo "Usage: $0 [start|stop]" >&2
    exit 1
    ;;
esac


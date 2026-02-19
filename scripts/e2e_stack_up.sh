#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK_SCRIPT="$ROOT_DIR/scripts/run_devnet_alpha_multi_sp.sh"
PROFILE="${E2E_STACK_PROFILE:-fast}"

case "$PROFILE" in
  fast)
    export PROVIDER_COUNT="${PROVIDER_COUNT:-3}"
    ;;
  heavy)
    export PROVIDER_COUNT="${PROVIDER_COUNT:-12}"
    ;;
  *)
    echo "unknown E2E_STACK_PROFILE: $PROFILE (expected fast|heavy)" >&2
    exit 1
    ;;
esac

export START_WEB="${START_WEB:-1}"
exec "$STACK_SCRIPT" start

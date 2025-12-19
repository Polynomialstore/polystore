#!/usr/bin/env bash
# Run the lifecycle E2E test with the local gateway disabled (direct SP path).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export NIL_DISABLE_GATEWAY=1
export GATEWAY_BASE="${GATEWAY_BASE:-http://localhost:8082}"
export CHECK_GATEWAY_STATUS=1

"$ROOT_DIR/scripts/e2e_lifecycle.sh"

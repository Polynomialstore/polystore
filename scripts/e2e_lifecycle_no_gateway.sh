#!/usr/bin/env bash
# Run the lifecycle E2E test with direct-provider retrieval fetches while still
# using the local user-gateway for tx-relay/create/update endpoints.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export NIL_DISABLE_GATEWAY="${NIL_DISABLE_GATEWAY:-0}"
export NIL_FORCE_DIRECT_FETCH=1
export GATEWAY_BASE="${GATEWAY_BASE:-http://localhost:8080}"
export CHECK_GATEWAY_STATUS=1

"$ROOT_DIR/scripts/e2e_lifecycle.sh"

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK_SCRIPT="$ROOT_DIR/scripts/run_devnet_alpha_multi_sp.sh"

cleanup() {
  echo "==> Stopping devnet alpha multi-SP stack..."
  "$STACK_SCRIPT" stop || true
}
trap cleanup EXIT

echo "==> Starting devnet alpha multi-SP stack (providers=12)..."
# We need enough providers to ensure cross-provider routing happens.
export PROVIDER_COUNT=12
"$STACK_SCRIPT" start

echo "==> Waiting for stack health..."
# Wait for router
timeout 60s bash -c "until curl -s http://localhost:8080/health >/dev/null; do sleep 1; done" || { echo "Router failed to start"; exit 1; }
# Wait for provider 12 (last one)
timeout 60s bash -c "until curl -s http://localhost:8102/health >/dev/null; do sleep 1; done" || { echo "Provider 12 failed to start"; exit 1; }

echo "==> Running Regression Test..."
"$ROOT_DIR/scripts/e2e_gateway_retrieval_multi_sp.sh"

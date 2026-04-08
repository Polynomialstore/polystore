#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PROFILE="${E2E_STACK_PROFILE:-fast}"      # fast|heavy
CHAIN_ID="${CHAIN_ID:-20260211}"
EVM_CHAIN_ID="${EVM_CHAIN_ID:-$CHAIN_ID}"
START_WEB="${START_WEB:-1}"

case "$PROFILE" in
  fast) WANT_PROVIDERS="${PROVIDER_COUNT:-3}" ;;
  heavy) WANT_PROVIDERS="${PROVIDER_COUNT:-12}" ;;
  *)
    echo "unknown E2E_STACK_PROFILE: $PROFILE (expected fast|heavy)" >&2
    exit 1
    ;;
esac

LIB_DIR="$ROOT_DIR/polystore_core/target/release"
if [ ! -f "$LIB_DIR/libpolystore_core.so" ] && [ ! -f "$LIB_DIR/libpolystore_core.dylib" ] && [ ! -f "$LIB_DIR/libpolystore_core.a" ]; then
  echo "Building polystore_core first (missing native lib) ..."
  (cd "$ROOT_DIR/polystore_core" && cargo build --release)
fi
export LD_LIBRARY_PATH="$LIB_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

echo "Ensuring NilStore stack:"
echo "  profile=$PROFILE chain_id=$CHAIN_ID evm_chain_id=$EVM_CHAIN_ID providers=$WANT_PROVIDERS start_web=$START_WEB"

# Best-effort: if root-level services are running, they can conflict with local ports.
# Use non-interactive sudo to avoid blocking on password prompts.
if command -v sudo >/dev/null 2>&1; then
  sudo -n systemctl stop nilchaind polystore-faucet polystore-gateway-router polystore-gateway-provider polystore-gateway >/dev/null 2>&1 || true
fi

# Always reset local devnet stack first.
scripts/e2e_stack_down.sh >/dev/null 2>&1 || true

E2E_STACK_PROFILE="$PROFILE" \
PROVIDER_COUNT="$WANT_PROVIDERS" \
CHAIN_ID="$CHAIN_ID" \
EVM_CHAIN_ID="$EVM_CHAIN_ID" \
START_WEB="$START_WEB" \
scripts/e2e_stack_up.sh

scripts/devnet_healthcheck.sh hub

for i in $(seq 1 "$WANT_PROVIDERS"); do
  port="$((8090 + i))"
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/health" || true)"
  if [ "$code" != "200" ]; then
    echo "provider ${i} (port ${port}) unhealthy (HTTP ${code})" >&2
    exit 1
  fi
done

if [ "$START_WEB" = "1" ]; then
  web_ok=0
  for _ in $(seq 1 60); do
    code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5173/ || true)"
    if [ "$code" = "200" ]; then
      web_ok=1
      break
    fi
    sleep 1
  done
  if [ "$web_ok" != "1" ]; then
    echo "web failed to become ready on http://127.0.0.1:5173 after 60s" >&2
    if [ -f "$ROOT_DIR/_artifacts/devnet_alpha_multi_sp/website.log" ]; then
      echo "--- website.log (tail) ---" >&2
      tail -n 80 "$ROOT_DIR/_artifacts/devnet_alpha_multi_sp/website.log" >&2 || true
    fi
    exit 1
  fi
fi

echo
echo "STACK OK"
echo "RPC:     http://127.0.0.1:26657"
echo "LCD:     http://127.0.0.1:1317"
echo "EVM:     http://127.0.0.1:8545 (chain ${EVM_CHAIN_ID})"
echo "Gateway: http://127.0.0.1:8080"
echo "Web:     http://127.0.0.1:5173/#/dashboard"

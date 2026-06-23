#!/usr/bin/env bash
set -euo pipefail

# Validate the PolyFS root migration without mutating the live devnet by default.
# This is the #218 closeout harness: it composes the existing core, chain, and
# gateway sparse/high-index proof fixtures, then optionally records live devnet
# health evidence after the #217 rollout has been performed.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE_DIR="$ROOT_DIR/polystore_core"
CHAIN_DIR="$ROOT_DIR/polystorechain"
GATEWAY_DIR="$ROOT_DIR/polystore_gateway"

RUN_BUILD=1
RUN_LIVE_DEVNET=0

usage() {
  cat <<'EOF'
Usage: scripts/validate_polyfs_root_migration.sh [--skip-build] [--live-devnet]

Default behavior is non-destructive:
  - build polystore_core release library
  - run high-index core, chain, and gateway proof tests
  - syntax-check E2E scripts that use dummy PolyFS roots
  - run the #217 rollout dry-run if scripts/update_devnet_stack.sh exists

--live-devnet only collects service/endpoint health evidence. It does not
restart services and does not replace scripts/update_devnet_stack.sh for the
actual rollout.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-build)
      RUN_BUILD=0
      ;;
    --live-devnet)
      RUN_LIVE_DEVNET=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

run() {
  printf '\n>>> %s\n' "$*"
  "$@"
}

run_in() {
  local dir="$1"
  shift
  printf '\n>>> (cd %s && %s)\n' "$dir" "$*"
  (cd "$dir" && "$@")
}

wait_http_once() {
  local name="$1"
  local url="$2"
  local code
  code="$(timeout 10s curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" 2>/dev/null || true)"
  code="${code:-000}"
  printf '%s %s -> HTTP %s\n' "$name" "$url" "$code"
  [ "$code" != "000" ]
}

require_cmd cargo
require_cmd go
require_cmd bash

if [[ " ${GOFLAGS:-} " != *" -mod="* ]]; then
  export GOFLAGS="${GOFLAGS:-}${GOFLAGS:+ }-mod=readonly"
fi

if [ "$RUN_LIVE_DEVNET" = "1" ]; then
  require_cmd curl
  require_cmd systemctl
fi

printf 'PolyFS root migration validation\n'
printf 'repo=%s\n' "$ROOT_DIR"
printf 'branch=%s\n' "$(git -C "$ROOT_DIR" branch --show-current)"
printf 'commit=%s\n' "$(git -C "$ROOT_DIR" rev-parse HEAD)"
printf 'goflags=%s\n' "${GOFLAGS:-}"

if [ "$RUN_BUILD" = "1" ]; then
  run cargo build --release --manifest-path "$CORE_DIR/Cargo.toml"
fi

export LD_LIBRARY_PATH="$CORE_DIR/target/release${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export DYLD_LIBRARY_PATH="$CORE_DIR/target/release${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"

run cargo test --manifest-path "$CORE_DIR/Cargo.toml" --test mdu0_root_table_test -- --nocapture

run_in "$CHAIN_DIR" go test ./x/crypto_ffi -run 'TestVerifyMdu0RootTableProofRejectsWrongTargetRoot'
run_in "$CHAIN_DIR" go test ./x/polystorechain/keeper -run 'TestProveLiveness_HappyPath|TestRetrievalSession_Lifecycle_ConfirmThenProof'

run_in "$GATEWAY_DIR" go test . -run 'TestProofHeaderJSONHighIndexNoManifestBinVerifies|TestProofHeaderJSONRejectsStaleMdu0RootTable'

run bash -n \
  "$ROOT_DIR/e2e_retrieval_fees.sh" \
  "$ROOT_DIR/e2e_open_retrieval_session_cli.sh" \
  "$ROOT_DIR/e2e_open_retrieval_session_mode2_cli.sh" \
  "$ROOT_DIR/e2e_test.sh" \
  "$ROOT_DIR/e2e_slashing.sh"

if [ -x "$ROOT_DIR/scripts/update_devnet_stack.sh" ]; then
  run "$ROOT_DIR/scripts/update_devnet_stack.sh" --dry-run
else
  printf '\n>>> skipping rollout dry-run: scripts/update_devnet_stack.sh is not present on this branch yet\n'
fi

if [ "$RUN_LIVE_DEVNET" = "1" ]; then
  printf '\n>>> live devnet service status\n'
  systemctl is-active polystorechaind.service polystore-faucet.service polystore-gateway-router.service || true
  systemctl --user is-active \
    polystore-provider1.service \
    polystore-provider2.service \
    polystore-provider3.service \
    polystore-provider4.service || true

  printf '\n>>> live devnet endpoint health\n'
  wait_http_once "chain-lcd" "http://127.0.0.1:1317/cosmos/base/tendermint/v1beta1/node_info" || true
  wait_http_once "router" "http://127.0.0.1:18080/health" || true
  wait_http_once "faucet" "http://127.0.0.1:8081/health" || true
  wait_http_once "provider1" "http://127.0.0.1:8091/health" || true
  wait_http_once "provider2" "http://127.0.0.1:8092/health" || true
  wait_http_once "provider3" "http://127.0.0.1:8093/health" || true
  wait_http_once "provider4" "http://127.0.0.1:8094/health" || true

  if [ -x "$ROOT_DIR/scripts/devnet_healthcheck.sh" ]; then
    run "$ROOT_DIR/scripts/devnet_healthcheck.sh" hub || true
  fi
fi

printf '\nPolyFS root migration validation complete.\n'

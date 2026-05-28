#!/usr/bin/env bash
set -euo pipefail

SOURCE_ROOT="${SOURCE_ROOT:-/home/mikers/dev/polynomialstore/polystore}"
TARGET_ROOT="${TARGET_ROOT:-/opt/polystore}"
RUN_USER="${POLYSTORE_RUN_USER:-${SUDO_USER:-$(id -un)}}"
RUN_UID="$(id -u "$RUN_USER")"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$TARGET_ROOT/backups/update-$STAMP"
IS_ROOT=0
if [ "$(id -u)" -eq 0 ]; then
  IS_ROOT=1
fi

if [ "$IS_ROOT" -ne 1 ] && [ "$(id -un)" != "$RUN_USER" ]; then
  echo "ERROR: non-root update must run as POLYSTORE_RUN_USER=$RUN_USER." >&2
  exit 1
fi

if [ ! -w "$TARGET_ROOT" ]; then
  echo "ERROR: $TARGET_ROOT is not writable by $(id -un)." >&2
  echo "       Run: sudo $SOURCE_ROOT/ops/grant_devnet_user_ops.sh" >&2
  exit 1
fi

install_with_backup() {
  local src="$1"
  local dst="$2"
  local mode="$3"

  if [ ! -f "$src" ]; then
    echo "ERROR: source artifact missing: $src" >&2
    exit 1
  fi

  mkdir -p "$BACKUP_DIR/$(dirname "${dst#"$TARGET_ROOT"/}")" "$(dirname "$dst")"
  if [ -e "$dst" ]; then
    cp -p "$dst" "$BACKUP_DIR/${dst#"$TARGET_ROOT"/}"
  fi
  install -m "$mode" "$src" "$dst"
  sha256sum "$src" "$dst"
}

user_systemctl() {
  if [ "$IS_ROOT" -eq 1 ]; then
    runuser -u "$RUN_USER" -- env XDG_RUNTIME_DIR="/run/user/$RUN_UID" systemctl --user "$@"
    return
  fi

  env XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$RUN_UID}" systemctl --user "$@"
}

root_systemctl() {
  if [ "$IS_ROOT" -eq 1 ]; then
    systemctl "$@"
    return
  fi

  sudo -n systemctl "$@"
}

root_service_action() {
  local action="$1"
  shift

  local service
  for service in "$@"; do
    root_systemctl "$action" "$service"
  done
}

wait_http() {
  local name="$1"
  local url="$2"
  local attempts="${3:-60}"

  echo "==> Waiting for $name: $url"
  for _ in $(seq 1 "$attempts"); do
    if curl -fsS --max-time 5 "$url" >/dev/null; then
      echo "    OK: $name"
      return 0
    fi
    sleep 2
  done

  echo "ERROR: $name did not become healthy at $url" >&2
  return 1
}

echo "==> Updating PolyStore devnet stack from $SOURCE_ROOT"
echo "    backup dir: $BACKUP_DIR"

echo "==> Stopping provider user services"
user_systemctl stop polystore-provider1.service polystore-provider2.service polystore-provider3.service || true

echo "==> Stopping hub system services"
root_service_action stop polystore-gateway-router.service polystore-faucet.service polystorechaind.service

echo "==> Installing binaries and runtime library"
install_with_backup "$SOURCE_ROOT/polystore_core/target/release/libpolystore_core.so" "$TARGET_ROOT/polystore_core/target/release/libpolystore_core.so" 755
install_with_backup "$SOURCE_ROOT/polystorechain/polystorechaind" "$TARGET_ROOT/polystorechain/polystorechaind" 755
install_with_backup "$SOURCE_ROOT/polystore_gateway/polystore_gateway" "$TARGET_ROOT/polystore_gateway/polystore_gateway" 755
install_with_backup "$SOURCE_ROOT/polystore_faucet/polystore_faucet" "$TARGET_ROOT/polystore_faucet/polystore_faucet" 755
install_with_backup "$SOURCE_ROOT/polystore_cli/target/release/polystore_cli" "$TARGET_ROOT/polystore_cli/target/release/polystore_cli" 755
install_with_backup "$SOURCE_ROOT/polystorechain/trusted_setup.txt" "$TARGET_ROOT/polystorechain/trusted_setup.txt" 644

echo "==> Starting chain"
root_service_action start polystorechaind.service
wait_http "LCD node_info" "http://127.0.0.1:1317/cosmos/base/tendermint/v1beta1/node_info" 90

echo "==> Starting faucet and router"
root_service_action start polystore-faucet.service polystore-gateway-router.service
wait_http "faucet" "http://127.0.0.1:8081/health" 45
wait_http "router gateway" "http://127.0.0.1:18080/health" 45

echo "==> Starting provider user services"
user_systemctl start polystore-provider1.service polystore-provider2.service polystore-provider3.service
wait_http "provider1" "http://127.0.0.1:8091/health" 45
wait_http "provider2" "http://127.0.0.1:8092/health" 45
wait_http "provider3" "http://127.0.0.1:8093/health" 45

echo "==> Running hub healthcheck"
cd "$SOURCE_ROOT"
scripts/devnet_healthcheck.sh hub --gateway http://127.0.0.1:18080 --faucet http://127.0.0.1:8081

echo "==> Service status"
systemctl --no-pager --full status polystorechaind.service polystore-faucet.service polystore-gateway-router.service | sed -n '1,120p'
user_systemctl --no-pager --full status polystore-provider1.service polystore-provider2.service polystore-provider3.service | sed -n '1,120p'

echo "DONE: PolyStore devnet stack updated. Backups are in $BACKUP_DIR"

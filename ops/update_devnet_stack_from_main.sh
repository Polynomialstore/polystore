#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="${SOURCE_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
TARGET_ROOT="${TARGET_ROOT:-/opt/polystore}"
RUN_USER="${POLYSTORE_RUN_USER:-${SUDO_USER:-$(id -un)}}"
RUN_UID="$(id -u "$RUN_USER")"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$TARGET_ROOT/backups/update-$STAMP"
ROUTER_ENV_FILE="${ROUTER_ENV_FILE:-/etc/polystore/polystore-gateway-router.env}"
ROUTER_PORT="${ROUTER_PORT:-8080}"
FAUCET_URL="${FAUCET_URL:-http://127.0.0.1:8081}"
PROVIDER_UNITS="${PROVIDER_UNITS:-polystore-provider1.service polystore-provider2.service polystore-provider3.service}"
PROVIDER_HEALTH_URLS="${PROVIDER_HEALTH_URLS:-http://127.0.0.1:8091/health http://127.0.0.1:8092/health http://127.0.0.1:8093/health}"
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

env_listen_addr() {
  local env_file="$1"

  if [ ! -r "$env_file" ]; then
    return 1
  fi

  sed -n 's/^[[:space:]]*POLYSTORE_LISTEN_ADDR[[:space:]]*=[[:space:]]*//p' "$env_file" \
    | tail -n 1 \
    | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

http_url_from_listen_addr() {
  local listen_addr="$1"

  if [[ "$listen_addr" == http://* || "$listen_addr" == https://* ]]; then
    printf '%s\n' "$listen_addr"
    return
  fi

  if [[ "$listen_addr" == :* ]]; then
    printf 'http://127.0.0.1%s\n' "$listen_addr"
    return
  fi

  printf 'http://%s\n' "$listen_addr"
}

resolve_router_gateway_url() {
  local listen_addr

  if [ -n "${ROUTER_GATEWAY_URL:-}" ]; then
    printf '%s\n' "$ROUTER_GATEWAY_URL"
    return
  fi

  listen_addr="${POLYSTORE_LISTEN_ADDR:-}"
  if [ -z "$listen_addr" ]; then
    listen_addr="$(env_listen_addr "$ROUTER_ENV_FILE" || true)"
  fi
  if [ -z "$listen_addr" ]; then
    listen_addr="127.0.0.1:$ROUTER_PORT"
  fi

  http_url_from_listen_addr "$listen_addr"
}

user_unit_exists() {
  local unit="$1"

  if user_systemctl list-unit-files "$unit" --no-legend 2>/dev/null | awk 'NF { found = 1 } END { exit found ? 0 : 1 }'; then
    return 0
  fi

  user_systemctl status "$unit" >/dev/null 2>&1
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

router_gateway_url="$(resolve_router_gateway_url)"
read -r -a provider_units <<<"$PROVIDER_UNITS"
read -r -a provider_health_urls <<<"$PROVIDER_HEALTH_URLS"
active_provider_units=()
for unit in "${provider_units[@]}"; do
  if user_unit_exists "$unit"; then
    active_provider_units+=("$unit")
  else
    echo "WARN: provider user service not installed, skipping: $unit" >&2
  fi
done

echo "==> Stopping provider user services"
if [ "${#active_provider_units[@]}" -gt 0 ]; then
  user_systemctl stop "${active_provider_units[@]}" || true
else
  echo "    No provider user services configured on this host"
fi

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
wait_http "faucet" "$FAUCET_URL/health" 45
wait_http "router gateway" "$router_gateway_url/health" 45

echo "==> Starting provider user services"
if [ "${#active_provider_units[@]}" -gt 0 ]; then
  user_systemctl start "${active_provider_units[@]}"
  for i in "${!provider_health_urls[@]}"; do
    wait_http "provider$((i + 1))" "${provider_health_urls[$i]}" 45
  done
else
  echo "    Skipping provider start/health waits; no provider user services are installed"
fi

echo "==> Running hub healthcheck"
cd "$SOURCE_ROOT"
scripts/devnet_healthcheck.sh hub --gateway "$router_gateway_url" --faucet "$FAUCET_URL"

echo "==> Service status"
systemctl --no-pager --full status polystorechaind.service polystore-faucet.service polystore-gateway-router.service | sed -n '1,120p'
if [ "${#active_provider_units[@]}" -gt 0 ]; then
  user_systemctl --no-pager --full status "${active_provider_units[@]}" | sed -n '1,120p'
fi

echo "DONE: PolyStore devnet stack updated. Backups are in $BACKUP_DIR"

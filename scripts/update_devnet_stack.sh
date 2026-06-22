#!/usr/bin/env bash
#
# Rebuild and roll out the local PolyStore devnet stack as one proof-format unit.
# This script intentionally avoids git mutation. Run it from a checked-out branch
# that already contains the code you want installed.

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/update_devnet_stack.sh [flags]

Flags:
  --source-root DIR       Source checkout (default: current repo)
  --target-root DIR       Install root (default: /opt/polystore)
  --run-user USER         User that owns user systemd services (default: SUDO_USER or current user)
  --skip-build            Install existing artifacts without rebuilding
  --dry-run               Print actions without building, installing, or restarting
  --restart-tunnels       Restart cloudflared user services after provider-daemon services
  -h, --help              Show this help

Environment:
  POLYSTORE_PROVIDER_SERVICES   Space-separated user services to restart.
                                Default: polystore-provider1..polystore-provider4.
  POLYSTORE_TUNNEL_SERVICES     Space-separated tunnel user services.
                                Default: cloudflared-hub.service cloudflared-providers.service.
  POLYSTORE_RPC_BASE            Hub Tendermint RPC base URL (default: http://127.0.0.1:26657).
  POLYSTORE_LCD_BASE            Hub LCD base URL (default: http://127.0.0.1:1317).
  POLYSTORE_EVM_BASE            Hub EVM JSON-RPC base URL (default: http://127.0.0.1:8545).
  POLYSTORE_ROUTER_BASE         user-gateway base URL; legacy env alias keeps router naming
                                for compatibility (default: http://127.0.0.1:18080).
  POLYSTORE_FAUCET_BASE         Faucet base URL (default: http://127.0.0.1:8081).
  POLYSTORE_PROVIDER_BASES      Space-separated provider-daemon base URLs.
                                Default: http://127.0.0.1:8091..8094.
  POLYSTORE_SKIP_BUILD=1        Same as --skip-build.
  POLYSTORE_DRY_RUN=1           Same as --dry-run.
  POLYSTORE_RESTART_TUNNELS=1   Same as --restart-tunnels.
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_SOURCE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_ROOT="${SOURCE_ROOT:-$DEFAULT_SOURCE_ROOT}"
TARGET_ROOT="${TARGET_ROOT:-/opt/polystore}"
RUN_USER="${POLYSTORE_RUN_USER:-${SUDO_USER:-$(id -un)}}"
SKIP_BUILD="${POLYSTORE_SKIP_BUILD:-0}"
DRY_RUN="${POLYSTORE_DRY_RUN:-0}"
RESTART_TUNNELS="${POLYSTORE_RESTART_TUNNELS:-0}"

need_value() {
  local flag="$1"
  local value="${2:-}"
  if [[ -z "$value" || "$value" == -* ]]; then
    echo "ERROR: $flag requires a value" >&2
    usage >&2
    exit 2
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-root)
      need_value "$@"
      SOURCE_ROOT="$2"
      shift 2
      ;;
    --target-root)
      need_value "$@"
      TARGET_ROOT="$2"
      shift 2
      ;;
    --run-user)
      need_value "$@"
      RUN_USER="$2"
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --restart-tunnels)
      RESTART_TUNNELS=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown flag: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

RUN_UID="$(id -u "$RUN_USER")"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$TARGET_ROOT/backups/update-$STAMP"
IS_ROOT=0
if [[ "$(id -u)" -eq 0 ]]; then
  IS_ROOT=1
fi

read -r -a PROVIDER_SERVICES <<<"${POLYSTORE_PROVIDER_SERVICES:-polystore-provider1.service polystore-provider2.service polystore-provider3.service polystore-provider4.service}"
read -r -a ROOT_SERVICES <<<"polystorechaind.service polystore-faucet.service polystore-gateway-router.service"
read -r -a TUNNEL_SERVICES <<<"${POLYSTORE_TUNNEL_SERVICES:-cloudflared-hub.service cloudflared-providers.service}"
RPC_BASE="${POLYSTORE_RPC_BASE:-http://127.0.0.1:26657}"
LCD_BASE="${POLYSTORE_LCD_BASE:-http://127.0.0.1:1317}"
EVM_BASE="${POLYSTORE_EVM_BASE:-http://127.0.0.1:8545}"
ROUTER_BASE="${POLYSTORE_ROUTER_BASE:-http://127.0.0.1:18080}"
FAUCET_BASE="${POLYSTORE_FAUCET_BASE:-http://127.0.0.1:8081}"
read -r -a PROVIDER_BASES <<<"${POLYSTORE_PROVIDER_BASES:-http://127.0.0.1:8091 http://127.0.0.1:8092 http://127.0.0.1:8093 http://127.0.0.1:8094}"

if [[ "$IS_ROOT" -ne 1 && "$(id -un)" != "$RUN_USER" ]]; then
  echo "ERROR: non-root update must run as POLYSTORE_RUN_USER=$RUN_USER." >&2
  exit 1
fi

if [[ "$DRY_RUN" != "1" && ! -w "$TARGET_ROOT" ]]; then
  echo "ERROR: $TARGET_ROOT is not writable by $(id -un)." >&2
  echo "       Run with sudo or grant this user write access to the devnet install root." >&2
  exit 1
fi

run_cmd() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
  if [[ "$DRY_RUN" == "1" ]]; then
    return 0
  fi
  "$@"
}

run_in_dir() {
  local dir="$1"
  shift
  printf '+ (cd %q &&' "$dir"
  printf ' %q' "$@"
  printf ')\n'
  if [[ "$DRY_RUN" == "1" ]]; then
    return 0
  fi
  (cd "$dir" && "$@")
}

goflags_with_mod() {
  local current="${GOFLAGS:-}"
  if [[ " $current " == *" -mod="* ]]; then
    printf '%s' "$current"
  elif [[ -n "$current" ]]; then
    printf '%s -mod=mod' "$current"
  else
    printf '%s' "-mod=mod"
  fi
}

user_systemctl() {
  if [[ "$IS_ROOT" -eq 1 ]]; then
    run_cmd runuser -u "$RUN_USER" -- env XDG_RUNTIME_DIR="/run/user/$RUN_UID" systemctl --user "$@"
    return
  fi

  run_cmd env XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$RUN_UID}" systemctl --user "$@"
}

root_systemctl() {
  if [[ "$IS_ROOT" -eq 1 ]]; then
    run_cmd systemctl "$@"
    return
  fi

  run_cmd sudo -n systemctl "$@"
}

sha256_if_present() {
  local path="$1"
  if [[ -f "$path" ]]; then
    sha256sum "$path"
  else
    echo "MISSING $path"
  fi
}

install_with_backup() {
  local src="$1"
  local dst="$2"
  local mode="$3"

  echo "==> Installing artifact"
  echo "    src: $src"
  echo "    dst: $dst"
  echo "    mode: $mode"

  if [[ ! -f "$src" ]]; then
    if [[ "$DRY_RUN" == "1" ]]; then
      echo "    DRY-RUN: source artifact is missing and would fail in live mode"
      return 0
    fi
    echo "ERROR: source artifact missing: $src" >&2
    exit 1
  fi

  sha256_if_present "$src"
  if [[ -e "$dst" ]]; then
    sha256_if_present "$dst"
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "    DRY-RUN: would backup existing target and install"
    return 0
  fi

  mkdir -p "$BACKUP_DIR/$(dirname "${dst#"$TARGET_ROOT"/}")" "$(dirname "$dst")"
  if [[ -e "$dst" ]]; then
    cp -p "$dst" "$BACKUP_DIR/${dst#"$TARGET_ROOT"/}"
  fi
  install -m "$mode" "$src" "$dst"
  sha256_if_present "$dst"
}

preflight_artifacts() {
  local missing=0
  local artifacts=(
    "$SOURCE_ROOT/polystore_core/target/release/libpolystore_core.so"
    "$SOURCE_ROOT/polystorechain/polystorechaind"
    "$SOURCE_ROOT/polystore_gateway/polystore_gateway"
    "$SOURCE_ROOT/polystore_faucet/polystore_faucet"
    "$SOURCE_ROOT/polystore_cli/target/release/polystore_cli"
    "$SOURCE_ROOT/polystorechain/trusted_setup.txt"
  )

  echo "==> Preflighting install artifacts before stopping services"
  for artifact in "${artifacts[@]}"; do
    if [[ -f "$artifact" ]]; then
      sha256_if_present "$artifact"
      continue
    fi

    missing=1
    echo "MISSING $artifact" >&2
  done

  if [[ "$missing" -ne 0 ]]; then
    if [[ "$DRY_RUN" == "1" ]]; then
      echo "ERROR: missing install artifacts; dry-run aborting before service-stop plan" >&2
      exit 1
    fi

    echo "ERROR: missing install artifacts; aborting before service stop" >&2
    exit 1
  fi
}

build_artifacts() {
  if [[ "$SKIP_BUILD" == "1" ]]; then
    echo "==> Skipping builds (--skip-build)"
    return
  fi

  echo "==> Building coupled devnet artifacts"
  run_in_dir "$SOURCE_ROOT/polystore_core" cargo build --release
  run_in_dir "$SOURCE_ROOT/polystorechain" env GOFLAGS="$(goflags_with_mod)" go build -o "$SOURCE_ROOT/polystorechain/polystorechaind" ./cmd/polystorechaind
  run_in_dir "$SOURCE_ROOT/polystore_gateway" env GOFLAGS="$(goflags_with_mod)" go build -o "$SOURCE_ROOT/polystore_gateway/polystore_gateway" .
  run_in_dir "$SOURCE_ROOT/polystore_faucet" env GOFLAGS="$(goflags_with_mod)" go build -o "$SOURCE_ROOT/polystore_faucet/polystore_faucet" .
  run_in_dir "$SOURCE_ROOT/polystore_cli" cargo build --release
}

wait_http() {
  local name="$1"
  local url="$2"
  local attempts="${3:-60}"

  echo "==> Waiting for $name: $url"
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "    DRY-RUN: would poll $url"
    return 0
  fi

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

print_source_evidence() {
  echo "==> Source evidence"
  echo "    source root: $SOURCE_ROOT"
  echo "    target root: $TARGET_ROOT"
  echo "    run user: $RUN_USER uid=$RUN_UID"
  echo "    backup dir: $BACKUP_DIR"
  if git -C "$SOURCE_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "    source commit: $(git -C "$SOURCE_ROOT" rev-parse HEAD)"
    echo "    source branch: $(git -C "$SOURCE_ROOT" rev-parse --abbrev-ref HEAD)"
    echo "    source status:"
    git -C "$SOURCE_ROOT" status --short || true
  fi
  echo "    provider-daemon services: ${PROVIDER_SERVICES[*]}"
  echo "    root services: ${ROOT_SERVICES[*]}"
  echo "    rpc base: $RPC_BASE"
  echo "    lcd base: $LCD_BASE"
  echo "    evm base: $EVM_BASE"
  echo "    user-gateway base: $ROUTER_BASE (POLYSTORE_ROUTER_BASE legacy env alias)"
  echo "    faucet base: $FAUCET_BASE"
  echo "    provider-daemon bases: ${PROVIDER_BASES[*]}"
  if [[ "$RESTART_TUNNELS" == "1" ]]; then
    echo "    tunnel services: ${TUNNEL_SERVICES[*]}"
  else
    echo "    tunnel services: skipped unless --restart-tunnels is supplied"
  fi
}

print_service_status() {
  echo "==> Root service activity"
  root_systemctl is-active "${ROOT_SERVICES[@]}"
  if [[ "$DRY_RUN" != "1" ]]; then
    if [[ "$IS_ROOT" -eq 1 ]]; then
      systemctl --no-pager --full status "${ROOT_SERVICES[@]}" | sed -n '1,160p' || true
    else
      sudo -n systemctl --no-pager --full status "${ROOT_SERVICES[@]}" | sed -n '1,160p' || true
    fi
  fi

  echo "==> Provider service activity"
  user_systemctl is-active "${PROVIDER_SERVICES[@]}"
  if [[ "$DRY_RUN" != "1" ]]; then
    if [[ "$IS_ROOT" -eq 1 ]]; then
      runuser -u "$RUN_USER" -- env XDG_RUNTIME_DIR="/run/user/$RUN_UID" systemctl --user --no-pager --full status "${PROVIDER_SERVICES[@]}" | sed -n '1,200p' || true
    else
      env XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$RUN_UID}" systemctl --user --no-pager --full status "${PROVIDER_SERVICES[@]}" | sed -n '1,200p' || true
    fi
  fi
}

run_healthchecks() {
  wait_http "LCD node_info" "$LCD_BASE/cosmos/base/tendermint/v1beta1/node_info" 90
  wait_http "user-gateway (legacy router service)" "$ROUTER_BASE/health" 45
  wait_http "faucet" "$FAUCET_BASE/health" 45
  for i in "${!PROVIDER_BASES[@]}"; do
    wait_http "provider-daemon$((i + 1))" "${PROVIDER_BASES[$i]}/health" 45
  done

  echo "==> Running scripted healthchecks"
  run_in_dir "$SOURCE_ROOT" scripts/devnet_healthcheck.sh hub --rpc "$RPC_BASE" --lcd "$LCD_BASE" --evm "$EVM_BASE" --gateway "$ROUTER_BASE" --faucet "$FAUCET_BASE"
  for provider_base in "${PROVIDER_BASES[@]}"; do
    run_in_dir "$SOURCE_ROOT" scripts/devnet_healthcheck.sh provider --provider "$provider_base" --hub-lcd "$LCD_BASE"
  done
}

print_source_evidence
build_artifacts
preflight_artifacts

echo "==> Stop order: provider-daemons -> user-gateway/faucet -> chain"
user_systemctl stop "${PROVIDER_SERVICES[@]}"
root_systemctl stop polystore-gateway-router.service polystore-faucet.service
root_systemctl stop polystorechaind.service
if [[ "$RESTART_TUNNELS" == "1" ]]; then
  echo "==> Stopping tunnel user services"
  user_systemctl stop "${TUNNEL_SERVICES[@]}" || true
fi

echo "==> Installing binaries and runtime inputs"
install_with_backup "$SOURCE_ROOT/polystore_core/target/release/libpolystore_core.so" "$TARGET_ROOT/polystore_core/target/release/libpolystore_core.so" 755
install_with_backup "$SOURCE_ROOT/polystorechain/polystorechaind" "$TARGET_ROOT/polystorechain/polystorechaind" 755
install_with_backup "$SOURCE_ROOT/polystore_gateway/polystore_gateway" "$TARGET_ROOT/polystore_gateway/polystore_gateway" 755
install_with_backup "$SOURCE_ROOT/polystore_faucet/polystore_faucet" "$TARGET_ROOT/polystore_faucet/polystore_faucet" 755
install_with_backup "$SOURCE_ROOT/polystore_cli/target/release/polystore_cli" "$TARGET_ROOT/polystore_cli/target/release/polystore_cli" 755
install_with_backup "$SOURCE_ROOT/polystorechain/trusted_setup.txt" "$TARGET_ROOT/polystorechain/trusted_setup.txt" 644

echo "==> Start order: chain -> faucet/user-gateway -> provider-daemons"
root_systemctl start polystorechaind.service
wait_http "LCD node_info" "$LCD_BASE/cosmos/base/tendermint/v1beta1/node_info" 90
root_systemctl start polystore-faucet.service polystore-gateway-router.service
wait_http "faucet" "$FAUCET_BASE/health" 45
wait_http "user-gateway (legacy router service)" "$ROUTER_BASE/health" 45
user_systemctl start "${PROVIDER_SERVICES[@]}"
for i in "${!PROVIDER_BASES[@]}"; do
  wait_http "provider-daemon$((i + 1))" "${PROVIDER_BASES[$i]}/health" 45
done
if [[ "$RESTART_TUNNELS" == "1" ]]; then
  echo "==> Starting tunnel user services"
  user_systemctl start "${TUNNEL_SERVICES[@]}"
fi

run_healthchecks
print_service_status

echo "DONE: PolyStore devnet stack updated. Backups are in $BACKUP_DIR"

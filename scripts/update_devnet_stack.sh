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
  POLYSTORE_PROVIDER_SERVICES   Space-separated provider-daemon services to restart.
                                Default: polystore-provider1..polystore-provider4,
                                or the checked-in root provider template when
                                POLYSTORE_PROVIDER_SERVICE_SCOPE=root.
  POLYSTORE_PROVIDER_SERVICE_SCOPE
                                Provider service manager: auto, user, or root
                                (default: auto).
  POLYSTORE_TUNNEL_SERVICES     Space-separated tunnel user services.
                                Default: cloudflared-hub.service cloudflared-providers.service.
  POLYSTORE_RPC_BASE            Hub Tendermint RPC base URL (default: http://127.0.0.1:26657).
  POLYSTORE_LCD_BASE            Hub LCD base URL (default: http://127.0.0.1:1317).
  POLYSTORE_EVM_BASE            Hub EVM JSON-RPC base URL (default: http://127.0.0.1:8545).
  POLYSTORE_ROUTER_BASE         user-gateway base URL; legacy env alias keeps router naming
                                for compatibility (default: http://127.0.0.1:8080).
  POLYSTORE_FAUCET_BASE         Faucet base URL (default: http://127.0.0.1:8081).
  POLYSTORE_PROVIDER_BASES      Space-separated provider-daemon base URLs.
                                Default: one URL per resolved provider-daemon
                                service, starting at http://127.0.0.1:8091.
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
if ! RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"; then
  echo "ERROR: could not look up run user $RUN_USER." >&2
  exit 1
fi
if [[ -z "$RUN_HOME" ]]; then
  echo "ERROR: could not determine home directory for run user $RUN_USER." >&2
  exit 1
fi
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$TARGET_ROOT/backups/update-$STAMP"
IS_ROOT=0
if [[ "$(id -u)" -eq 0 ]]; then
  IS_ROOT=1
fi

DEFAULT_USER_PROVIDER_SERVICES=(polystore-provider1.service polystore-provider2.service polystore-provider3.service polystore-provider4.service)
DEFAULT_ROOT_PROVIDER_SERVICES=(polystore-gateway-provider.service)
PROVIDER_SERVICES_FROM_ENV=0
PROVIDER_SERVICE_SCOPE="${POLYSTORE_PROVIDER_SERVICE_SCOPE:-auto}"
if [[ -n "${POLYSTORE_PROVIDER_SERVICES+x}" ]]; then
  PROVIDER_SERVICES_FROM_ENV=1
  read -r -a PROVIDER_SERVICES <<<"$POLYSTORE_PROVIDER_SERVICES"
  if [[ "${#PROVIDER_SERVICES[@]}" -eq 0 ]]; then
    echo "ERROR: POLYSTORE_PROVIDER_SERVICES was provided but no provider-daemon services were listed." >&2
    echo "       Unset it to use the default provider inventory, or provide one or more service names." >&2
    exit 2
  fi
elif [[ "$PROVIDER_SERVICE_SCOPE" == "root" ]]; then
  PROVIDER_SERVICES=("${DEFAULT_ROOT_PROVIDER_SERVICES[@]}")
else
  PROVIDER_SERVICES=("${DEFAULT_USER_PROVIDER_SERVICES[@]}")
fi
read -r -a ROOT_SERVICES <<<"polystorechaind.service polystore-faucet.service polystore-gateway-router.service"
read -r -a TUNNEL_SERVICES <<<"${POLYSTORE_TUNNEL_SERVICES:-cloudflared-hub.service cloudflared-providers.service}"
RPC_BASE="${POLYSTORE_RPC_BASE:-http://127.0.0.1:26657}"
LCD_BASE="${POLYSTORE_LCD_BASE:-http://127.0.0.1:1317}"
EVM_BASE="${POLYSTORE_EVM_BASE:-http://127.0.0.1:8545}"
ROUTER_BASE="${POLYSTORE_ROUTER_BASE:-http://127.0.0.1:8080}"
FAUCET_BASE="${POLYSTORE_FAUCET_BASE:-http://127.0.0.1:8081}"
PROVIDER_BASES_FROM_ENV=0
if [[ -n "${POLYSTORE_PROVIDER_BASES+x}" ]]; then
  PROVIDER_BASES_FROM_ENV=1
  read -r -a PROVIDER_BASES <<<"$POLYSTORE_PROVIDER_BASES"
else
  PROVIDER_BASES=()
fi

if [[ "$IS_ROOT" -ne 1 && "$(id -un)" != "$RUN_USER" ]]; then
  echo "ERROR: non-root update must run as POLYSTORE_RUN_USER=$RUN_USER." >&2
  exit 1
fi

case "$PROVIDER_SERVICE_SCOPE" in
  auto|user|root)
    ;;
  *)
    echo "ERROR: POLYSTORE_PROVIDER_SERVICE_SCOPE must be auto, user, or root." >&2
    exit 2
    ;;
esac

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

run_build_in_dir() {
  local dir="$1"
  shift

  if [[ "$IS_ROOT" -eq 1 && "$RUN_USER" != "root" ]]; then
    printf '+ (cd %q && runuser -u %q -- env HOME=%q XDG_RUNTIME_DIR=%q' "$dir" "$RUN_USER" "$RUN_HOME" "/run/user/$RUN_UID"
    printf ' %q' "$@"
    printf ')\n'
    if [[ "$DRY_RUN" == "1" ]]; then
      return 0
    fi
    (cd "$dir" && runuser -u "$RUN_USER" -- env HOME="$RUN_HOME" XDG_RUNTIME_DIR="/run/user/$RUN_UID" "$@")
    return
  fi

  run_in_dir "$dir" "$@"
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

provider_base_for_service() {
  local service="$1"
  local provider_index port

  if [[ "$service" =~ ^polystore-provider([0-9]+)\.service$ ]]; then
    provider_index="${BASH_REMATCH[1]}"
    port=$((8090 + provider_index))
    printf 'http://127.0.0.1:%s' "$port"
    return 0
  fi

  if [[ "$service" == "polystore-gateway-provider.service" ]]; then
    printf 'http://127.0.0.1:8091'
    return 0
  fi

  return 1
}

set_default_provider_bases() {
  local service base

  PROVIDER_BASES=()
  for service in "$@"; do
    if ! base="$(provider_base_for_service "$service")"; then
      echo "ERROR: cannot derive provider-daemon base URL for service: $service" >&2
      echo "       Set POLYSTORE_PROVIDER_BASES with one URL per resolved provider-daemon service." >&2
      exit 1
    fi
    PROVIDER_BASES+=("$base")
  done
}

resolve_provider_bases() {
  local expected_count="$1"
  shift
  local actual_count="${#PROVIDER_BASES[@]}"
  local prefix=""

  if [[ "$DRY_RUN" == "1" ]]; then
    prefix="DRY-RUN "
  fi

  if [[ "$PROVIDER_BASES_FROM_ENV" -eq 1 ]]; then
    if [[ "$actual_count" -ne "$expected_count" ]]; then
      echo "ERROR: POLYSTORE_PROVIDER_BASES has $actual_count entries but $expected_count provider-daemon services were resolved." >&2
      echo "       Provide exactly one base URL per provider-daemon service, or unset POLYSTORE_PROVIDER_BASES to derive defaults." >&2
      exit 1
    fi

    echo "    ${prefix}provider-daemon bases from POLYSTORE_PROVIDER_BASES: ${PROVIDER_BASES[*]}"
    return
  fi

  set_default_provider_bases "$@"
  echo "    ${prefix}provider-daemon bases derived from resolved services: ${PROVIDER_BASES[*]}"
}

user_unit_load_state() {
  local service="$1"
  if [[ "$IS_ROOT" -eq 1 ]]; then
    runuser -u "$RUN_USER" -- env XDG_RUNTIME_DIR="/run/user/$RUN_UID" systemctl --user show "$service" --property=LoadState --value 2>/dev/null
    return
  fi

  env XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$RUN_UID}" systemctl --user show "$service" --property=LoadState --value 2>/dev/null
}

root_unit_load_state() {
  local service="$1"
  if [[ "$IS_ROOT" -eq 1 ]]; then
    systemctl show "$service" --property=LoadState --value 2>/dev/null
    return
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    systemctl show "$service" --property=LoadState --value 2>/dev/null
    return
  fi

  sudo -n systemctl show "$service" --property=LoadState --value 2>/dev/null
}

unit_is_loaded() {
  local load_state="$1"
  [[ "$load_state" == "loaded" ]]
}

describe_load_state() {
  local load_state="$1"
  if [[ -n "$load_state" ]]; then
    printf '%s' "$load_state"
  else
    printf 'unavailable'
  fi
}

require_provider_service_loaded() {
  local scope="$1"
  local service="$2"
  local load_state

  if [[ "$scope" == "user" ]]; then
    load_state="$(user_unit_load_state "$service" || true)"
  else
    load_state="$(root_unit_load_state "$service" || true)"
  fi

  if ! unit_is_loaded "$load_state"; then
    echo "ERROR: provider-daemon service $service is not loaded in the $scope systemd manager." >&2
    echo "       LoadState=$(describe_load_state "$load_state"); fix the unit before stopping services." >&2
    exit 1
  fi
}

declare -a PROVIDER_USER_SERVICES=()
declare -a PROVIDER_ROOT_SERVICES=()
PROVIDER_SERVICE_SCOPES_RESOLVED=0

resolve_provider_service_scopes() {
  local service user_state root_state found_any=0

  if [[ "$PROVIDER_SERVICE_SCOPES_RESOLVED" -eq 1 ]]; then
    return
  fi

  PROVIDER_USER_SERVICES=()
  PROVIDER_ROOT_SERVICES=()
  echo "==> Resolving provider-daemon service managers"

  if [[ "$DRY_RUN" == "1" ]]; then
    case "$PROVIDER_SERVICE_SCOPE" in
      user)
        PROVIDER_USER_SERVICES=("${PROVIDER_SERVICES[@]}")
        ;;
      root)
        PROVIDER_ROOT_SERVICES=("${PROVIDER_SERVICES[@]}")
        ;;
      auto)
        if [[ "$PROVIDER_SERVICES_FROM_ENV" -eq 1 ]]; then
          echo "    DRY-RUN: auto scope for explicit POLYSTORE_PROVIDER_SERVICES resolves in live mode"
          PROVIDER_USER_SERVICES=("${PROVIDER_SERVICES[@]}")
        else
          PROVIDER_USER_SERVICES=("${DEFAULT_USER_PROVIDER_SERVICES[@]}")
        fi
        ;;
    esac
    if [[ "${#PROVIDER_USER_SERVICES[@]}" -gt 0 ]]; then
      echo "    DRY-RUN user manager: ${PROVIDER_USER_SERVICES[*]}"
    fi
    if [[ "${#PROVIDER_ROOT_SERVICES[@]}" -gt 0 ]]; then
      echo "    DRY-RUN root manager: ${PROVIDER_ROOT_SERVICES[*]}"
    fi
    resolve_provider_bases "$((${#PROVIDER_USER_SERVICES[@]} + ${#PROVIDER_ROOT_SERVICES[@]}))" "${PROVIDER_USER_SERVICES[@]}" "${PROVIDER_ROOT_SERVICES[@]}"
    PROVIDER_SERVICE_SCOPES_RESOLVED=1
    return
  fi

  case "$PROVIDER_SERVICE_SCOPE" in
    user)
      for service in "${PROVIDER_SERVICES[@]}"; do
        require_provider_service_loaded user "$service"
      done
      PROVIDER_USER_SERVICES=("${PROVIDER_SERVICES[@]}")
      ;;
    root)
      for service in "${PROVIDER_SERVICES[@]}"; do
        require_provider_service_loaded root "$service"
      done
      PROVIDER_ROOT_SERVICES=("${PROVIDER_SERVICES[@]}")
      ;;
    auto)
      for service in "${PROVIDER_SERVICES[@]}"; do
        user_state="$(user_unit_load_state "$service" || true)"
        root_state="$(root_unit_load_state "$service" || true)"

        if unit_is_loaded "$user_state" && unit_is_loaded "$root_state"; then
          echo "ERROR: provider-daemon service $service exists in both user and root managers." >&2
          echo "       Set POLYSTORE_PROVIDER_SERVICE_SCOPE=user or root for this rollout." >&2
          exit 1
        fi

        if unit_is_loaded "$user_state"; then
          PROVIDER_USER_SERVICES+=("$service")
          found_any=1
          continue
        fi

        if unit_is_loaded "$root_state"; then
          PROVIDER_ROOT_SERVICES+=("$service")
          found_any=1
          continue
        fi

        if [[ "$PROVIDER_SERVICES_FROM_ENV" -eq 1 ]]; then
          echo "ERROR: provider-daemon service is not loaded in user or root systemd managers: $service" >&2
          echo "       user LoadState=$(describe_load_state "$user_state"), root LoadState=$(describe_load_state "$root_state")." >&2
          exit 1
        fi

        echo "ERROR: default provider-daemon service is not loaded in user or root systemd managers: $service" >&2
        echo "       user LoadState=$(describe_load_state "$user_state"), root LoadState=$(describe_load_state "$root_state")." >&2
        echo "       The default devnet inventory requires provider1-provider4; set POLYSTORE_PROVIDER_SERVICES explicitly for partial devnets." >&2
        exit 1
      done

      if [[ "$found_any" -ne 1 ]]; then
        echo "ERROR: no provider-daemon services were loaded in user or root systemd managers." >&2
        echo "       Set POLYSTORE_PROVIDER_SERVICES and POLYSTORE_PROVIDER_SERVICE_SCOPE for this host." >&2
        exit 1
      fi
      ;;
  esac

  if [[ "${#PROVIDER_USER_SERVICES[@]}" -gt 0 ]]; then
    echo "    user manager: ${PROVIDER_USER_SERVICES[*]}"
  fi
  if [[ "${#PROVIDER_ROOT_SERVICES[@]}" -gt 0 ]]; then
    echo "    root manager: ${PROVIDER_ROOT_SERVICES[*]}"
  fi
  resolve_provider_bases "$((${#PROVIDER_USER_SERVICES[@]} + ${#PROVIDER_ROOT_SERVICES[@]}))" "${PROVIDER_USER_SERVICES[@]}" "${PROVIDER_ROOT_SERVICES[@]}"
  PROVIDER_SERVICE_SCOPES_RESOLVED=1
}

provider_systemctl() {
  local status=0

  resolve_provider_service_scopes
  if [[ "${#PROVIDER_USER_SERVICES[@]}" -gt 0 ]]; then
    user_systemctl "$@" "${PROVIDER_USER_SERVICES[@]}" || status=$?
  fi
  if [[ "${#PROVIDER_ROOT_SERVICES[@]}" -gt 0 ]]; then
    root_systemctl "$@" "${PROVIDER_ROOT_SERVICES[@]}" || status=$?
  fi
  return "$status"
}

preflight_required_tools() {
  echo "==> Preflighting local command dependencies"
  if ! command -v curl >/dev/null; then
    echo "ERROR: curl is required for post-restart health polling before service mutation." >&2
    echo "       Install curl or run from a host image that includes it." >&2
    exit 1
  fi
  echo "    curl: $(command -v curl)"
}

preflight_root_service_control() {
  echo "==> Preflighting root service control before stopping services"
  if [[ "$IS_ROOT" -eq 1 ]]; then
    echo "    running as root; root systemd control is available"
    return
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "    DRY-RUN: would verify passwordless sudo for root systemd control"
    return
  fi

  preflight_root_systemctl_authorized stop polystore-gateway-router.service polystore-faucet.service
  preflight_root_systemctl_authorized stop polystorechaind.service
  preflight_root_systemctl_authorized start polystorechaind.service
  preflight_root_systemctl_authorized start polystore-faucet.service polystore-gateway-router.service
  if [[ "${#PROVIDER_ROOT_SERVICES[@]}" -gt 0 ]]; then
    preflight_root_systemctl_authorized stop "${PROVIDER_ROOT_SERVICES[@]}"
    preflight_root_systemctl_authorized start "${PROVIDER_ROOT_SERVICES[@]}"
  fi
}

preflight_root_systemctl_authorized() {
  if sudo -n -l systemctl "$@" >/dev/null 2>&1; then
    echo "    sudo authorization OK: systemctl $*"
    return
  fi

  echo "ERROR: passwordless sudo authorization is required before stopping provider-daemon services." >&2
  echo "       Missing authorization for: systemctl $*" >&2
  echo "       Re-run as root or configure passwordless sudo for the exact systemctl stop/start actions." >&2
  exit 1
}

preflight_root_services_loaded() {
  local service load_state

  echo "==> Preflighting hub root service units"
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "    DRY-RUN: validating loaded root services with non-mutating systemctl show: ${ROOT_SERVICES[*]}"
  fi

  for service in "${ROOT_SERVICES[@]}"; do
    load_state="$(root_unit_load_state "$service" || true)"
    if ! unit_is_loaded "$load_state"; then
      echo "ERROR: hub root service $service is not loaded in the root systemd manager." >&2
      echo "       LoadState=$(describe_load_state "$load_state"); fix the unit before stopping services." >&2
      echo "       Fix POLYSTORE root service inventory before stopping provider-daemon services." >&2
      exit 1
    fi
  done
  echo "    root services loaded: ${ROOT_SERVICES[*]}"
}

preflight_source_target_layout() {
  echo "==> Preflighting source/target layout"
  if [[ "$SKIP_BUILD" == "1" ]]; then
    echo "    build skipped; source root may equal target root only for already-staged artifacts"
    return
  fi

  if [[ "$(realpath -m "$SOURCE_ROOT")" == "$(realpath -m "$TARGET_ROOT")" ]]; then
    echo "ERROR: refusing to build with --source-root equal to --target-root." >&2
    echo "       Build from a separate checkout, or use --skip-build only after artifacts are already staged in place." >&2
    exit 1
  fi
}

sha256_if_present() {
  local path="$1"
  if [[ -f "$path" ]]; then
    sha256sum "$path"
  else
    echo "MISSING $path"
  fi
}

same_install_path() {
  local src="$1"
  local dst="$2"
  [[ "$(realpath -m "$src")" == "$(realpath -m "$dst")" ]]
}

preflight_install_destination() {
  local src="$1"
  local dst="$2"
  local dst_dir backup_subdir backup_dir write_test

  if same_install_path "$src" "$dst"; then
    return 0
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "    DRY-RUN: would verify target write access for $dst"
    return 0
  fi

  dst_dir="$(dirname "$dst")"
  backup_subdir="$(dirname "${dst#"$TARGET_ROOT"/}")"
  backup_dir="$BACKUP_DIR/$backup_subdir"

  if [[ -e "$dst" && ! -f "$dst" ]]; then
    echo "ERROR: install target exists but is not a regular file: $dst" >&2
    echo "       Fix the target path before stopping services." >&2
    exit 1
  fi

  if ! mkdir -p "$dst_dir" "$backup_dir"; then
    echo "ERROR: cannot create install/backup directories for $dst" >&2
    echo "       dst_dir=$dst_dir backup_dir=$backup_dir" >&2
    exit 1
  fi

  if [[ ! -w "$dst_dir" ]]; then
    echo "ERROR: install target directory is not writable: $dst_dir" >&2
    echo "       Fix permissions before stopping services." >&2
    exit 1
  fi

  if [[ ! -w "$backup_dir" ]]; then
    echo "ERROR: backup directory is not writable: $backup_dir" >&2
    echo "       Fix permissions before stopping services." >&2
    exit 1
  fi

  write_test="$backup_dir/.polystore-rollout-preflight-write-test"
  if ! : >"$write_test"; then
    echo "ERROR: cannot write backup preflight marker: $write_test" >&2
    echo "       Fix permissions before stopping services." >&2
    exit 1
  fi
  rm -f "$write_test"

  if [[ -e "$dst" ]]; then
    if [[ ! -r "$dst" ]]; then
      echo "ERROR: existing install target cannot be read for backup: $dst" >&2
      echo "       Fix permissions before stopping services." >&2
      exit 1
    fi
    if [[ ! -w "$dst" ]]; then
      echo "ERROR: existing install target is not writable for replacement: $dst" >&2
      echo "       Fix permissions before stopping services." >&2
      exit 1
    fi
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

  if same_install_path "$src" "$dst"; then
    if [[ "$DRY_RUN" == "1" ]]; then
      echo "    DRY-RUN: source and target are the same path; install would be skipped"
    else
      echo "    source and target are the same path; skipping install"
    fi
    return 0
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
    if [[ "$DRY_RUN" == "1" ]]; then
      echo "DRY-RUN MISSING $artifact"
    else
      echo "MISSING $artifact" >&2
    fi
  done

  if [[ "$missing" -ne 0 ]]; then
    if [[ "$DRY_RUN" == "1" && "$SKIP_BUILD" != "1" ]]; then
      echo "    DRY-RUN: missing artifacts would be produced by the build step or fail before service stop in live mode"
      return
    fi

    echo "ERROR: missing install artifacts; aborting before service stop" >&2
    if [[ "$DRY_RUN" == "1" && "$SKIP_BUILD" == "1" ]]; then
      echo "       --skip-build dry-runs require staged artifacts because no build step can produce them." >&2
    fi
    exit 1
  fi
}

preflight_install_plan() {
  local sources=(
    "$SOURCE_ROOT/polystore_core/target/release/libpolystore_core.so"
    "$SOURCE_ROOT/polystorechain/polystorechaind"
    "$SOURCE_ROOT/polystore_gateway/polystore_gateway"
    "$SOURCE_ROOT/polystore_faucet/polystore_faucet"
    "$SOURCE_ROOT/polystore_cli/target/release/polystore_cli"
    "$SOURCE_ROOT/polystorechain/trusted_setup.txt"
  )
  local destinations=(
    "$TARGET_ROOT/polystore_core/target/release/libpolystore_core.so"
    "$TARGET_ROOT/polystorechain/polystorechaind"
    "$TARGET_ROOT/polystore_gateway/polystore_gateway"
    "$TARGET_ROOT/polystore_faucet/polystore_faucet"
    "$TARGET_ROOT/polystore_cli/target/release/polystore_cli"
    "$TARGET_ROOT/polystorechain/trusted_setup.txt"
  )
  local i

  echo "==> Preflighting install plan before stopping services"
  for i in "${!sources[@]}"; do
    if same_install_path "${sources[$i]}" "${destinations[$i]}"; then
      echo "    source equals target; install will be skipped: ${destinations[$i]}"
      continue
    fi
    preflight_install_destination "${sources[$i]}" "${destinations[$i]}"
  done
}

build_artifacts() {
  if [[ "$SKIP_BUILD" == "1" ]]; then
    echo "==> Skipping builds (--skip-build)"
    return
  fi

  echo "==> Building coupled devnet artifacts"
  run_build_in_dir "$SOURCE_ROOT/polystore_core" cargo build --release
  run_build_in_dir "$SOURCE_ROOT/polystorechain" env GOFLAGS="$(goflags_with_mod)" go build -o "$SOURCE_ROOT/polystorechain/polystorechaind" ./cmd/polystorechaind
  run_build_in_dir "$SOURCE_ROOT/polystore_gateway" env GOFLAGS="$(goflags_with_mod)" go build -o "$SOURCE_ROOT/polystore_gateway/polystore_gateway" .
  run_build_in_dir "$SOURCE_ROOT/polystore_faucet" env GOFLAGS="$(goflags_with_mod)" go build -o "$SOURCE_ROOT/polystore_faucet/polystore_faucet" .
  run_build_in_dir "$SOURCE_ROOT/polystore_cli" cargo build --release
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
  echo "    provider-daemon service scope: $PROVIDER_SERVICE_SCOPE"
  echo "    root services: ${ROOT_SERVICES[*]}"
  echo "    rpc base: $RPC_BASE"
  echo "    lcd base: $LCD_BASE"
  echo "    evm base: $EVM_BASE"
  echo "    user-gateway base: $ROUTER_BASE (POLYSTORE_ROUTER_BASE legacy env alias)"
  echo "    faucet base: $FAUCET_BASE"
  if [[ "$PROVIDER_BASES_FROM_ENV" -eq 1 ]]; then
    echo "    provider-daemon bases: ${PROVIDER_BASES[*]}"
  else
    echo "    provider-daemon bases: derived from resolved provider services"
  fi
  if [[ "$RESTART_TUNNELS" == "1" ]]; then
    echo "    tunnel services: ${TUNNEL_SERVICES[*]}"
  else
    echo "    tunnel services: skipped unless --restart-tunnels is supplied"
  fi
}

print_service_status() {
  echo "==> Root service activity"
  if ! root_systemctl is-active "${ROOT_SERVICES[@]}"; then
    echo "WARNING: root service activity status probe failed after healthchecks." >&2
  fi
  if [[ "$DRY_RUN" != "1" ]]; then
    if [[ "$IS_ROOT" -eq 1 ]]; then
      systemctl --no-pager --full status "${ROOT_SERVICES[@]}" | sed -n '1,160p' || true
    else
      sudo -n systemctl --no-pager --full status "${ROOT_SERVICES[@]}" | sed -n '1,160p' || true
    fi
  fi

  echo "==> Provider service activity"
  if ! provider_systemctl is-active; then
    echo "WARNING: provider-daemon activity status probe failed after healthchecks." >&2
  fi
  if [[ "$DRY_RUN" != "1" ]]; then
    if [[ "${#PROVIDER_USER_SERVICES[@]}" -gt 0 && "$IS_ROOT" -eq 1 ]]; then
      runuser -u "$RUN_USER" -- env XDG_RUNTIME_DIR="/run/user/$RUN_UID" systemctl --user --no-pager --full status "${PROVIDER_USER_SERVICES[@]}" | sed -n '1,200p' || true
    elif [[ "${#PROVIDER_USER_SERVICES[@]}" -gt 0 ]]; then
      env XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$RUN_UID}" systemctl --user --no-pager --full status "${PROVIDER_USER_SERVICES[@]}" | sed -n '1,200p' || true
    fi
    if [[ "${#PROVIDER_ROOT_SERVICES[@]}" -gt 0 && "$IS_ROOT" -eq 1 ]]; then
      systemctl --no-pager --full status "${PROVIDER_ROOT_SERVICES[@]}" | sed -n '1,200p' || true
    elif [[ "${#PROVIDER_ROOT_SERVICES[@]}" -gt 0 ]]; then
      sudo -n systemctl --no-pager --full status "${PROVIDER_ROOT_SERVICES[@]}" | sed -n '1,200p' || true
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
preflight_source_target_layout
preflight_required_tools
build_artifacts
preflight_artifacts
preflight_install_plan
preflight_root_services_loaded
resolve_provider_service_scopes
preflight_root_service_control

echo "==> Stop order: provider-daemons -> user-gateway/faucet -> chain"
provider_systemctl stop
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
provider_systemctl start
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

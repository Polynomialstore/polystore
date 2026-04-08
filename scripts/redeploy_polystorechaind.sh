#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_DEFAULT="$(cd "$SCRIPT_DIR/.." && pwd)"

SOURCE_ROOT="$REPO_ROOT_DEFAULT"
TARGET_ROOT="/opt/nilstore"
SERVICE_NAME="polystorechaind"
ENV_FILE="/etc/nilstore/polystorechaind.env"
LCD_BASE="http://127.0.0.1:1317"
OPERATOR_ADDRESS=""

WITH_RESTART=0
VERIFY_ONLY=0
DRY_RUN=0
SKIP_BACKUP=0

NILCHAIND_BIN=""
NIL_HOME=""
LAST_BACKUP=""
SCRIPT_PATH="$SCRIPT_DIR/$SCRIPT_NAME"

usage() {
  cat <<USAGE
Usage: $SCRIPT_NAME [options]

Build and redeploy polystorechaind for a systemd-managed hub node.

By default this script:
1) builds polystorechaind from SOURCE_ROOT/polystorechain,
2) backs up and installs the binary into NILCHAIND_BIN,
3) prints the sudo restart command for systemd,
4) prints a verify-only command for post-restart checks.

Options:
  --source-root <path>      Source checkout root (default: $REPO_ROOT_DEFAULT)
  --target-root <path>      Target runtime root (default: /opt/nilstore)
  --service <name>          systemd service name (default: polystorechaind)
  --env-file <path>         EnvironmentFile path (default: /etc/nilstore/polystorechaind.env)
  --lcd-base <url>          LCD base for verification (default: http://127.0.0.1:1317)
  --operator-address <addr> Optional operator address to verify pending-by-operator endpoint
  --with-restart            Attempt restart automatically (uses sudo unless root)
  --verify-only             Skip build/install and run only verification checks
  --dry-run                 Print intended actions without executing
  --skip-backup             Do not create backup before install (not recommended)
  -h, --help                Show this help

Environment knobs:
  NILCHAIN_BUILD_GOFLAGS    GOFLAGS override for build (default appends -mod=mod)
  NIL_CORE_LIB_DIR          Override path containing libpolystore_core.so / libpolystore_core.dylib
USAGE
}

log() {
  printf '[%s] %s\n' "$SCRIPT_NAME" "$*"
}

warn() {
  printf '[%s] WARN: %s\n' "$SCRIPT_NAME" "$*" >&2
}

die() {
  printf '[%s] ERROR: %s\n' "$SCRIPT_NAME" "$*" >&2
  exit 1
}

print_cmd() {
  printf '+ '
  printf '%q ' "$@"
  printf '\n'
}

run_cmd() {
  print_cmd "$@"
  if [ "$DRY_RUN" -eq 0 ]; then
    "$@"
  fi
}

run_in_dir() {
  local dir="$1"
  shift
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '+ (cd %q && ' "$dir"
    printf '%q ' "$@"
    printf ')\n'
    return 0
  fi
  (
    cd "$dir"
    "$@"
  )
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --source-root)
        SOURCE_ROOT="$2"
        shift 2
        ;;
      --source-root=*)
        SOURCE_ROOT="${1#*=}"
        shift
        ;;
      --target-root)
        TARGET_ROOT="$2"
        shift 2
        ;;
      --target-root=*)
        TARGET_ROOT="${1#*=}"
        shift
        ;;
      --service)
        SERVICE_NAME="$2"
        shift 2
        ;;
      --service=*)
        SERVICE_NAME="${1#*=}"
        shift
        ;;
      --env-file)
        ENV_FILE="$2"
        shift 2
        ;;
      --env-file=*)
        ENV_FILE="${1#*=}"
        shift
        ;;
      --lcd-base)
        LCD_BASE="$2"
        shift 2
        ;;
      --lcd-base=*)
        LCD_BASE="${1#*=}"
        shift
        ;;
      --operator-address)
        OPERATOR_ADDRESS="$2"
        shift 2
        ;;
      --operator-address=*)
        OPERATOR_ADDRESS="${1#*=}"
        shift
        ;;
      --with-restart)
        WITH_RESTART=1
        shift
        ;;
      --verify-only)
        VERIFY_ONLY=1
        shift
        ;;
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      --skip-backup)
        SKIP_BACKUP=1
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "unknown argument: $1"
        ;;
    esac
  done
}

load_env_file() {
  if [ -f "$ENV_FILE" ]; then
    # shellcheck disable=SC1090
    . "$ENV_FILE"
  else
    warn "env file not found at $ENV_FILE (continuing with defaults)"
  fi

  NILCHAIND_BIN="${NILCHAIND_BIN:-$TARGET_ROOT/polystorechain/polystorechaind}"
  NIL_HOME="${NIL_HOME:-/var/lib/nilstore/polystorechaind}"
}

require_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || die "required command not found: $cmd"
}

preflight_common() {
  require_cmd systemctl
}

preflight_build() {
  require_cmd go
  [ -d "$SOURCE_ROOT" ] || die "source root does not exist: $SOURCE_ROOT"
  [ -d "$SOURCE_ROOT/polystorechain" ] || die "polystorechain dir not found under source root: $SOURCE_ROOT"
  [ -f "$SOURCE_ROOT/polystorechain/go.mod" ] || die "polystorechain/go.mod missing under source root: $SOURCE_ROOT"

  local target_dir
  target_dir="$(dirname "$NILCHAIND_BIN")"
  [ -d "$target_dir" ] || die "target bin directory missing: $target_dir"

  if ! systemctl list-unit-files --no-legend "${SERVICE_NAME}.service" >/dev/null 2>&1; then
    warn "systemd unit ${SERVICE_NAME}.service not found in unit-files list"
  fi
}

find_polystore_core_lib_dir() {
  local candidate
  for candidate in \
    "${NIL_CORE_LIB_DIR:-}" \
    "$TARGET_ROOT/polystore_core/target/release" \
    "$SOURCE_ROOT/polystore_core/target/release"
  do
    [ -n "$candidate" ] || continue
    if [ -f "$candidate/libpolystore_core.so" ] || [ -f "$candidate/libpolystore_core.dylib" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

ensure_polystore_core_runtime() {
  local lib_dir
  lib_dir="$(find_polystore_core_lib_dir || true)"

  if [ -z "$lib_dir" ]; then
    [ -d "$SOURCE_ROOT/polystore_core" ] || die "polystore_core not found under source root and no runtime lib discovered"
    require_cmd cargo
    log "libpolystore_core runtime not found; building polystore_core in source checkout"
    run_in_dir "$SOURCE_ROOT/polystore_core" cargo build --release
    lib_dir="$SOURCE_ROOT/polystore_core/target/release"
  fi

  if [ ! -f "$lib_dir/libpolystore_core.so" ] && [ ! -f "$lib_dir/libpolystore_core.dylib" ]; then
    die "polystore_core runtime library not found in $lib_dir after build"
  fi

  export LD_LIBRARY_PATH="$lib_dir${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  export DYLD_LIBRARY_PATH="$lib_dir${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"

  if [ -n "${CGO_LDFLAGS:-}" ]; then
    case " $CGO_LDFLAGS " in
      *" -L$lib_dir "*) ;;
      *) export CGO_LDFLAGS="-L$lib_dir $CGO_LDFLAGS" ;;
    esac
  else
    export CGO_LDFLAGS="-L$lib_dir"
  fi

  log "using polystore_core runtime from $lib_dir"
}

build_polystorechaind() {
  local build_goflags
  build_goflags="${NILCHAIN_BUILD_GOFLAGS:-${GOFLAGS:-}}"
  case " $build_goflags " in
    *" -mod="*) ;;
    *) build_goflags="${build_goflags} -mod=mod" ;;
  esac
  build_goflags="$(printf '%s' "$build_goflags" | xargs)"

  log "building polystorechaind from $SOURCE_ROOT/polystorechain"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '+ (cd %q && GOFLAGS=%q go build -o %q ./cmd/polystorechaind)\n' \
      "$SOURCE_ROOT/polystorechain" "$build_goflags" "$SOURCE_ROOT/polystorechain/polystorechaind"
    return 0
  fi

  (
    cd "$SOURCE_ROOT/polystorechain"
    GOFLAGS="$build_goflags" go build -o "$SOURCE_ROOT/polystorechain/polystorechaind" ./cmd/polystorechaind
  )
}

install_polystorechaind() {
  local source_bin target_bin target_dir timestamp
  source_bin="$SOURCE_ROOT/polystorechain/polystorechaind"
  target_bin="$NILCHAIND_BIN"
  target_dir="$(dirname "$target_bin")"

  [ -f "$source_bin" ] || die "built source binary not found: $source_bin"

  if [ ! -e "$target_bin" ] && [ ! -w "$target_dir" ]; then
    warn "target directory is not writable: $target_dir"
    echo "Run these commands:" >&2
    echo "  sudo install -m 755 '$source_bin' '$target_bin'" >&2
    echo "  sudo systemctl restart '$SERVICE_NAME' && sudo systemctl status --no-pager '$SERVICE_NAME'" >&2
    exit 2
  fi

  if [ -e "$target_bin" ] && [ ! -w "$target_bin" ]; then
    warn "target binary is not writable: $target_bin"
    echo "Run these commands:" >&2
    echo "  sudo install -m 755 '$source_bin' '$target_bin'" >&2
    echo "  sudo systemctl restart '$SERVICE_NAME' && sudo systemctl status --no-pager '$SERVICE_NAME'" >&2
    exit 2
  fi

  if [ "$SKIP_BACKUP" -eq 0 ] && [ -e "$target_bin" ]; then
    timestamp="$(date +%Y%m%d-%H%M%S)"
    LAST_BACKUP="${target_bin}.bak.${timestamp}"
    run_cmd cp "$target_bin" "$LAST_BACKUP"
    log "backup created at $LAST_BACKUP"
  fi

  run_cmd install -m 755 "$source_bin" "$target_bin"
  log "installed new binary to $target_bin"

  if [ "$DRY_RUN" -eq 0 ]; then
    local line count
    sha256sum "$source_bin" "$target_bin" | sed 's/^/[sha256] /'
    count=0
    while IFS= read -r line; do
      printf '[build-info] %s\n' "$line"
      count=$((count + 1))
      if [ "$count" -ge 20 ]; then
        break
      fi
    done < <(go version -m "$target_bin")
  fi
}

restart_or_handoff() {
  if [ "$WITH_RESTART" -eq 1 ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      if [ "$(id -u)" -eq 0 ]; then
        print_cmd systemctl restart "$SERVICE_NAME"
        print_cmd systemctl status --no-pager "$SERVICE_NAME"
      else
        print_cmd sudo systemctl restart "$SERVICE_NAME"
        print_cmd sudo systemctl status --no-pager "$SERVICE_NAME"
      fi
      return 0
    fi

    if [ "$(id -u)" -eq 0 ]; then
      systemctl restart "$SERVICE_NAME"
      systemctl status --no-pager "$SERVICE_NAME"
    else
      sudo systemctl restart "$SERVICE_NAME"
      sudo systemctl status --no-pager "$SERVICE_NAME"
    fi
    return 0
  fi

  log "restart required to load the new binary"
  echo "Run this command now:" >&2
  echo "  sudo systemctl restart '$SERVICE_NAME' && sudo systemctl status --no-pager '$SERVICE_NAME'" >&2
  echo >&2
  echo "Then verify with:" >&2
  printf '  %q --verify-only --service %q --env-file %q --lcd-base %q' \
    "$SCRIPT_PATH" "$SERVICE_NAME" "$ENV_FILE" "$LCD_BASE" >&2
  if [ -n "$OPERATOR_ADDRESS" ]; then
    printf ' --operator-address %q' "$OPERATOR_ADDRESS" >&2
  fi
  printf '\n' >&2
}

fetch_height() {
  local endpoint="$LCD_BASE/cosmos/base/tendermint/v1beta1/blocks/latest"
  curl -fsS --max-time 8 "$endpoint" | jq -r '.block.header.height // .sdk_block.header.height // empty'
}

verify_chain() {
  require_cmd curl
  require_cmd jq
  log "running verify-only checks"

  if [ "$DRY_RUN" -eq 1 ]; then
    print_cmd systemctl is-active --quiet "$SERVICE_NAME"
    print_cmd curl -fsS --max-time 8 "$LCD_BASE/cosmos/base/tendermint/v1beta1/syncing"
    print_cmd curl -fsS --max-time 8 "$LCD_BASE/cosmos/base/tendermint/v1beta1/blocks/latest"
    if [ -n "$OPERATOR_ADDRESS" ]; then
      print_cmd curl -fsS --max-time 8 "$LCD_BASE/polystorechain/polystorechain/v1/provider-pairings/pending-by-operator/$OPERATOR_ADDRESS"
    fi
    return 0
  fi

  if systemctl is-active --quiet "$SERVICE_NAME"; then
    log "systemd service is active: $SERVICE_NAME"
  else
    die "systemd service is not active: $SERVICE_NAME"
  fi

  local syncing_json syncing_value
  syncing_json="$(curl -fsS --max-time 8 "$LCD_BASE/cosmos/base/tendermint/v1beta1/syncing")"
  syncing_value="$(printf '%s' "$syncing_json" | jq -r '
    if has("syncing") then
      .syncing
    elif (.result | type == "object" and (.result | has("syncing"))) then
      .result.syncing
    else
      empty
    end
  ')"
  log "syncing endpoint returned: ${syncing_value:-unknown}"

  local h1 h2
  h1="$(fetch_height)"
  [ -n "$h1" ] || die "unable to read latest height from LCD"
  sleep 6
  h2="$(fetch_height)"
  [ -n "$h2" ] || die "unable to read latest height from LCD after delay"

  log "height progression: $h1 -> $h2"
  if [ "$h2" -lt "$h1" ]; then
    die "latest height moved backwards ($h1 -> $h2)"
  fi
  if [ "$h2" -eq "$h1" ]; then
    warn "latest height did not advance during 6s window; check proposer/liveness"
  fi

  if [ -n "$OPERATOR_ADDRESS" ]; then
    local pending_endpoint
    pending_endpoint="$LCD_BASE/polystorechain/polystorechain/v1/provider-pairings/pending-by-operator/$OPERATOR_ADDRESS"
    curl -fsS --max-time 8 "$pending_endpoint" | jq . >/dev/null
    log "pending-by-operator endpoint reachable for operator $OPERATOR_ADDRESS"
  fi

  log "verification complete"
}

main() {
  parse_args "$@"
  load_env_file
  preflight_common

  if [ "$VERIFY_ONLY" -eq 1 ]; then
    verify_chain
    return 0
  fi

  preflight_build
  ensure_polystore_core_runtime
  build_polystorechaind
  install_polystorechaind
  restart_or_handoff
}

main "$@"

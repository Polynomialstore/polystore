#!/usr/bin/env bash
#
# One-time handoff for a local trusted devnet whose hub services were installed
# as root systemd units. After this script succeeds, the chain, faucet, and
# user-gateway run as user systemd services so normal deploys can restart them
# without sudo.

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RUN_USER="${POLYSTORE_RUN_USER:-${SUDO_USER:-}}"
RUN_GROUP=""
TARGET_ROOT="${POLYSTORE_TARGET_ROOT:-/opt/polystore}"
CONFIG_ROOT="${POLYSTORE_CONFIG_ROOT:-/etc/polystore}"
STATE_ROOTS=()
HUB_SERVICES=(polystorechaind.service polystore-faucet.service polystore-gateway-router.service)
DISABLE_ROOT=1
MASK_ROOT=1
ENABLE_USER=1
START_USER=1
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage:
  sudo -E scripts/devnet_rootless_handoff.sh [flags]

Purpose:
  Move the local devnet hub from root systemd units to user systemd units.
  This is intended as a one-time root action. Afterward, recurring deploys can
  run scripts/update_devnet_stack.sh with POLYSTORE_HUB_SERVICE_SCOPE=user
  (or auto, when root units are masked) and should not need root to restart hub
  services or overwrite installed devnet artifacts.

Flags:
  --run-user USER        User that should own and run the devnet.
                         Default: POLYSTORE_RUN_USER, then SUDO_USER.
  --target-root DIR      Installed artifact tree to chown (default: /opt/polystore).
  --config-root DIR      EnvironmentFile directory to chown (default: /etc/polystore).
  --state-root DIR       State root to chown. Can be repeated.
                         Defaults: /var/lib/nilstore and /var/lib/polystore.
  --service UNIT         Hub service to move. Can be repeated.
                         Defaults: polystorechaind, polystore-faucet,
                         polystore-gateway-router.
  --no-disable-root      Leave root units enabled.
  --no-mask-root         Do not mask root units after disabling them.
  --no-enable-user       Install user units but do not enable them.
  --no-start             Do not start user units after installation.
  --dry-run              Print commands without mutating services or files.
  -h, --help             Show this help.

Notes:
  - Run this from the repo whose ops/systemd templates you want installed.
  - Existing files under /etc/polystore are preserved and made readable by
    RUN_USER. Missing env files are copied from ops/systemd/env/*.env, but the
    script refuses to start services while template placeholders remain.
  - Root units are masked by default so a future root systemctl start cannot
    silently recreate root-owned runtime state. Use --no-mask-root if you need
    a reversible transition without masking.
EOF
}

log() {
  printf '[%s] %s\n' "$SCRIPT_NAME" "$*"
}

die() {
  printf '[%s] ERROR: %s\n' "$SCRIPT_NAME" "$*" >&2
  exit 1
}

print_cmd() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
}

run_cmd() {
  print_cmd "$@"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    "$@"
  fi
}

run_user_cmd() {
  local runtime_dir="/run/user/$RUN_UID"
  print_cmd runuser -u "$RUN_USER" -- env "XDG_RUNTIME_DIR=$runtime_dir" "DBUS_SESSION_BUS_ADDRESS=unix:path=$runtime_dir/bus" "$@"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    runuser -u "$RUN_USER" -- env "XDG_RUNTIME_DIR=$runtime_dir" "DBUS_SESSION_BUS_ADDRESS=unix:path=$runtime_dir/bus" "$@"
  fi
}

parse_args() {
  local custom_state_roots=0
  local custom_services=0

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --run-user)
        [[ $# -ge 2 ]] || die "--run-user requires a value"
        RUN_USER="$2"
        shift 2
        ;;
      --run-user=*)
        RUN_USER="${1#*=}"
        shift
        ;;
      --target-root)
        [[ $# -ge 2 ]] || die "--target-root requires a value"
        TARGET_ROOT="$2"
        shift 2
        ;;
      --target-root=*)
        TARGET_ROOT="${1#*=}"
        shift
        ;;
      --config-root)
        [[ $# -ge 2 ]] || die "--config-root requires a value"
        CONFIG_ROOT="$2"
        shift 2
        ;;
      --config-root=*)
        CONFIG_ROOT="${1#*=}"
        shift
        ;;
      --state-root)
        [[ $# -ge 2 ]] || die "--state-root requires a value"
        if [[ "$custom_state_roots" -eq 0 ]]; then
          STATE_ROOTS=()
          custom_state_roots=1
        fi
        STATE_ROOTS+=("$2")
        shift 2
        ;;
      --state-root=*)
        if [[ "$custom_state_roots" -eq 0 ]]; then
          STATE_ROOTS=()
          custom_state_roots=1
        fi
        STATE_ROOTS+=("${1#*=}")
        shift
        ;;
      --service)
        [[ $# -ge 2 ]] || die "--service requires a value"
        if [[ "$custom_services" -eq 0 ]]; then
          HUB_SERVICES=()
          custom_services=1
        fi
        HUB_SERVICES+=("$2")
        shift 2
        ;;
      --service=*)
        if [[ "$custom_services" -eq 0 ]]; then
          HUB_SERVICES=()
          custom_services=1
        fi
        HUB_SERVICES+=("${1#*=}")
        shift
        ;;
      --no-disable-root)
        DISABLE_ROOT=0
        MASK_ROOT=0
        shift
        ;;
      --no-mask-root)
        MASK_ROOT=0
        shift
        ;;
      --no-enable-user)
        ENABLE_USER=0
        shift
        ;;
      --no-start)
        START_USER=0
        shift
        ;;
      --dry-run)
        DRY_RUN=1
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

  if [[ "${#STATE_ROOTS[@]}" -eq 0 ]]; then
    STATE_ROOTS=(/var/lib/nilstore /var/lib/polystore)
  fi
}

require_root_for_live_run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    return
  fi
  if [[ "$(id -u)" -ne 0 ]]; then
    die "live handoff must run as root; use sudo -E scripts/devnet_rootless_handoff.sh"
  fi
}

resolve_run_user() {
  [[ -n "$RUN_USER" ]] || die "could not infer run user; pass --run-user USER"
  if ! id "$RUN_USER" >/dev/null 2>&1; then
    die "run user does not exist: $RUN_USER"
  fi
  RUN_UID="$(id -u "$RUN_USER")"
  RUN_GID="$(id -g "$RUN_USER")"
  RUN_GROUP="$(id -gn "$RUN_USER")"
  RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
  [[ -n "$RUN_HOME" ]] || die "could not determine home directory for $RUN_USER"
  USER_SYSTEMD_DIR="$RUN_HOME/.config/systemd/user"
}

ensure_user_manager() {
  log "Enabling lingering and checking the user systemd manager"
  run_cmd loginctl enable-linger "$RUN_USER"
  run_cmd systemctl start "user@$RUN_UID.service"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    return
  fi

  if [[ ! -S "/run/user/$RUN_UID/bus" ]]; then
    die "user systemd bus is not available at /run/user/$RUN_UID/bus; log in as $RUN_USER once and rerun"
  fi
}

root_unit_exists() {
  local unit="$1"
  local load_state
  load_state="$(systemctl show "$unit" --property=LoadState --value 2>/dev/null || true)"
  [[ "$load_state" == "loaded" || "$load_state" == "masked" ]]
}

stop_root_units() {
  local unit

  if [[ "$DISABLE_ROOT" -ne 1 ]]; then
    log "Skipping root unit disable/stop because --no-disable-root was supplied"
    return
  fi

  log "Stopping root hub units before starting user hub units"
  for unit in "${HUB_SERVICES[@]}"; do
    if [[ "$DRY_RUN" -eq 0 ]] && ! root_unit_exists "$unit"; then
      log "Root unit not loaded or masked, skipping: $unit"
      continue
    fi
    run_cmd systemctl stop "$unit"
  done
}

disable_and_mask_root_units() {
  local unit

  if [[ "$DISABLE_ROOT" -ne 1 ]]; then
    return
  fi

  log "Disabling root hub units after user hub services are installed"
  for unit in "${HUB_SERVICES[@]}"; do
    if [[ "$DRY_RUN" -eq 0 ]] && ! root_unit_exists "$unit"; then
      log "Root unit not loaded or masked, skipping: $unit"
      continue
    fi
    run_cmd systemctl disable "$unit"
    if [[ "$MASK_ROOT" -eq 1 ]]; then
      run_cmd systemctl mask --force "$unit"
    fi
  done
}

copy_env_template_if_missing() {
  local service="$1"
  local env_name="${service%.service}.env"
  local src="$REPO_ROOT/ops/systemd/env/$env_name"
  local dst="$CONFIG_ROOT/$env_name"

  if [[ -e "$dst" ]]; then
    return
  fi

  [[ -f "$src" ]] || die "missing env template for $service: $src"
  run_cmd install -m 0640 -o "$RUN_USER" -g "$RUN_GROUP" "$src" "$dst"
}

chown_runtime_paths() {
  local path

  log "Making devnet install/config/state paths user-owned"
  run_cmd install -d -m 0755 -o "$RUN_USER" -g "$RUN_GROUP" "$TARGET_ROOT"
  run_cmd install -d -m 0750 -o "$RUN_USER" -g "$RUN_GROUP" "$CONFIG_ROOT"
  for path in "${STATE_ROOTS[@]}"; do
    run_cmd install -d -m 0750 -o "$RUN_USER" -g "$RUN_GROUP" "$path"
  done

  run_cmd chown -R "$RUN_USER:$RUN_GROUP" "$TARGET_ROOT"
  run_cmd chown -R "$RUN_USER:$RUN_GROUP" "$CONFIG_ROOT"
  for path in "${STATE_ROOTS[@]}"; do
    run_cmd chown -R "$RUN_USER:$RUN_GROUP" "$path"
  done
}

install_user_units() {
  local unit src dst

  log "Installing hub units into the user systemd manager"
  run_cmd install -d -m 0755 -o "$RUN_USER" -g "$RUN_GROUP" "$USER_SYSTEMD_DIR"
  for unit in "${HUB_SERVICES[@]}"; do
    src="$REPO_ROOT/ops/systemd/$unit"
    dst="$USER_SYSTEMD_DIR/$unit"
    [[ -f "$src" ]] || die "missing systemd template: $src"
    copy_env_template_if_missing "$unit"
    if [[ "$DRY_RUN" -eq 1 ]]; then
      printf '+ sed %q %q > %q\n' 's/WantedBy=multi-user.target/WantedBy=default.target/' "$src" "$dst"
    else
      sed 's/WantedBy=multi-user.target/WantedBy=default.target/' "$src" > "$dst"
      chown "$RUN_USER:$RUN_GROUP" "$dst"
      chmod 0644 "$dst"
    fi
  done
  run_user_cmd systemctl --user daemon-reload
}

env_files_ready_for_start() {
  local unit env_file status=0

  if [[ "$START_USER" -ne 1 ]]; then
    return 0
  fi

  log "Checking environment files before starting user services"
  for unit in "${HUB_SERVICES[@]}"; do
    env_file="$CONFIG_ROOT/${unit%.service}.env"
    if [[ ! -f "$env_file" ]]; then
      printf '[%s] ERROR: missing env file: %s\n' "$SCRIPT_NAME" "$env_file" >&2
      status=1
      continue
    fi
    if grep -q '<set-me>' "$env_file"; then
      printf '[%s] ERROR: env file still contains <set-me>: %s\n' "$SCRIPT_NAME" "$env_file" >&2
      status=1
    fi
  done

  if [[ "$status" -ne 0 ]]; then
    die "refusing to start services with incomplete env files; edit them or rerun with --no-start"
  fi
}

service_selected() {
  local target="$1"
  local unit
  for unit in "${HUB_SERVICES[@]}"; do
    if [[ "$unit" == "$target" ]]; then
      return 0
    fi
  done
  return 1
}

enable_and_start_user_units() {
  if [[ "$ENABLE_USER" -eq 1 ]]; then
    log "Enabling user hub services"
    run_user_cmd systemctl --user enable "${HUB_SERVICES[@]}"
  fi

  if [[ "$START_USER" -eq 1 ]]; then
    log "Starting user hub services"
    if service_selected polystorechaind.service; then
      run_user_cmd systemctl --user start polystorechaind.service
    fi
    if service_selected polystore-faucet.service; then
      run_user_cmd systemctl --user start polystore-faucet.service
    fi
    if service_selected polystore-gateway-router.service; then
      run_user_cmd systemctl --user start polystore-gateway-router.service
    fi
    run_user_cmd systemctl --user --no-pager --full status "${HUB_SERVICES[@]}"
  fi
}

print_followup() {
  cat <<EOF

Rootless devnet handoff complete.

Future deploys can use:

  POLYSTORE_HUB_SERVICE_SCOPE=user scripts/update_devnet_stack.sh

If root units were masked, the rollout script's auto mode will also resolve the
hub services from the user manager:

  scripts/update_devnet_stack.sh --dry-run --skip-build

Useful checks:

  systemctl --user status ${HUB_SERVICES[*]}
  systemctl --user restart polystorechaind.service
  journalctl --user -u polystorechaind.service -f

EOF
}

parse_args "$@"
require_root_for_live_run
resolve_run_user

log "Repo root: $REPO_ROOT"
log "Run user: $RUN_USER uid=$RUN_UID gid=$RUN_GID"
log "Target root: $TARGET_ROOT"
log "Config root: $CONFIG_ROOT"
log "State roots: ${STATE_ROOTS[*]}"
log "Hub services: ${HUB_SERVICES[*]}"

ensure_user_manager
chown_runtime_paths
install_user_units
env_files_ready_for_start
stop_root_units
enable_and_start_user_units
disable_and_mask_root_units
print_followup

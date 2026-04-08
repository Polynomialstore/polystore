#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK_SCRIPT="$ROOT_DIR/scripts/run_devnet_alpha_multi_sp.sh"
LOG_DIR="$ROOT_DIR/_artifacts/local_stack_gui"
PID_DIR="$LOG_DIR/pids"
GUI_LOG="$LOG_DIR/gateway_gui.log"
GUI_PID_FILE="$PID_DIR/gateway_gui.pid"

PROVIDER_COUNT="${PROVIDER_COUNT:-3}"
START_WEB="${START_WEB:-1}"
START_GUI="${START_GUI:-1}"
GUI_CMD="${GUI_CMD:-npm run tauri dev}"
NIL_LOCAL_IMPORT_ENABLED="${NIL_LOCAL_IMPORT_ENABLED:-1}"
NIL_LOCAL_IMPORT_ALLOW_ABS="${NIL_LOCAL_IMPORT_ALLOW_ABS:-1}"

mkdir -p "$LOG_DIR" "$PID_DIR"

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/local_stack_gui.sh start
  ./scripts/local_stack_gui.sh stop
  ./scripts/local_stack_gui.sh restart
  ./scripts/local_stack_gui.sh status
  ./scripts/local_stack_gui.sh logs

Env overrides:
  PROVIDER_COUNT=12           number of providers
  START_WEB=1                 start polystore-website
  START_GUI=1                 start Tauri GUI (default on)
  GUI_CMD="npm run tauri dev" command to launch GUI
  NIL_LOCAL_IMPORT_ENABLED=1  allow local import in gateway
  NIL_LOCAL_IMPORT_ALLOW_ABS=1 allow absolute paths
USAGE
}

is_running() {
  local pid="$1"
  if [ -z "$pid" ]; then
    return 1
  fi
  if kill -0 "$pid" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

start_gui() {
  if [ "$START_GUI" = "0" ]; then
    echo "GUI disabled (START_GUI=0)"
    return 0
  fi

  if [ -f "$GUI_PID_FILE" ]; then
    local existing_pid
    existing_pid="$(cat "$GUI_PID_FILE" 2>/dev/null || true)"
    if is_running "$existing_pid"; then
      echo "GUI already running (pid $existing_pid)"
      return 0
    fi
  fi

  echo "Starting NilGateway GUI..."
  pushd "$ROOT_DIR/polystore_gateway_gui" >/dev/null
  if [ ! -d node_modules ]; then
    npm install
  fi
  nohup bash -lc "$GUI_CMD" >"$GUI_LOG" 2>&1 &
  local pid=$!
  popd >/dev/null

  echo "$pid" >"$GUI_PID_FILE"
  echo "GUI started (pid $pid). Logs: $GUI_LOG"
}

stop_gui() {
  if [ ! -f "$GUI_PID_FILE" ]; then
    echo "GUI not running (no pid file)"
    return 0
  fi

  local pid
  pid="$(cat "$GUI_PID_FILE" 2>/dev/null || true)"
  if is_running "$pid"; then
    echo "Stopping GUI (pid $pid)..."
    kill "$pid" || true
    sleep 1
    if is_running "$pid"; then
      kill -9 "$pid" || true
    fi
  fi
  rm -f "$GUI_PID_FILE"
}

start_stack() {
  echo "Starting devnet stack..."
  NIL_LOCAL_IMPORT_ENABLED="$NIL_LOCAL_IMPORT_ENABLED" \
  NIL_LOCAL_IMPORT_ALLOW_ABS="$NIL_LOCAL_IMPORT_ALLOW_ABS" \
  PROVIDER_COUNT="$PROVIDER_COUNT" \
  START_WEB="$START_WEB" \
  "$STACK_SCRIPT" start
}

stop_stack() {
  echo "Stopping devnet stack..."
  "$STACK_SCRIPT" stop
}

status() {
  local stack_pid_dir="$ROOT_DIR/_artifacts/devnet_alpha_multi_sp/pids"
  echo "Stack:"
  if [ -d "$stack_pid_dir" ]; then
    for svc in polystorechaind faucet router website; do
      local pid_file="$stack_pid_dir/$svc.pid"
      if [ -f "$pid_file" ]; then
        local pid
        pid="$(cat "$pid_file" 2>/dev/null || true)"
        if is_running "$pid"; then
          echo "  $svc: running (pid $pid)"
        else
          echo "  $svc: stale pid ($pid)"
        fi
      fi
    done

    local i
    for i in $(seq 1 "$PROVIDER_COUNT"); do
      local pid_file="$stack_pid_dir/provider$i.pid"
      if [ -f "$pid_file" ]; then
        local pid
        pid="$(cat "$pid_file" 2>/dev/null || true)"
        if is_running "$pid"; then
          echo "  provider$i: running (pid $pid)"
        else
          echo "  provider$i: stale pid ($pid)"
        fi
      fi
    done
  else
    echo "  no stack pid directory found"
  fi

  echo "GUI:"
  if [ -f "$GUI_PID_FILE" ]; then
    local pid
    pid="$(cat "$GUI_PID_FILE" 2>/dev/null || true)"
    if is_running "$pid"; then
      echo "  running (pid $pid)"
      return 0
    fi
  fi
  echo "  stopped"
}

logs() {
  echo "GUI log: $GUI_LOG"
  if [ -f "$GUI_LOG" ]; then
    tail -n 200 "$GUI_LOG"
  else
    echo "No GUI logs yet."
  fi
}

case "${1:-}" in
  start)
    start_stack
    start_gui
    ;;
  stop)
    stop_gui
    stop_stack
    ;;
  restart)
    stop_gui
    stop_stack
    start_stack
    start_gui
    ;;
  status)
    status
    ;;
  logs)
    logs
    ;;
  *)
    usage
    exit 1
    ;;
esac

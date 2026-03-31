#!/usr/bin/env bash
set -euo pipefail

# provider-daemon launcher for the shared NilStore testnet/devnet.
#
# Usage:
#   PROVIDER_KEY=provider1 ./scripts/run_devnet_provider.sh init
#   PROVIDER_KEY=provider1 PAIRING_ID=<pairing-id> ./scripts/run_devnet_provider.sh bootstrap
#   PROVIDER_KEY=provider1 PROVIDER_ENDPOINT="/ip4/<ip>/tcp/8091/http" ./scripts/run_devnet_provider.sh register
#   PROVIDER_KEY=provider1 PROVIDER_LISTEN=":8091" ./scripts/run_devnet_provider.sh start
#   PROVIDER_KEY=provider1 ./scripts/run_devnet_provider.sh print-config
#   PROVIDER_KEY=provider1 ./scripts/run_devnet_provider.sh doctor
#   PROVIDER_KEY=provider1 ./scripts/run_devnet_provider.sh verify
#   PROVIDER_KEY=provider1 ./scripts/run_devnet_provider.sh bootstrap
#   PROVIDER_KEY=provider1 ./scripts/run_devnet_provider.sh stop

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Load canonical public testnet defaults unless the operator has explicitly overridden them.
# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/load_testnet_public_env.sh"

ACTION="${1:-start}"

PROVIDER_KEY="${PROVIDER_KEY:-}"
if [ -z "$PROVIDER_KEY" ]; then
  echo "ERROR: PROVIDER_KEY is required (e.g. PROVIDER_KEY=provider1)" >&2
  exit 1
fi

PAIRING_ID="${PAIRING_ID:-${NIL_PROVIDER_PAIRING_ID:-}}"
NETWORK_PROFILE="${NILSTORE_NETWORK_PROFILE:-nilstore-public-testnet}"
CHAIN_ID="${CHAIN_ID:-${NIL_CHAIN_ID:-${NILSTORE_TESTNET_CHAIN_ID:-20260211}}}"
LCD_BASE="${HUB_LCD:-${NIL_LCD_BASE:-${NILSTORE_TESTNET_LCD_BASE:-https://lcd.nilstore.org}}}"
NODE_ADDR="${HUB_NODE:-${NIL_NODE:-${NILSTORE_TESTNET_NODE:-https://rpc.nilstore.org}}}"
GAS_PRICES="${NIL_GAS_PRICES:-${NILSTORE_TESTNET_GAS_PRICES:-0.001aatom}}"

NILCHAIND_BIN="${NILCHAIND_BIN:-$ROOT_DIR/nilchain/nilchaind}"
NIL_CLI_BIN="${NIL_CLI_BIN:-$ROOT_DIR/nil_cli/target/release/nil_cli}"
TRUSTED_SETUP="${NIL_TRUSTED_SETUP:-$ROOT_DIR/nilchain/trusted_setup.txt}"

PROVIDER_LISTEN="${PROVIDER_LISTEN:-${NIL_LISTEN_ADDR:-:8091}}"
PROVIDER_CAPABILITIES="${PROVIDER_CAPABILITIES:-General}"
PROVIDER_TOTAL_STORAGE="${PROVIDER_TOTAL_STORAGE:-1099511627776}" # 1 TiB default
PROVIDER_ENDPOINTS_RAW="${PROVIDER_ENDPOINTS:-${PROVIDER_ENDPOINT:-}}"

HOME_DIR="${NIL_HOME:-$ROOT_DIR/_artifacts/devnet_provider/$PROVIDER_KEY/nilchain_home}"
UPLOAD_DIR="${NIL_UPLOAD_DIR:-$ROOT_DIR/_artifacts/devnet_provider/$PROVIDER_KEY/uploads}"
LOG_DIR="$ROOT_DIR/_artifacts/devnet_provider/$PROVIDER_KEY"
PID_DIR="$LOG_DIR/pids"

GO_BIN="${GO_BIN:-$(command -v go)}"
NIL_CORE_LIB_DIR="${NIL_CORE_LIB_DIR:-}"

mkdir -p "$LOG_DIR" "$PID_DIR"

json_escape() {
  local value="${1-}"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '%s' "$value"
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

provider_pid_file() {
  echo "$PID_DIR/provider.pid"
}

provider_running() {
  local pid_file
  pid_file="$(provider_pid_file)"
  if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    return 0
  fi
  return 1
}

provider_local_base_url() {
  case "$PROVIDER_LISTEN" in
    http://*|https://*)
      printf '%s' "${PROVIDER_LISTEN%/}"
      ;;
    :*)
      printf 'http://127.0.0.1%s' "$PROVIDER_LISTEN"
      ;;
    0.0.0.0:*)
      printf 'http://127.0.0.1:%s' "${PROVIDER_LISTEN#*:}"
      ;;
    localhost:*|127.0.0.1:*)
      printf 'http://%s' "$PROVIDER_LISTEN"
      ;;
    *)
      printf 'http://%s' "$PROVIDER_LISTEN"
      ;;
  esac
}

first_provider_endpoint() {
  IFS=',' read -r -a endpoints <<<"$PROVIDER_ENDPOINTS_RAW"
  for ep in "${endpoints[@]}"; do
    ep="$(echo "$ep" | xargs)"
    if [ -n "$ep" ]; then
      printf '%s' "$ep"
      return 0
    fi
  done
  return 1
}

multiaddr_to_url() {
  local multiaddr="$1"
  local trimmed="${multiaddr#/}"
  local parts=()
  local proto host port scheme

  IFS='/' read -r -a parts <<<"$trimmed"
  proto="${parts[0]:-}"
  host="${parts[1]:-}"
  port="${parts[3]:-}"
  scheme="${parts[4]:-}"

  case "$proto" in
    ip4|dns4) ;;
    *) return 1 ;;
  esac

  case "$scheme" in
    http|https) ;;
    *) return 1 ;;
  esac

  if [ -z "$host" ] || [ -z "$port" ]; then
    return 1
  fi

  printf '%s://%s:%s' "$scheme" "$host" "$port"
}

provider_public_base_url() {
  local endpoint
  endpoint="$(first_provider_endpoint || true)"
  if [ -z "$endpoint" ]; then
    return 1
  fi
  multiaddr_to_url "$endpoint"
}

find_nil_core_lib_dir() {
  local candidate
  local candidates=(
    "$NIL_CORE_LIB_DIR"
    "$ROOT_DIR/nilchain/lib"
    "$ROOT_DIR/nil_core/target/release"
    "$ROOT_DIR/nil_gateway_gui/src-tauri/bin"
  )

  for candidate in "${candidates[@]}"; do
    [ -n "$candidate" ] || continue
    if [ -f "$candidate/libnil_core.so" ] || [ -f "$candidate/libnil_core.dylib" ]; then
      echo "$candidate"
      return 0
    fi
  done

  return 1
}

ensure_nil_core_runtime() {
  local lib_dir
  lib_dir="$(find_nil_core_lib_dir || true)"

  if [ -z "$lib_dir" ]; then
    echo "==> Building nil_core runtime library..."
    (cd "$ROOT_DIR/nil_core" && cargo build --release >/dev/null)
    lib_dir="$ROOT_DIR/nil_core/target/release"
  fi

  if [ -f "$lib_dir/libnil_core.so" ]; then
    export LD_LIBRARY_PATH="$lib_dir${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  fi
  if [ -f "$lib_dir/libnil_core.dylib" ]; then
    export DYLD_LIBRARY_PATH="$lib_dir${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"
  fi
}

ensure_nilchaind() {
  if [ -x "$NILCHAIND_BIN" ]; then
    return 0
  fi
  echo "==> Building nilchaind..."
  (cd "$ROOT_DIR/nilchain" && "$GO_BIN" build -o "$NILCHAIND_BIN" ./cmd/nilchaind)
}

ensure_nil_cli() {
  if [ -x "$NIL_CLI_BIN" ]; then
    return 0
  fi
  echo "==> Building nil_cli..."
  (cd "$ROOT_DIR/nil_cli" && cargo build --release)
}

provider_addr() {
  "$NILCHAIND_BIN" keys show "$PROVIDER_KEY" -a --home "$HOME_DIR" --keyring-backend test 2>/dev/null || true
}

provider_registered() {
  local addr
  addr="$(provider_addr)"
  if [ -z "$addr" ] || [ -z "$LCD_BASE" ] || ! have_cmd curl; then
    return 1
  fi
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$LCD_BASE/nilchain/nilchain/v1/providers/$addr" 2>/dev/null || true)"
  [ "$code" = "200" ]
}

provider_paired() {
  local addr
  addr="$(provider_addr)"
  if [ -z "$addr" ] || [ -z "$LCD_BASE" ] || ! have_cmd curl; then
    return 1
  fi
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$LCD_BASE/nilchain/nilchain/v1/provider-pairings/$addr" 2>/dev/null || true)"
  [ "$code" = "200" ]
}

pending_pairing_exists() {
  if [ -z "$PAIRING_ID" ] || [ -z "$LCD_BASE" ] || ! have_cmd curl; then
    return 1
  fi
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$LCD_BASE/nilchain/nilchain/v1/provider-pairings/pending/$PAIRING_ID" 2>/dev/null || true)"
  [ "$code" = "200" ]
}

print_config() {
  local addr local_url public_url pid pid_file
  addr="$(provider_addr)"
  local_url="$(provider_local_base_url)"
  public_url="$(provider_public_base_url || true)"
  pid_file="$(provider_pid_file)"
  pid=""
  if [ -f "$pid_file" ]; then
    pid="$(cat "$pid_file" 2>/dev/null || true)"
  fi

  cat <<EOF
{
  "network_profile": "$(json_escape "$NETWORK_PROFILE")",
  "provider_key": "$(json_escape "$PROVIDER_KEY")",
  "provider_address": "$(json_escape "$addr")",
  "pairing_id": "$(json_escape "$PAIRING_ID")",
  "chain_id": "$(json_escape "$CHAIN_ID")",
  "hub_lcd": "$(json_escape "$LCD_BASE")",
  "hub_node": "$(json_escape "$NODE_ADDR")",
  "provider_listen": "$(json_escape "$PROVIDER_LISTEN")",
  "provider_local_url": "$(json_escape "$local_url")",
  "provider_endpoint": "$(json_escape "$PROVIDER_ENDPOINTS_RAW")",
  "provider_public_url": "$(json_escape "$public_url")",
  "provider_capabilities": "$(json_escape "$PROVIDER_CAPABILITIES")",
  "provider_total_storage": "$(json_escape "$PROVIDER_TOTAL_STORAGE")",
  "nil_home": "$(json_escape "$HOME_DIR")",
  "nil_upload_dir": "$(json_escape "$UPLOAD_DIR")",
  "trusted_setup": "$(json_escape "$TRUSTED_SETUP")",
  "nilchaind_bin": "$(json_escape "$NILCHAIND_BIN")",
  "nil_cli_bin": "$(json_escape "$NIL_CLI_BIN")",
  "go_bin": "$(json_escape "$GO_BIN")",
  "pid_file": "$(json_escape "$pid_file")",
  "pid": "$(json_escape "$pid")",
  "provider_running": $(provider_running && printf 'true' || printf 'false'),
  "provider_registered": $(provider_registered && printf 'true' || printf 'false'),
  "provider_paired": $(provider_paired && printf 'true' || printf 'false'),
  "pending_pairing_open": $(pending_pairing_exists && printf 'true' || printf 'false'),
  "sp_auth_present": $([ -n "${NIL_GATEWAY_SP_AUTH:-}" ] && printf 'true' || printf 'false')
}
EOF
}

doctor_provider() {
  local failures=0
  local addr local_url public_url pid_file
  addr="$(provider_addr)"
  local_url="$(provider_local_base_url)"
  public_url="$(provider_public_base_url || true)"
  pid_file="$(provider_pid_file)"

  echo "==> provider-daemon doctor"
  echo "  profile: $NETWORK_PROFILE"
  echo "  key:    $PROVIDER_KEY"
  echo "  home:   $HOME_DIR"
  echo "  lcd:    $LCD_BASE"
  echo "  node:   $NODE_ADDR"

  if [ -n "$GO_BIN" ] && have_cmd "$GO_BIN"; then
    echo "OK: go available at $GO_BIN"
  else
    echo "FAIL: go not found"
    failures=$((failures + 1))
  fi

  if [ -x "$NILCHAIND_BIN" ] || [ -f "$NILCHAIND_BIN" ]; then
    echo "OK: nilchaind binary present at $NILCHAIND_BIN"
  else
    echo "WARN: nilchaind binary missing at $NILCHAIND_BIN"
  fi

  if [ -x "$NIL_CLI_BIN" ] || [ -f "$NIL_CLI_BIN" ]; then
    echo "OK: nil_cli binary present at $NIL_CLI_BIN"
  else
    echo "WARN: nil_cli binary missing at $NIL_CLI_BIN"
  fi

  if [ -f "$TRUSTED_SETUP" ]; then
    echo "OK: trusted setup present at $TRUSTED_SETUP"
  else
    echo "FAIL: trusted setup missing at $TRUSTED_SETUP"
    failures=$((failures + 1))
  fi

  if [ -n "$addr" ]; then
    echo "OK: provider key exists ($addr)"
  else
    echo "FAIL: provider key missing; run ./scripts/run_devnet_provider.sh init"
    failures=$((failures + 1))
  fi

  if [ -n "$PAIRING_ID" ]; then
    echo "OK: pairing id configured ($PAIRING_ID)"
    if provider_paired; then
      echo "OK: provider pairing is confirmed on-chain"
    elif pending_pairing_exists; then
      echo "WARN: pairing is still pending on-chain; rerun bootstrap after the website opens pairing"
    else
      echo "WARN: pairing id is not open on-chain yet; start from the website pairing step first"
    fi
  else
    echo "WARN: PAIRING_ID is not set; website-driven onboarding and My Providers linking will be unavailable"
  fi

  if [ -n "$PROVIDER_ENDPOINTS_RAW" ]; then
    echo "OK: provider endpoint configured ($PROVIDER_ENDPOINTS_RAW)"
  else
    echo "WARN: provider endpoint not set; registration will be skipped until PROVIDER_ENDPOINT is configured"
  fi

  if provider_registered; then
    echo "OK: provider is visible on-chain via $LCD_BASE"
  else
    if [ -n "$addr" ] && have_cmd curl; then
      echo "WARN: provider is not visible on-chain yet via $LCD_BASE"
    else
      echo "WARN: on-chain registration could not be checked"
    fi
  fi

  if provider_running; then
    echo "OK: provider process is running (pid $(cat "$pid_file"))"
  else
    echo "WARN: provider process is not running"
  fi

  if have_cmd curl; then
    if curl -fsS --max-time 5 "$local_url/health" >/dev/null 2>&1; then
      echo "OK: local provider health reachable at $local_url/health"
    else
      echo "WARN: local provider health unreachable at $local_url/health"
    fi

    if [ -n "$public_url" ]; then
      if curl -fsS --max-time 5 "$public_url/health" >/dev/null 2>&1; then
        echo "OK: public provider health reachable at $public_url/health"
      else
        echo "WARN: public provider health unreachable at $public_url/health"
      fi
    fi
  else
    echo "WARN: curl not available; skipping health checks"
  fi

  if [ "$failures" -gt 0 ]; then
    echo "Doctor found $failures critical issue(s)." >&2
    return 1
  fi

  echo "Doctor finished with no critical issues."
}

verify_provider() {
  local addr local_url public_url
  local args=()

  local_url="$(provider_local_base_url)"
  public_url="$(provider_public_base_url || true)"
  addr="$(provider_addr)"

  args=(provider --provider "$local_url")
  if [ -n "$LCD_BASE" ]; then
    args+=(--hub-lcd "$LCD_BASE")
  fi
  if [ -n "$addr" ]; then
    args+=(--provider-addr "$addr")
  fi
  if [ -n "$public_url" ]; then
    args+=(--provider-public "$public_url")
  fi

  "$ROOT_DIR/scripts/devnet_healthcheck.sh" "${args[@]}"
}

init_provider() {
  ensure_nilchaind
  mkdir -p "$HOME_DIR"
  if [ -z "$(provider_addr)" ]; then
    echo "==> Creating provider key: $PROVIDER_KEY"
    "$NILCHAIND_BIN" keys add "$PROVIDER_KEY" --home "$HOME_DIR" --keyring-backend test >/dev/null
  fi

  local addr
  addr="$(provider_addr)"
  echo "Provider key ready:"
  echo "  key:     $PROVIDER_KEY"
  echo "  address: $addr"
  if [ -n "$PAIRING_ID" ]; then
    echo "  pairing: $PAIRING_ID"
  fi
  echo
  echo "Next:"
  echo "  - Ask the hub operator to fund this address with aatom (gas) if needed."
  echo "  - Open pairing from the website, then rerun bootstrap with PAIRING_ID=<pairing-id>."
  echo "  - Set PROVIDER_ENDPOINT if this host is public, then rerun bootstrap."
}

register_provider() {
  ensure_nilchaind

  if [ -z "$PROVIDER_ENDPOINTS_RAW" ]; then
    echo "ERROR: set PROVIDER_ENDPOINT (or PROVIDER_ENDPOINTS) to a reachable multiaddr, e.g. /ip4/1.2.3.4/tcp/8091/http" >&2
    exit 1
  fi

  local addr
  addr="$(provider_addr)"
  if [ -z "$addr" ]; then
    echo "ERROR: provider key not found; run: ./scripts/run_devnet_provider.sh init" >&2
    exit 1
  fi

  IFS=',' read -r -a endpoints <<<"$PROVIDER_ENDPOINTS_RAW"
  local endpoint_args=()
  for ep in "${endpoints[@]}"; do
    ep="$(echo "$ep" | xargs)"
    if [ -n "$ep" ]; then
      endpoint_args+=("--endpoint" "$ep")
    fi
  done
  if [ "${#endpoint_args[@]}" -eq 0 ]; then
    echo "ERROR: no endpoints parsed from PROVIDER_ENDPOINTS" >&2
    exit 1
  fi

  if provider_registered; then
    echo "==> Updating provider endpoints on-chain..."
    "$NILCHAIND_BIN" tx nilchain update-provider-endpoints \
      "${endpoint_args[@]}" \
      --from "$PROVIDER_KEY" \
      --chain-id "$CHAIN_ID" \
      --node "$NODE_ADDR" \
      --home "$HOME_DIR" \
      --keyring-backend test \
      --gas auto \
      --gas-adjustment 1.6 \
      --gas-prices "$GAS_PRICES" \
      --yes >/dev/null
    echo "Updated:"
  else
    echo "==> Registering provider on-chain..."
    "$NILCHAIND_BIN" tx nilchain register-provider "$PROVIDER_CAPABILITIES" "$PROVIDER_TOTAL_STORAGE" \
      "${endpoint_args[@]}" \
      --from "$PROVIDER_KEY" \
      --chain-id "$CHAIN_ID" \
      --node "$NODE_ADDR" \
      --home "$HOME_DIR" \
      --keyring-backend test \
      --gas auto \
      --gas-adjustment 1.6 \
      --gas-prices "$GAS_PRICES" \
      --yes >/dev/null
    echo "Registered:"
  fi

  echo "  profile:   $NETWORK_PROFILE"
  echo "  address:   $addr"
  echo "  endpoints: $PROVIDER_ENDPOINTS_RAW"
  echo "  lcd:       $LCD_BASE"
}

confirm_provider_pairing() {
  ensure_nilchaind

  if [ -z "$PAIRING_ID" ]; then
    echo "ERROR: PAIRING_ID is required to confirm provider pairing" >&2
    exit 1
  fi

  local addr
  addr="$(provider_addr)"
  if [ -z "$addr" ]; then
    echo "ERROR: provider key not found; run: ./scripts/run_devnet_provider.sh init" >&2
    exit 1
  fi

  if provider_paired; then
    echo "==> Provider is already paired on-chain; skipping confirm."
    return 0
  fi
  if ! pending_pairing_exists; then
    echo "ERROR: pairing id $PAIRING_ID is not open on-chain; open pairing from the website first" >&2
    exit 1
  fi

  echo "==> Confirming provider pairing on-chain..."
  "$NILCHAIND_BIN" tx nilchain confirm-provider-pairing "$PAIRING_ID" \
    --from "$PROVIDER_KEY" \
    --chain-id "$CHAIN_ID" \
    --node "$NODE_ADDR" \
    --home "$HOME_DIR" \
    --keyring-backend test \
    --gas auto \
    --gas-adjustment 1.6 \
    --gas-prices "$GAS_PRICES" \
    --yes >/dev/null

  echo "Paired:"
  echo "  address:    $addr"
  echo "  pairing_id: $PAIRING_ID"
}

start_provider() {
  ensure_nilchaind
  ensure_nil_cli

  if [ ! -f "$TRUSTED_SETUP" ]; then
    echo "ERROR: trusted setup not found at $TRUSTED_SETUP (set NIL_TRUSTED_SETUP)" >&2
    exit 1
  fi
  if [ -z "$(provider_addr)" ]; then
    echo "ERROR: provider key not found; run: ./scripts/run_devnet_provider.sh init" >&2
    exit 1
  fi
  if [ -z "${NIL_GATEWAY_SP_AUTH:-}" ]; then
    echo "ERROR: NIL_GATEWAY_SP_AUTH must be set to the hub's shared auth token" >&2
    exit 1
  fi

  mkdir -p "$UPLOAD_DIR"

  local pid_file="$PID_DIR/provider.pid"
  local local_url
  local_url="$(provider_local_base_url)"
  if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    echo "Provider already running (pid $(cat "$pid_file"))"
    return 0
  fi

  echo "==> Starting provider-daemon..."
  (
    cd "$ROOT_DIR/nil_gateway"
    nohup env \
      NIL_RUNTIME_PERSONA="provider-daemon" \
      NIL_LISTEN_ADDR="$PROVIDER_LISTEN" \
      NIL_PROVIDER_BASE="$local_url" \
      NIL_CHAIN_ID="$CHAIN_ID" \
      NIL_NODE="$NODE_ADDR" \
      NIL_LCD_BASE="$LCD_BASE" \
      NIL_HOME="$HOME_DIR" \
      NIL_UPLOAD_DIR="$UPLOAD_DIR" \
      NIL_CLI_BIN="$NIL_CLI_BIN" \
      NIL_TRUSTED_SETUP="$TRUSTED_SETUP" \
      NILCHAIND_BIN="$NILCHAIND_BIN" \
      NIL_PROVIDER_KEY="$PROVIDER_KEY" \
      NIL_PROVIDER_ENDPOINTS="$PROVIDER_ENDPOINTS_RAW" \
      NIL_PROVIDER_PAIRING_ID="$PAIRING_ID" \
      NIL_GATEWAY_SP_AUTH="$NIL_GATEWAY_SP_AUTH" \
      "$GO_BIN" run . \
      >"$LOG_DIR/provider.log" 2>&1 &
    echo $! >"$pid_file"
  )

  echo "provider-daemon started:"
  echo "  pid:   $(cat "$pid_file")"
  echo "  http:  $local_url"
  echo "  logs:  $LOG_DIR/provider.log"
}

bootstrap_provider() {
  init_provider

  if [ -n "$PAIRING_ID" ]; then
    confirm_provider_pairing
  else
    echo "==> Skipping pairing confirm: PAIRING_ID is not set."
  fi

  if [ -n "${NIL_GATEWAY_SP_AUTH:-}" ]; then
    start_provider
  else
    echo "==> Skipping start: NIL_GATEWAY_SP_AUTH is not set."
  fi

  if [ -n "$PROVIDER_ENDPOINTS_RAW" ]; then
    register_provider
  else
    echo "==> Skipping register: PROVIDER_ENDPOINT is not set."
  fi

  doctor_provider
}

stop_provider() {
  local pid_file="$PID_DIR/provider.pid"
  if [ ! -f "$pid_file" ]; then
    echo "No provider pid file found."
    return 0
  fi
  local pid
  pid="$(cat "$pid_file")"
  kill "$pid" 2>/dev/null || true
  rm -f "$pid_file"
  echo "Stopped provider (pid $pid)"
}

ensure_nil_core_runtime

case "$ACTION" in
  init) init_provider ;;
  register) register_provider ;;
  start) start_provider ;;
  print-config) print_config ;;
  doctor) doctor_provider ;;
  verify) verify_provider ;;
  bootstrap) bootstrap_provider ;;
  stop) stop_provider ;;
  *)
    echo "Usage: $0 [init|register|start|print-config|doctor|verify|bootstrap|stop]" >&2
    exit 1
    ;;
esac

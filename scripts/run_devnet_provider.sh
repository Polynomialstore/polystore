#!/usr/bin/env bash
set -euo pipefail

# provider-daemon launcher for the shared PolyStore testnet/devnet.
#
# Usage:
#   PROVIDER_KEY=provider1 ./scripts/run_devnet_provider.sh init
#   PROVIDER_KEY=provider1 OPERATOR_ADDRESS=<0x...|nil1...> ./scripts/run_devnet_provider.sh pair
#   PROVIDER_KEY=provider1 OPERATOR_ADDRESS=<0x...|nil1...> ./scripts/run_devnet_provider.sh link
#   PROVIDER_KEY=provider1 OPERATOR_ADDRESS=<0x...|nil1...> ./scripts/run_devnet_provider.sh bootstrap
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

usage() {
  cat <<'USAGE'
Usage: ./scripts/run_devnet_provider.sh [init|pair|link|register|start|print-config|doctor|verify|bootstrap|stop|help]

Examples:
  PROVIDER_KEY=provider1 ./scripts/run_devnet_provider.sh init
  PROVIDER_KEY=provider1 OPERATOR_ADDRESS=<0x...|nil1...> ./scripts/run_devnet_provider.sh pair
  PROVIDER_KEY=provider1 OPERATOR_ADDRESS=<0x...|nil1...> ./scripts/run_devnet_provider.sh link
  PROVIDER_KEY=provider1 OPERATOR_ADDRESS=<0x...|nil1...> ./scripts/run_devnet_provider.sh bootstrap
  PROVIDER_KEY=provider1 PROVIDER_ENDPOINT="/ip4/<ip>/tcp/8091/http" ./scripts/run_devnet_provider.sh register
  PROVIDER_KEY=provider1 PROVIDER_LISTEN=":8091" ./scripts/run_devnet_provider.sh start
  PROVIDER_KEY=provider1 ./scripts/run_devnet_provider.sh print-config
  PROVIDER_KEY=provider1 ./scripts/run_devnet_provider.sh doctor
  PROVIDER_KEY=provider1 ./scripts/run_devnet_provider.sh verify
  PROVIDER_KEY=provider1 ./scripts/run_devnet_provider.sh stop
  ./scripts/run_devnet_provider.sh help

Notes:
  - pair/link/register submit on-chain tx and require provider aatom gas balance.
  - By default, pair/link/register will auto-request faucet funds when NIL_PROVIDER_AUTO_FAUCET=1
    and NIL_FAUCET_URL (or POLYSTORE_TESTNET_FAUCET_URL) is configured.
  - start/register/bootstrap will not auto-create provider keys; run init or pair first.
  - EXPECTED_PROVIDER_ADDRESS (or NIL_EXPECTED_PROVIDER_ADDRESS) can enforce identity safety.
USAGE
}

case "$ACTION" in
  help|-h|--help)
    usage
    exit 0
    ;;
esac

PROVIDER_KEY="${PROVIDER_KEY:-}"
if [ -z "$PROVIDER_KEY" ]; then
  echo "ERROR: PROVIDER_KEY is required (e.g. PROVIDER_KEY=provider1)" >&2
  exit 1
fi

OPERATOR_ADDRESS_RAW="${OPERATOR_ADDRESS:-${NIL_OPERATOR_ADDRESS:-}}"
NETWORK_PROFILE="${POLYSTORE_NETWORK_PROFILE:-polystore-public-testnet}"
CHAIN_ID="${CHAIN_ID:-${NIL_CHAIN_ID:-${POLYSTORE_TESTNET_CHAIN_ID:-20260211}}}"
LCD_BASE="${HUB_LCD:-${NIL_LCD_BASE:-${POLYSTORE_TESTNET_LCD_BASE:-https://lcd.polynomialstore.com}}}"
NODE_ADDR="${HUB_NODE:-${NIL_NODE:-${POLYSTORE_TESTNET_NODE:-https://rpc.polynomialstore.com}}}"
GAS_PRICES="${NIL_GAS_PRICES:-${POLYSTORE_TESTNET_GAS_PRICES:-0.001aatom}}"
FAUCET_URL="${NIL_FAUCET_URL:-${POLYSTORE_TESTNET_FAUCET_URL:-}}"
FAUCET_AUTH_TOKEN="${NIL_FAUCET_AUTH_TOKEN:-${POLYSTORE_TESTNET_FAUCET_AUTH_TOKEN:-}}"
PROVIDER_AUTO_FAUCET="${NIL_PROVIDER_AUTO_FAUCET:-1}"
PROVIDER_FUNDING_WAIT_SECS="${NIL_PROVIDER_FUNDING_WAIT_SECS:-45}"
PROVIDER_FUNDING_POLL_SECS="${NIL_PROVIDER_FUNDING_POLL_SECS:-2}"

NILCHAIND_BIN="${NILCHAIND_BIN:-$ROOT_DIR/nilchain/nilchaind}"
NIL_CLI_BIN="${NIL_CLI_BIN:-$ROOT_DIR/nil_cli/target/release/nil_cli}"
TRUSTED_SETUP="${NIL_TRUSTED_SETUP:-$ROOT_DIR/nilchain/trusted_setup.txt}"

PROVIDER_LISTEN="${PROVIDER_LISTEN:-${NIL_LISTEN_ADDR:-:8091}}"
PROVIDER_CAPABILITIES="${PROVIDER_CAPABILITIES:-General}"
PROVIDER_TOTAL_STORAGE="${PROVIDER_TOTAL_STORAGE:-1099511627776}" # 1 TiB default
PROVIDER_ENDPOINTS_RAW="${PROVIDER_ENDPOINTS:-${PROVIDER_ENDPOINT:-}}"
BOOTSTRAP_ALLOW_PARTIAL="${BOOTSTRAP_ALLOW_PARTIAL:-0}"
EXPECTED_PROVIDER_ADDRESS_RAW="${EXPECTED_PROVIDER_ADDRESS:-${NIL_EXPECTED_PROVIDER_ADDRESS:-}}"

HOME_DIR="${NIL_HOME:-$ROOT_DIR/_artifacts/devnet_provider/$PROVIDER_KEY/nilchain_home}"
UPLOAD_DIR="${NIL_UPLOAD_DIR:-$ROOT_DIR/_artifacts/devnet_provider/$PROVIDER_KEY/uploads}"
LOG_DIR="$ROOT_DIR/_artifacts/devnet_provider/$PROVIDER_KEY"
PID_DIR="$LOG_DIR/pids"

GO_BIN="${GO_BIN:-$(command -v go)}"
NIL_CORE_LIB_DIR="${NIL_CORE_LIB_DIR:-}"
PROVIDER_KEY_CREATED=0

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

amount_is_positive() {
  local amount="${1:-}"
  if [ -z "$amount" ] || [[ ! "$amount" =~ ^[0-9]+$ ]]; then
    return 1
  fi
  if [ "$amount" = "0" ]; then
    return 1
  fi
  return 0
}

eth_to_nil_bech32() {
  local eth_addr="$1"
  python3 - "$eth_addr" <<'PY'
import sys

CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"

def bech32_polymod(values):
    gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
    chk = 1
    for v in values:
        b = chk >> 25
        chk = ((chk & 0x1ffffff) << 5) ^ v
        for i in range(5):
            chk ^= gen[i] if ((b >> i) & 1) else 0
    return chk

def bech32_hrp_expand(hrp):
    return [ord(x) >> 5 for x in hrp] + [0] + [ord(x) & 31 for x in hrp]

def bech32_create_checksum(hrp, data):
    values = bech32_hrp_expand(hrp) + data
    polymod = bech32_polymod(values + [0, 0, 0, 0, 0, 0]) ^ 1
    return [(polymod >> 5 * (5 - i)) & 31 for i in range(6)]

def bech32_encode(hrp, data):
    combined = data + bech32_create_checksum(hrp, data)
    return hrp + "1" + "".join(CHARSET[d] for d in combined)

def convertbits(data, frombits, tobits, pad=True):
    acc = 0
    bits = 0
    ret = []
    maxv = (1 << tobits) - 1
    max_acc = (1 << (frombits + tobits - 1)) - 1
    for value in data:
        if value < 0 or (value >> frombits):
            return None
        acc = ((acc << frombits) | value) & max_acc
        bits += frombits
        while bits >= tobits:
            bits -= tobits
            ret.append((acc >> bits) & maxv)
    if pad:
        if bits:
            ret.append((acc << (tobits - bits)) & maxv)
    elif bits >= frombits or ((acc << (tobits - bits)) & maxv):
        return None
    return ret

addr = sys.argv[1].strip()
if addr.startswith("0x") or addr.startswith("0X"):
    addr = addr[2:]
addr = addr.strip()
if len(addr) != 40:
    raise SystemExit("invalid eth address length")

raw = bytes.fromhex(addr)
data5 = convertbits(raw, 8, 5, True)
print(bech32_encode("nil", data5))
PY
}

normalize_operator_address() {
  local raw="${1:-}"
  raw="$(echo "$raw" | xargs)"
  if [ -z "$raw" ]; then
    return 1
  fi
  if [[ "$raw" == nil1* ]]; then
    printf '%s' "$raw"
    return 0
  fi
  if [[ "$raw" == 0x* || "$raw" == 0X* ]]; then
    if ! have_cmd python3; then
      return 1
    fi
    eth_to_nil_bech32 "$raw" 2>/dev/null
    return $?
  fi
  return 1
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
  local endpoint_csv="${PROVIDER_ENDPOINTS_RAW:-}"
  if [ -z "$endpoint_csv" ]; then
    return 1
  fi
  local endpoints=()
  IFS=',' read -r -a endpoints <<<"$endpoint_csv" || true
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
    "$ROOT_DIR/polystore_gateway_gui/src-tauri/bin"
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
  if [ -d "$lib_dir" ]; then
    if [ -n "${CGO_LDFLAGS:-}" ]; then
      case " ${CGO_LDFLAGS} " in
        *" -L${lib_dir} "*) ;;
        *) export CGO_LDFLAGS="-L${lib_dir} ${CGO_LDFLAGS}" ;;
      esac
    else
      export CGO_LDFLAGS="-L${lib_dir}"
    fi
  fi
}

ensure_nilchaind() {
  if [ -x "$NILCHAIND_BIN" ]; then
    return 0
  fi
  ensure_nil_core_runtime
  local build_goflags="${GOFLAGS:-}"
  build_goflags="${build_goflags} -mod=mod"
  echo "==> Building nilchaind..."
  (cd "$ROOT_DIR/nilchain" && GOFLAGS="$build_goflags" "$GO_BIN" build -o "$NILCHAIND_BIN" ./cmd/nilchaind)
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

provider_key_exists() {
  local addr
  addr="$(provider_addr)"
  [ -n "$addr" ]
}

require_existing_provider_key() {
  local action_label="${1:-this action}"
  ensure_nilchaind
  if provider_key_exists; then
    return 0
  fi
  echo "ERROR: provider key '$PROVIDER_KEY' does not exist in keyring home '$HOME_DIR'." >&2
  echo "Refusing to create a new key during $action_label." >&2
  echo "Run one of these first:" >&2
  echo "  PROVIDER_KEY='$PROVIDER_KEY' ./scripts/run_devnet_provider.sh init" >&2
  echo "  OPERATOR_ADDRESS='<operator-nil1-or-0x-address>' PROVIDER_KEY='$PROVIDER_KEY' ./scripts/run_devnet_provider.sh pair" >&2
  return 1
}

expected_provider_address() {
  local raw="${EXPECTED_PROVIDER_ADDRESS_RAW:-}"
  raw="$(echo "$raw" | xargs)"
  if [ -z "$raw" ]; then
    return 1
  fi
  printf '%s' "$raw"
}

assert_expected_provider_address() {
  local expected actual
  expected="$(expected_provider_address || true)"
  if [ -z "$expected" ]; then
    return 0
  fi

  actual="$(provider_addr)"
  if [ -z "$actual" ]; then
    echo "ERROR: EXPECTED_PROVIDER_ADDRESS is set to $expected but provider key '$PROVIDER_KEY' could not be resolved." >&2
    return 1
  fi
  if [ "$actual" != "$expected" ]; then
    echo "ERROR: provider key '$PROVIDER_KEY' resolves to $actual, but EXPECTED_PROVIDER_ADDRESS is $expected." >&2
    echo "Refusing to continue to protect against wrong-provider bootstrap." >&2
    echo "Fix by selecting the correct PROVIDER_KEY or NIL_HOME for the approved provider identity." >&2
    return 1
  fi
  return 0
}

provider_listen_port() {
  local listen="${PROVIDER_LISTEN:-}"
  local hostport
  if [ -z "$listen" ]; then
    return 1
  fi

  case "$listen" in
    http://*|https://*)
      hostport="${listen#*://}"
      hostport="${hostport%%/*}"
      if [[ "$hostport" == *:* ]]; then
        printf '%s' "${hostport##*:}"
      elif [[ "$listen" == https://* ]]; then
        printf '443'
      else
        printf '80'
      fi
      ;;
    :*)
      printf '%s' "${listen#:}"
      ;;
    *:*)
      printf '%s' "${listen##*:}"
      ;;
    *)
      return 1
      ;;
  esac
}

p2p_listen_ports() {
  local raw="${NIL_P2P_LISTEN_ADDRS:-/ip4/0.0.0.0/tcp/9100/ws}"
  local entries=()
  local ports=()
  local seen=" "
  local entry port

  IFS=',' read -r -a entries <<<"$raw" || true
  if [ "${#entries[@]}" -eq 0 ]; then
    entries=("/ip4/0.0.0.0/tcp/9100/ws")
  fi

  for entry in "${entries[@]}"; do
    entry="$(echo "$entry" | xargs)"
    [ -n "$entry" ] || continue
    port=""
    if [[ "$entry" =~ /tcp/([0-9]+) ]]; then
      port="${BASH_REMATCH[1]}"
    elif [[ "$entry" =~ :([0-9]+)$ ]]; then
      port="${BASH_REMATCH[1]}"
    fi
    if [ -n "$port" ] && [[ "$port" =~ ^[0-9]+$ ]]; then
      if [[ "$seen" != *" $port "* ]]; then
        ports+=("$port")
        seen="${seen}${port} "
      fi
    fi
  done

  if [ "${#ports[@]}" -eq 0 ]; then
    ports=("9100")
  fi

  printf '%s\n' "${ports[@]}"
}

process_cwd_for_pid() {
  local pid="$1"
  local cwd=""
  if have_cmd lsof; then
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n1)"
  fi
  if [ -z "$cwd" ] && have_cmd pwdx; then
    cwd="$(pwdx "$pid" 2>/dev/null | awk '{print $2}')"
  fi
  printf '%s' "$cwd"
}

assert_port_not_in_use_by_other_process() {
  local port="$1"
  local label="$2"
  local allowed_pid="${3:-}"
  local pid cwd

  [ -n "$port" ] || return 0
  [[ "$port" =~ ^[0-9]+$ ]] || return 0
  have_cmd lsof || return 0

  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    if [ -n "$allowed_pid" ] && [ "$pid" = "$allowed_pid" ]; then
      continue
    fi
    cwd="$(process_cwd_for_pid "$pid")"
    echo "ERROR: ${label} port ${port} is already in use by pid ${pid}${cwd:+ (cwd: $cwd)}." >&2
    echo "Refusing to start provider-daemon because this usually means a stale provider from another checkout is running." >&2
    echo "Stop the conflicting process, then retry." >&2
    echo "  kill $pid" >&2
    echo "  # or: lsof -tiTCP:${port} -sTCP:LISTEN | xargs -I{} kill {}" >&2
    return 1
  done < <(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)

  return 0
}

assert_required_ports_available() {
  local pid_file current_pid listen_port p2p_port
  pid_file="$(provider_pid_file)"
  current_pid=""
  if [ -f "$pid_file" ]; then
    current_pid="$(cat "$pid_file" 2>/dev/null || true)"
  fi

  listen_port="$(provider_listen_port || true)"
  assert_port_not_in_use_by_other_process "$listen_port" "provider HTTP listen" "$current_pid"

  while IFS= read -r p2p_port; do
    [ -n "$p2p_port" ] || continue
    assert_port_not_in_use_by_other_process "$p2p_port" "provider P2P listen" "$current_pid"
  done < <(p2p_listen_ports)
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

provider_json() {
  local addr
  addr="$(provider_addr)"
  if [ -z "$addr" ] || [ -z "$LCD_BASE" ] || ! have_cmd curl; then
    return 1
  fi
  curl -fsS --max-time 5 "$LCD_BASE/nilchain/nilchain/v1/providers/$addr" 2>/dev/null
}

provider_aatom_amount() {
  local addr body amount
  addr="$(provider_addr)"
  if [ -z "$addr" ] || [ -z "$LCD_BASE" ] || ! have_cmd curl; then
    return 1
  fi

  body="$(curl -fsS --max-time 5 "$LCD_BASE/cosmos/bank/v1beta1/balances/$addr/by_denom?denom=aatom" 2>/dev/null || true)"
  if [ -z "$body" ]; then
    return 1
  fi

  if have_cmd jq; then
    amount="$(printf '%s' "$body" | jq -r '.balance.amount // empty')"
  elif have_cmd python3; then
    amount="$(python3 - "$body" <<'PY'
import json
import sys

try:
    payload = json.loads(sys.argv[1])
except Exception:
    print("", end="")
    raise SystemExit(0)

balance = payload.get("balance")
if isinstance(balance, dict):
    value = balance.get("amount")
    if isinstance(value, str):
        print(value, end="")
PY
)"
  else
    amount="$(printf '%s' "$body" | tr -d '\n' | sed -n 's/.*"amount"[[:space:]]*:[[:space:]]*"\([0-9]\+\)".*/\1/p' | head -n1)"
  fi

  if [[ "$amount" =~ ^[0-9]+$ ]]; then
    printf '%s' "$amount"
    return 0
  fi

  return 1
}

request_provider_faucet_funds() {
  local addr="$1"
  local payload faucet_resp http_code faucet_body attempt

  if [ -z "$FAUCET_URL" ] || ! have_cmd curl; then
    return 1
  fi

  payload="$(printf '{"address":"%s"}' "$addr")"
  for attempt in 1 2 3; do
    if [ -n "$FAUCET_AUTH_TOKEN" ]; then
      faucet_resp="$(curl -sS -w $'\n%{http_code}' -X POST "$FAUCET_URL" \
        -H "Content-Type: application/json" \
        -H "X-Nil-Faucet-Auth: $FAUCET_AUTH_TOKEN" \
        --data "$payload" 2>/dev/null || true)"
    else
      faucet_resp="$(curl -sS -w $'\n%{http_code}' -X POST "$FAUCET_URL" \
        -H "Content-Type: application/json" \
        --data "$payload" 2>/dev/null || true)"
    fi

    http_code="$(printf '%s' "$faucet_resp" | tail -n1)"
    faucet_body="$(printf '%s' "$faucet_resp" | sed '$d')"

    if [ "$http_code" = "200" ] || [ "$http_code" = "202" ]; then
      echo "==> Faucet funding request accepted for $addr"
      return 0
    fi

    if [ "$http_code" = "429" ] && [ "$attempt" -lt 3 ]; then
      echo "==> Faucet is rate-limited; retrying funding request (${attempt}/3)..."
      sleep 2
      continue
    fi

    echo "WARN: faucet request failed (HTTP ${http_code:-unknown}): ${faucet_body:-<empty>}" >&2
    return 1
  done

  return 1
}

wait_for_provider_funding() {
  local deadline amount
  if ! [[ "$PROVIDER_FUNDING_WAIT_SECS" =~ ^[0-9]+$ ]]; then
    PROVIDER_FUNDING_WAIT_SECS=45
  fi
  if ! [[ "$PROVIDER_FUNDING_POLL_SECS" =~ ^[0-9]+$ ]] || [ "$PROVIDER_FUNDING_POLL_SECS" -le 0 ]; then
    PROVIDER_FUNDING_POLL_SECS=2
  fi

  deadline=$(( $(date +%s) + PROVIDER_FUNDING_WAIT_SECS ))
  while [ "$(date +%s)" -le "$deadline" ]; do
    amount="$(provider_aatom_amount || true)"
    if amount_is_positive "$amount"; then
      printf '%s' "$amount"
      return 0
    fi
    sleep "$PROVIDER_FUNDING_POLL_SECS"
  done

  return 1
}

print_provider_funding_help() {
  local addr="$1"
  local operator
  operator="$(configured_operator_address || true)"

  echo "Fund this provider address with aatom, then rerun the command:" >&2
  echo "  $addr" >&2
  echo >&2
  if [ -n "$FAUCET_URL" ]; then
    if [ -n "$FAUCET_AUTH_TOKEN" ]; then
      echo "Faucet request:" >&2
      echo "  curl -sS -X POST '$FAUCET_URL' -H 'Content-Type: application/json' -H 'X-Nil-Faucet-Auth: $FAUCET_AUTH_TOKEN' --data '{\"address\":\"$addr\"}'" >&2
    else
      echo "Faucet request:" >&2
      echo "  curl -sS -X POST '$FAUCET_URL' -H 'Content-Type: application/json' --data '{\"address\":\"$addr\"}'" >&2
    fi
    echo >&2
  fi

  echo "Manual transfer from any funded key:" >&2
  echo "  $NILCHAIND_BIN tx bank send <funded-key-or-address> $addr 1000000aatom --from <funded-key-or-address> --chain-id '$CHAIN_ID' --node '$NODE_ADDR' --home '$HOME_DIR' --keyring-backend test --gas auto --gas-adjustment 1.6 --gas-prices '$GAS_PRICES' --yes" >&2
  if [ -n "$operator" ]; then
    echo >&2
    echo "Configured operator wallet for this run: $operator" >&2
  fi
}

ensure_provider_account_funded() {
  local addr="$1"
  local amount

  amount="$(provider_aatom_amount || true)"
  if amount_is_positive "$amount"; then
    return 0
  fi

  echo "==> Provider account is not funded on-chain yet:"
  echo "  $addr"

  if [ "$PROVIDER_AUTO_FAUCET" = "1" ] && request_provider_faucet_funds "$addr"; then
    echo "==> Waiting up to ${PROVIDER_FUNDING_WAIT_SECS}s for aatom balance on-chain..."
    amount="$(wait_for_provider_funding || true)"
    if amount_is_positive "$amount"; then
      echo "==> Provider account funded ($amount aatom)."
      return 0
    fi
    echo "WARN: faucet request was sent but aatom balance is still zero after waiting." >&2
  fi

  echo "ERROR: provider account has no spendable aatom; cannot submit on-chain tx." >&2
  print_provider_funding_help "$addr"
  return 1
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

provider_pairing_json() {
  local addr
  addr="$(provider_addr)"
  if [ -z "$addr" ] || [ -z "$LCD_BASE" ] || ! have_cmd curl; then
    return 1
  fi
  curl -fsS --max-time 5 "$LCD_BASE/nilchain/nilchain/v1/provider-pairings/$addr" 2>/dev/null
}

pending_link_exists() {
  local addr
  addr="$(provider_addr)"
  if [ -z "$addr" ] || [ -z "$LCD_BASE" ] || ! have_cmd curl; then
    return 1
  fi
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$LCD_BASE/nilchain/nilchain/v1/provider-pairings/pending/$addr" 2>/dev/null || true)"
  [ "$code" = "200" ]
}

pending_link_json() {
  local addr
  addr="$(provider_addr)"
  if [ -z "$addr" ] || [ -z "$LCD_BASE" ] || ! have_cmd curl; then
    return 1
  fi
  curl -fsS --max-time 5 "$LCD_BASE/nilchain/nilchain/v1/provider-pairings/pending/$addr" 2>/dev/null
}

json_string_field() {
  local field="$1"
  local body="${2:-}"
  if have_cmd jq; then
    printf '%s' "$body" | jq -r --arg field "$field" '(.[$field] // .provider[$field] // .pairing[$field] // .link[$field] // empty) | strings'
    return 0
  fi
  if have_cmd python3; then
    JSON_FIELD="$field" python3 -c 'import json, os, sys
field = os.environ["JSON_FIELD"]
try:
    payload = json.load(sys.stdin)
except Exception:
    sys.exit(0)
candidates = []
if isinstance(payload, dict):
    candidates.append(payload.get(field))
    for parent in ("provider", "pairing", "link"):
        scoped = payload.get(parent)
        if isinstance(scoped, dict):
            candidates.append(scoped.get(field))
for value in candidates:
    if isinstance(value, str):
        sys.stdout.write(value)
        break' <<<"$body"
    return 0
  fi
  printf '%s' "$body" | tr -d '\n' | sed -n "s/.*\"$field\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" | head -n1
}

json_array_field() {
  local field="$1"
  local body="${2:-}"
  if have_cmd jq; then
    printf '%s' "$body" | jq -c --arg field "$field" '(.[$field] // .provider[$field] // .pairing[$field] // .link[$field] // []) | arrays'
    return 0
  fi
  if have_cmd python3; then
    JSON_FIELD="$field" python3 -c 'import json, os, sys
field = os.environ["JSON_FIELD"]
try:
    payload = json.load(sys.stdin)
except Exception:
    sys.stdout.write("[]")
    sys.exit(0)
candidates = []
if isinstance(payload, dict):
    candidates.append(payload.get(field))
    for parent in ("provider", "pairing", "link"):
        scoped = payload.get(parent)
        if isinstance(scoped, dict):
            candidates.append(scoped.get(field))
for value in candidates:
    if isinstance(value, list):
        sys.stdout.write(json.dumps(value))
        break
else:
    sys.stdout.write("[]")' <<<"$body"
    return 0
  fi
  local value
  value="$(printf '%s' "$body" | tr -d '\n' | sed -n "s/.*\"$field\"[[:space:]]*:[[:space:]]*\\(\\[[^]]*\\]\\).*/\\1/p" | head -n1)"
  if [ -n "$value" ]; then
    printf '%s' "$value"
  else
    printf '[]'
  fi
}

provider_pairing_operator() {
  local body
  body="$(provider_pairing_json)" || return 1
  json_string_field "operator" "$body"
}

pending_link_operator() {
  local body
  body="$(pending_link_json)" || return 1
  json_string_field "operator" "$body"
}

configured_operator_address() {
  normalize_operator_address "$OPERATOR_ADDRESS_RAW"
}

provider_registered_endpoints_json() {
  local body
  body="$(provider_json)" || {
    printf '[]'
    return 0
  }
  json_array_field "endpoints" "$body"
}

local_health_ok() {
  local local_url
  local_url="$(provider_local_base_url)"
  have_cmd curl && curl -fsS --max-time 5 "$local_url/health" >/dev/null 2>&1
}

public_health_ok() {
  local public_url
  public_url="$(provider_public_base_url || true)"
  [ -n "$public_url" ] && have_cmd curl && curl -fsS --max-time 5 "$public_url/health" >/dev/null 2>&1
}

provider_pairing_status() {
  local configured_operator confirmed_operator pending_operator
  configured_operator="$(configured_operator_address || true)"
  confirmed_operator="$(provider_pairing_operator || true)"
  pending_operator="$(pending_link_operator || true)"

  if [ -n "$confirmed_operator" ]; then
    if [ -n "$configured_operator" ] && [ "$confirmed_operator" != "$configured_operator" ]; then
      printf 'paired-to-different-operator'
    else
      printf 'confirmed'
    fi
    return 0
  fi

  if [ -n "$pending_operator" ]; then
    if [ -n "$configured_operator" ] && [ "$pending_operator" != "$configured_operator" ]; then
      printf 'pending-different-operator'
    else
      printf 'pending-operator-approval'
    fi
    return 0
  fi

  if [ -n "$configured_operator" ]; then
    printf 'not-requested'
  else
    printf 'unconfigured'
  fi
}

print_config() {
  local addr local_url public_url pid pid_file registered_endpoints pairing_status
  addr="$(provider_addr)"
  local_url="$(provider_local_base_url)"
  public_url="$(provider_public_base_url || true)"
  registered_endpoints="$(provider_registered_endpoints_json)"
  pairing_status="$(provider_pairing_status)"
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
  "expected_provider_address": "$(json_escape "$(expected_provider_address || true)")",
  "configured_operator": "$(json_escape "$(configured_operator_address || true)")",
  "operator_address": "$(json_escape "$(configured_operator_address || true)")",
  "chain_id": "$(json_escape "$CHAIN_ID")",
  "hub_lcd": "$(json_escape "$LCD_BASE")",
  "hub_node": "$(json_escape "$NODE_ADDR")",
  "provider_listen": "$(json_escape "$PROVIDER_LISTEN")",
  "provider_local_url": "$(json_escape "$local_url")",
  "provider_endpoint": "$(json_escape "$PROVIDER_ENDPOINTS_RAW")",
  "provider_public_url": "$(json_escape "$public_url")",
  "registered_endpoints": $registered_endpoints,
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
  "pairing_status": "$(json_escape "$pairing_status")",
  "local_health_url": "$(json_escape "$local_url/health")",
  "public_health_url": "$(json_escape "${public_url:+$public_url/health}")",
  "local_health_ok": $(local_health_ok && printf 'true' || printf 'false'),
  "public_health_ok": $(public_health_ok && printf 'true' || printf 'false'),
  "lcd_visible": $(provider_registered && printf 'true' || printf 'false'),
  "provider_process_running": $(provider_running && printf 'true' || printf 'false'),
  "provider_running": $(provider_running && printf 'true' || printf 'false'),
  "provider_registered": $(provider_registered && printf 'true' || printf 'false'),
  "provider_paired": $(provider_paired && printf 'true' || printf 'false'),
  "pending_link_open": $(pending_link_exists && printf 'true' || printf 'false'),
  "sp_auth_present": $([ -n "${NIL_GATEWAY_SP_AUTH:-}" ] && printf 'true' || printf 'false')
}
EOF
}

doctor_provider() {
  local failures=0
  local addr local_url public_url pid_file expected_addr
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

  expected_addr="$(expected_provider_address || true)"
  if [ -n "$expected_addr" ]; then
    if [ -n "$addr" ] && [ "$addr" = "$expected_addr" ]; then
      echo "OK: expected provider address guard matches ($expected_addr)"
    else
      echo "FAIL: expected provider address guard mismatch (expected $expected_addr, got ${addr:-<missing>})"
      failures=$((failures + 1))
    fi
  fi

  local configured_operator current_operator requested_operator
  configured_operator="$(configured_operator_address || true)"
  if [ -n "$configured_operator" ]; then
    current_operator="$(provider_pairing_operator || true)"
    requested_operator="$(pending_link_operator || true)"
    echo "OK: operator address configured ($configured_operator)"
    if [ -n "$current_operator" ] && [ "$current_operator" = "$configured_operator" ]; then
      echo "OK: provider pairing is confirmed on-chain for the configured operator"
    elif [ -n "$current_operator" ]; then
      echo "FAIL: provider is already paired on-chain to a different operator ($current_operator)"
      if [ -n "$current_operator" ]; then
        echo "  current operator: $current_operator"
      fi
      failures=$((failures + 1))
    elif [ -n "$requested_operator" ] && [ "$requested_operator" = "$configured_operator" ]; then
      echo "WARN: provider link request is pending on-chain; approve it from the website operator wallet"
    elif [ -n "$requested_operator" ]; then
      echo "FAIL: pending provider link targets a different operator ($requested_operator)"
      failures=$((failures + 1))
    else
      echo "WARN: no provider link request is open on-chain; run ./scripts/run_devnet_provider.sh link"
    fi
  else
    echo "WARN: OPERATOR_ADDRESS is not set; website-driven onboarding and My Providers linking will be unavailable"
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

ensure_provider_key() {
  ensure_nilchaind
  mkdir -p "$HOME_DIR"
  if [ -z "$(provider_addr)" ]; then
    echo "==> Creating provider key: $PROVIDER_KEY"
    "$NILCHAIND_BIN" keys add "$PROVIDER_KEY" --home "$HOME_DIR" --keyring-backend test >/dev/null
    PROVIDER_KEY_CREATED=1
  else
    PROVIDER_KEY_CREATED=0
  fi
}

print_provider_key_summary() {
  local addr="$1"
  echo "Provider key ready:"
  echo "  key:     $PROVIDER_KEY"
  echo "  address: $addr"
}

init_provider() {
  ensure_provider_key
  local addr
  addr="$(provider_addr)"
  print_provider_key_summary "$addr"
  echo
  echo "Manual key preparation status:"
  echo "  - Provider key exists on the provider host."
  if [ "$PROVIDER_KEY_CREATED" = "1" ]; then
    echo "  - New key created for this local keyring."
  else
    echo "  - Existing key reused."
  fi
  echo "  - Ensure this address has aatom for gas: $addr"
  if [ "$PROVIDER_AUTO_FAUCET" = "1" ] && [ -n "$FAUCET_URL" ]; then
    echo "  - pair/link can auto-request faucet funds from: $FAUCET_URL"
  fi
  if [ -n "$OPERATOR_ADDRESS_RAW" ]; then
    echo "  - Target operator wallet: $(configured_operator_address || printf '%s' "$OPERATOR_ADDRESS_RAW")"
  fi
  echo
  echo "Next command (manual link request after key setup):"
  if [ -n "$OPERATOR_ADDRESS_RAW" ]; then
    echo "  OPERATOR_ADDRESS='$OPERATOR_ADDRESS_RAW' PROVIDER_KEY='$PROVIDER_KEY' ./scripts/run_devnet_provider.sh link"
  else
    echo "  OPERATOR_ADDRESS='<operator-0x-or-nil-address>' PROVIDER_KEY='$PROVIDER_KEY' ./scripts/run_devnet_provider.sh link"
  fi
  echo
  echo "For the website-first flow, prefer OPERATOR_ADDRESS=... PROVIDER_KEY=... ./scripts/run_devnet_provider.sh pair."
}

pair_provider() {
  ensure_provider_key
  local addr
  addr="$(provider_addr)"
  print_provider_key_summary "$addr"
  echo
  if [ "$PROVIDER_KEY_CREATED" = "1" ]; then
    echo "==> Provider key was created for this run."
    echo "==> Continuing with funding check and provider link request."
  else
    echo "==> Reusing existing provider key."
  fi

  request_provider_link

  print_pairing_followup
}

register_provider() {
  require_existing_provider_key "register"
  assert_expected_provider_address

  if [ -z "$PROVIDER_ENDPOINTS_RAW" ]; then
    echo "ERROR: set PROVIDER_ENDPOINT (or PROVIDER_ENDPOINTS) to a reachable multiaddr, e.g. /ip4/1.2.3.4/tcp/8091/http" >&2
    exit 1
  fi

  local addr
  addr="$(provider_addr)"

  ensure_provider_account_funded "$addr"

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

request_provider_link() {
  require_existing_provider_key "link request"
  assert_expected_provider_address

  local operator
  operator="$(configured_operator_address || true)"
  if [ -z "$operator" ]; then
    echo "ERROR: OPERATOR_ADDRESS is required (use nil1... or 0x...)" >&2
    exit 1
  fi

  local addr current_operator requested_operator
  addr="$(provider_addr)"
  if [ -z "$addr" ]; then
    echo "ERROR: provider key not found; run: ./scripts/run_devnet_provider.sh init" >&2
    exit 1
  fi

  current_operator="$(provider_pairing_operator || true)"
  requested_operator="$(pending_link_operator || true)"

  if [ -n "$current_operator" ] && [ "$current_operator" = "$operator" ]; then
    echo "==> Provider is already paired on-chain for the configured operator; skipping link request."
    return 0
  fi

  if [ -n "$current_operator" ]; then
    echo "ERROR: provider is already paired on-chain to a different operator ($current_operator)" >&2
    if [ -n "$current_operator" ]; then
      echo "  current operator: $current_operator" >&2
    fi
    echo "Use a fresh provider key or unlink the existing pairing before continuing." >&2
    exit 1
  fi
  if [ -n "$requested_operator" ] && [ "$requested_operator" = "$operator" ]; then
    echo "==> Provider link request is already pending for the configured operator; skipping request."
    return 0
  fi

  ensure_provider_account_funded "$addr"

  echo "==> Requesting provider link on-chain..."
  "$NILCHAIND_BIN" tx nilchain request-provider-link "$operator" \
    --from "$PROVIDER_KEY" \
    --chain-id "$CHAIN_ID" \
    --node "$NODE_ADDR" \
    --home "$HOME_DIR" \
    --keyring-backend test \
    --gas auto \
    --gas-adjustment 1.6 \
    --gas-prices "$GAS_PRICES" \
    --yes >/dev/null

  echo "Link requested:"
  echo "  provider: $addr"
  echo "  operator: $operator"
}

print_pairing_followup() {
  local operator confirmed_operator requested_operator addr
  operator="$(configured_operator_address || true)"
  confirmed_operator="$(provider_pairing_operator || true)"
  requested_operator="$(pending_link_operator || true)"
  addr="$(provider_addr)"

  echo
  if [ -n "$operator" ] && [ "$confirmed_operator" = "$operator" ]; then
    echo "Provider link is already approved on-chain for this operator."
    echo "  provider: $addr"
    echo "  operator: $operator"
    return 0
  fi

  if [ -n "$operator" ] && [ "$requested_operator" = "$operator" ]; then
    echo "Next step (website operator wallet): approve this provider link request."
    echo "  provider: $addr"
    echo "  operator: $operator"
    return 0
  fi

  if [ -n "$confirmed_operator" ]; then
    echo "Provider is paired on-chain to operator $confirmed_operator."
  elif [ -n "$requested_operator" ]; then
    echo "Provider link is pending for operator $requested_operator."
  else
    echo "No confirmed or pending provider link found yet. Refresh LCD and retry if needed."
  fi
  echo "  provider: $addr"
  [ -n "$operator" ] && echo "  configured operator: $operator"
}

link_provider() {
  require_existing_provider_key "link"
  assert_expected_provider_address
  local addr
  addr="$(provider_addr)"
  print_provider_key_summary "$addr"

  request_provider_link

  print_pairing_followup
}

start_provider() {
  require_existing_provider_key "start"
  ensure_nil_cli
  ensure_nil_core_runtime
  assert_expected_provider_address

  if [ ! -f "$TRUSTED_SETUP" ]; then
    echo "ERROR: trusted setup not found at $TRUSTED_SETUP (set NIL_TRUSTED_SETUP)" >&2
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
  assert_required_ports_available

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
      NIL_OPERATOR_ADDRESS="$(configured_operator_address || true)" \
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
  require_existing_provider_key "bootstrap"
  assert_expected_provider_address
  local addr
  addr="$(provider_addr)"
  print_provider_key_summary "$addr"
  echo

  local missing=()
  if [ -z "$OPERATOR_ADDRESS_RAW" ]; then
    missing+=("OPERATOR_ADDRESS")
  fi
  if [ -z "${NIL_GATEWAY_SP_AUTH:-}" ]; then
    missing+=("NIL_GATEWAY_SP_AUTH")
  fi
  if [ -z "$PROVIDER_ENDPOINTS_RAW" ]; then
    missing+=("PROVIDER_ENDPOINT")
  fi

  if [ "${#missing[@]}" -gt 0 ] && [ "$BOOTSTRAP_ALLOW_PARTIAL" != "1" ]; then
    echo "ERROR: bootstrap now fails fast unless website-managed prerequisites are present." >&2
    echo "Missing: ${missing[*]}" >&2
    echo "Provide the missing values and rerun bootstrap, or use the staged manual commands (link/register/start)." >&2
    echo "If you intentionally want a partial manual bootstrap, rerun with BOOTSTRAP_ALLOW_PARTIAL=1." >&2
    return 1
  fi

  if [ -n "$OPERATOR_ADDRESS_RAW" ]; then
    request_provider_link
  else
    echo "==> Skipping link request: OPERATOR_ADDRESS is not set."
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

case "$ACTION" in
  init) init_provider ;;
  pair) pair_provider ;;
  link) link_provider ;;
  register) register_provider ;;
  start) start_provider ;;
  print-config) print_config ;;
  doctor) doctor_provider ;;
  verify) verify_provider ;;
  bootstrap) bootstrap_provider ;;
  stop) stop_provider ;;
  *)
    usage >&2
    exit 1
    ;;
esac

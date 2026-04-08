#!/usr/bin/env bash
#
# Devnet healthcheck (trusted soft launch).
# - Hub mode: validates RPC/LCD/EVM/gateway/faucet are responsive.
# - Provider mode: validates provider gateway is responsive and (optionally) that the hub can see it on-chain.
#
# This script is intentionally dependency-light (curl required; jq optional).

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/devnet_healthcheck.sh [hub] [flags]
  scripts/devnet_healthcheck.sh provider [flags]

Modes:
  hub       (default) Check hub endpoints (RPC/LCD/EVM/gateway/faucet)
  provider  Check provider endpoint (+ optional hub visibility checks)

Hub flags (defaults are localhost):
  --rpc URL        (default: http://127.0.0.1:26657)
  --lcd URL        (default: http://127.0.0.1:1317)
  --evm URL        (default: http://127.0.0.1:8545)
  --gateway URL    (default: http://127.0.0.1:8080)
  --faucet URL     (default: http://127.0.0.1:8081)
  --no-faucet      Skip faucet check

Provider flags:
  --provider URL        Provider gateway base URL (default: http://127.0.0.1:8091)
  --hub-lcd URL         Hub LCD base URL (optional)
  --provider-addr ADDR  Provider bech32 address (optional; requires --hub-lcd)
  --provider-public URL Provider public URL to check from *this* machine (optional)

Global flags:
  --timeout SECONDS  Curl max-time per request (default: 5)
  -h, --help         Show this help

Examples:
  # Hub checks (on the hub host, localhost ports):
  scripts/devnet_healthcheck.sh hub

  # Hub checks (from anywhere, public HTTPS endpoints):
  scripts/devnet_healthcheck.sh hub \
    --rpc https://rpc.<domain> \
    --lcd https://lcd.<domain> \
    --evm https://evm.<domain> \
    --gateway http://127.0.0.1:8080 \
    --faucet https://faucet.<domain>

  # Provider checks (on a provider host):
  scripts/devnet_healthcheck.sh provider \
    --provider http://127.0.0.1:8091 \
    --hub-lcd https://lcd.<domain> \
    --provider-addr nil1...
EOF
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

require_cmd() {
  if ! have_cmd "$1"; then
    echo "ERROR: missing required command: $1" >&2
    exit 127
  fi
}

trim_trailing_slash() {
  printf '%s' "${1%/}"
}

FAILS=0

ok() {
  echo "OK: $*"
}

fail() {
  echo "FAIL: $*" >&2
  FAILS=$((FAILS + 1))
}

http_get() {
  local url="$1"
  curl -fsS --max-time "$HC_TIMEOUT" "$url"
}

http_code() {
  local url="$1"
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time "$HC_TIMEOUT" "$url" 2>/dev/null || true)"
  printf '%s' "${code:-000}"
}

check_http_200() {
  local name="$1"
  local url="$2"
  local code
  code="$(http_code "$url")"
  if [[ "$code" == "200" ]]; then
    ok "$name ($url)"
  else
    fail "$name ($url) expected HTTP 200, got $code"
  fi
}

check_rpc_status() {
  local rpc_base="$1"
  local url="$rpc_base/status"
  local body
  if ! body="$(http_get "$url")"; then
    fail "RPC status ($url) unreachable"
    return
  fi

  if have_cmd jq; then
    local height catching_up
    height="$(jq -r '.result.sync_info.latest_block_height // empty' <<<"$body" 2>/dev/null || true)"
    catching_up="$(jq -r '.result.sync_info.catching_up // empty' <<<"$body" 2>/dev/null || true)"
    if [[ -n "$height" ]]; then
      ok "RPC status height=$height catching_up=$catching_up"
    else
      fail "RPC status ($url) returned unexpected JSON (missing latest_block_height)"
    fi
  else
    ok "RPC status (jq not installed; JSON parse skipped)"
  fi
}

check_lcd_node_info() {
  local lcd_base="$1"
  check_http_200 "LCD node_info" "$lcd_base/cosmos/base/tendermint/v1beta1/node_info"
}

check_polystorechain_params() {
  local lcd_base="$1"
  local url="$lcd_base/polystorechain/polystorechain/v1/params"
  local body
  if ! body="$(http_get "$url")"; then
    fail "Nilchain params ($url) unreachable"
    return
  fi

  if have_cmd jq; then
    local dyn storage retrieval
    dyn="$(jq -r '.params.dynamic_pricing_enabled // empty' <<<"$body" 2>/dev/null || true)"
    storage="$(jq -r '.params.storage_price // empty' <<<"$body" 2>/dev/null || true)"
    retrieval="$(jq -r '.params.retrieval_price_per_blob // empty' <<<"$body" 2>/dev/null || true)"
    if [[ -n "$storage" && -n "$retrieval" ]]; then
      ok "Nilchain params dynamic_pricing_enabled=$dyn storage_price=$storage retrieval_price_per_blob=$retrieval"
    else
      ok "Nilchain params (jq parse partial; raw JSON fetched)"
    fi
  else
    ok "Nilchain params (jq not installed; JSON parse skipped)"
  fi
}

check_evm_chain_id() {
  local evm_base="$1"
  local body
  if ! body="$(curl -fsS --max-time "$HC_TIMEOUT" -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
    "$evm_base")"; then
    fail "EVM JSON-RPC eth_chainId ($evm_base) unreachable"
    return
  fi

  if have_cmd jq; then
    local chain_id
    chain_id="$(jq -r '.result // empty' <<<"$body" 2>/dev/null || true)"
    if [[ -n "$chain_id" ]]; then
      ok "EVM eth_chainId=$chain_id"
    else
      fail "EVM JSON-RPC ($evm_base) returned unexpected JSON (missing .result)"
    fi
  else
    ok "EVM JSON-RPC eth_chainId (jq not installed; JSON parse skipped)"
  fi
}

check_gateway_health() {
  local gateway_base="$1"
  check_http_200 "Gateway /health" "$gateway_base/health"
}

check_faucet_health() {
  local faucet_base="$1"
  check_http_200 "Faucet /health" "$faucet_base/health"
}

check_provider_health() {
  local provider_base="$1"
  check_http_200 "Provider /health" "$provider_base/health"
}

check_provider_onchain_visibility() {
  local hub_lcd="$1"
  local provider_addr="$2"
  check_http_200 "Provider on-chain record" "$hub_lcd/polystorechain/polystorechain/v1/providers/$provider_addr"
}

MODE="hub"
if [[ "${1:-}" == "provider" || "${1:-}" == "hub" ]]; then
  MODE="$1"
  shift
fi

HC_TIMEOUT="${HC_TIMEOUT:-5}"

RPC_DEFAULT="http://127.0.0.1:26657"
LCD_DEFAULT="http://127.0.0.1:1317"
EVM_DEFAULT="http://127.0.0.1:8545"
GATEWAY_DEFAULT="http://127.0.0.1:8080"
FAUCET_DEFAULT="http://127.0.0.1:8081"
PROVIDER_DEFAULT="http://127.0.0.1:8091"

RPC="$RPC_DEFAULT"
LCD="$LCD_DEFAULT"
EVM="$EVM_DEFAULT"
GATEWAY="$GATEWAY_DEFAULT"
FAUCET="$FAUCET_DEFAULT"
CHECK_FAUCET=1

PROVIDER="$PROVIDER_DEFAULT"
HUB_LCD=""
PROVIDER_ADDR=""
PROVIDER_PUBLIC=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rpc) RPC="$2"; shift 2 ;;
    --lcd) LCD="$2"; shift 2 ;;
    --evm) EVM="$2"; shift 2 ;;
    --gateway) GATEWAY="$2"; shift 2 ;;
    --faucet) FAUCET="$2"; CHECK_FAUCET=1; shift 2 ;;
    --no-faucet) CHECK_FAUCET=0; shift ;;
    --timeout) HC_TIMEOUT="$2"; shift 2 ;;
    --provider) PROVIDER="$2"; shift 2 ;;
    --hub-lcd) HUB_LCD="$2"; shift 2 ;;
    --provider-addr) PROVIDER_ADDR="$2"; shift 2 ;;
    --provider-public) PROVIDER_PUBLIC="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "ERROR: unknown arg: $1" >&2
      usage
      exit 2
      ;;
  esac
done

require_cmd curl

RPC="$(trim_trailing_slash "$RPC")"
LCD="$(trim_trailing_slash "$LCD")"
EVM="$(trim_trailing_slash "$EVM")"
GATEWAY="$(trim_trailing_slash "$GATEWAY")"
FAUCET="$(trim_trailing_slash "$FAUCET")"
PROVIDER="$(trim_trailing_slash "$PROVIDER")"
HUB_LCD="$(trim_trailing_slash "$HUB_LCD")"
PROVIDER_PUBLIC="$(trim_trailing_slash "$PROVIDER_PUBLIC")"

echo "==> PolyStore devnet healthcheck (mode=$MODE, timeout=${HC_TIMEOUT}s)"
if ! have_cmd jq; then
  echo "    (note) jq not found; some JSON parsing will be skipped"
fi

if [[ "$MODE" == "hub" ]]; then
  check_rpc_status "$RPC"
  check_lcd_node_info "$LCD"
  check_polystorechain_params "$LCD"
  check_evm_chain_id "$EVM"
  check_gateway_health "$GATEWAY"
  if [[ "$CHECK_FAUCET" == "1" ]]; then
    check_faucet_health "$FAUCET"
  else
    ok "Faucet check skipped"
  fi
elif [[ "$MODE" == "provider" ]]; then
  check_provider_health "$PROVIDER"

  if [[ -n "$PROVIDER_PUBLIC" ]]; then
    check_http_200 "Provider public /health" "$PROVIDER_PUBLIC/health"
  fi

  if [[ -n "$HUB_LCD" && -n "$PROVIDER_ADDR" ]]; then
    check_provider_onchain_visibility "$HUB_LCD" "$PROVIDER_ADDR"
  elif [[ -n "$PROVIDER_ADDR" && -z "$HUB_LCD" ]]; then
    fail "--provider-addr provided without --hub-lcd (cannot query on-chain provider record)"
  fi
else
  echo "ERROR: unknown mode: $MODE" >&2
  usage
  exit 2
fi

if [[ "$FAILS" -gt 0 ]]; then
  echo "==> Healthcheck FAILED ($FAILS problem(s))" >&2
  exit 1
fi

echo "==> Healthcheck OK"

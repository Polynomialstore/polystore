#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/load_testnet_public_env.sh"

usage() {
  cat <<'USAGE'
usage: testnet_burner_upload.sh [options] <file_path> [deal_id] [nilfs_path]

Testnet-only burner-key helper:
- generates a burner EVM key locally
- requests faucet funds for the mapped nil1 address
- runs create/upload/commit via enterprise_upload_job.sh
- exports an encrypted keystore JSON for MetaMask import

Options:
  --export-keystore <path>        Keystore JSON output path (default: ./burner-keystore.json)
  --keystore-password-env <name>  Env var containing keystore password (default: NIL_BURNER_KEYSTORE_PASSWORD)
  --allow-raw-key-export          Allow raw private key export (disabled by default)
  --raw-key-out <path>            Optional path to write raw private key (requires --allow-raw-key-export)
  --destroy-local-key-after-export <0|1>
                                  Unset key material in-process after export (default: 1)
  --faucet-url <url>              Faucet endpoint (default: https://faucet.polynomialstore.com/faucet)
  --faucet-auth-env <name>        Env var for faucet auth token (default: NIL_FAUCET_AUTH_TOKEN)
  --lcd-base <url>                LCD base for balance polling (default: https://lcd.polynomialstore.com)
  --wait-balance-timeout <secs>   Faucet balance wait timeout seconds (default: 120)
  --skip-faucet                   Skip faucet request + balance wait
  --help                          Show this help

Notes:
  - Testnet burner-key flow only. Not for production custody.
  - Private keys are never transmitted over the network by this script.
  - Requires a local Nil Gateway at GATEWAY_BASE (default: http://localhost:8080).
  - Set NIL_BURNER_KEYSTORE_PASSWORD (or pass --keystore-password-env) to avoid an interactive keystore-password prompt.
  - On first run, the script may install polystore-website dependencies if polystore-website/node_modules is missing.
  - Uses direct polystorechaind submission for create/update by default so local gateway
    GUI setup does not also need local tx-relay configuration.
USAGE
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: required command not found: $1" >&2
    exit 1
  fi
}

EXPORT_KEYSTORE="./burner-keystore.json"
KEYSTORE_PASSWORD_ENV="NIL_BURNER_KEYSTORE_PASSWORD"
ALLOW_RAW_KEY_EXPORT=0
RAW_KEY_OUT=""
DESTROY_LOCAL_KEY_AFTER_EXPORT=1
FAUCET_URL="${FAUCET_URL:-${POLYSTORE_TESTNET_FAUCET_URL:-https://faucet.polynomialstore.com/faucet}}"
FAUCET_AUTH_ENV="NIL_FAUCET_AUTH_TOKEN"
LCD_BASE="${LCD_BASE:-${POLYSTORE_TESTNET_LCD_BASE:-https://lcd.polynomialstore.com}}"
WAIT_BALANCE_TIMEOUT=120
FAUCET_RETRY_ATTEMPTS="${FAUCET_RETRY_ATTEMPTS:-6}"
FAUCET_RETRY_DELAY_SECS="${FAUCET_RETRY_DELAY_SECS:-10}"
SKIP_FAUCET=0

POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --export-keystore)
      EXPORT_KEYSTORE="$2"
      shift 2
      ;;
    --keystore-password-env)
      KEYSTORE_PASSWORD_ENV="$2"
      shift 2
      ;;
    --allow-raw-key-export)
      ALLOW_RAW_KEY_EXPORT=1
      shift
      ;;
    --raw-key-out)
      RAW_KEY_OUT="$2"
      shift 2
      ;;
    --destroy-local-key-after-export)
      DESTROY_LOCAL_KEY_AFTER_EXPORT="$2"
      shift 2
      ;;
    --faucet-url)
      FAUCET_URL="$2"
      shift 2
      ;;
    --faucet-auth-env)
      FAUCET_AUTH_ENV="$2"
      shift 2
      ;;
    --lcd-base)
      LCD_BASE="$2"
      shift 2
      ;;
    --wait-balance-timeout)
      WAIT_BALANCE_TIMEOUT="$2"
      shift 2
      ;;
    --skip-faucet)
      SKIP_FAUCET=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --)
      shift
      while [[ $# -gt 0 ]]; do
        POSITIONAL+=("$1")
        shift
      done
      ;;
    -*)
      echo "error: unknown option: $1" >&2
      usage
      exit 1
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done

FILE_PATH="${POSITIONAL[0]:-}"
DEAL_ID="${POSITIONAL[1]:-}"
NILFS_PATH="${POSITIONAL[2]:-}"

if [[ -z "$FILE_PATH" ]]; then
  usage
  exit 1
fi
if [[ ! -f "$FILE_PATH" ]]; then
  echo "error: file not found: $FILE_PATH" >&2
  exit 1
fi

if [[ "$ALLOW_RAW_KEY_EXPORT" != "1" && -n "$RAW_KEY_OUT" ]]; then
  echo "error: --raw-key-out requires --allow-raw-key-export" >&2
  exit 1
fi

require_cmd jq
require_cmd curl
require_cmd npm

if [[ ! -x "$ROOT_DIR/scripts/enterprise_upload_job.sh" ]]; then
  echo "error: missing executable helper: $ROOT_DIR/scripts/enterprise_upload_job.sh" >&2
  exit 1
fi

export GATEWAY_BASE="${GATEWAY_BASE:-http://localhost:8080}"

if [[ -z "${NIL_FAUCET_AUTH_TOKEN:-}" && -n "${POLYSTORE_TESTNET_FAUCET_AUTH_TOKEN:-}" ]]; then
  export NIL_FAUCET_AUTH_TOKEN="$POLYSTORE_TESTNET_FAUCET_AUTH_TOKEN"
fi
export CHAIN_ID="${CHAIN_ID:-${POLYSTORE_TESTNET_CHAIN_ID:-20260211}}"
export EVM_CHAIN_ID="${EVM_CHAIN_ID:-${POLYSTORE_TESTNET_CHAIN_ID:-20260211}}"
export NIL_NODE="${NIL_NODE:-${POLYSTORE_TESTNET_NODE:-https://rpc.polynomialstore.com}}"
export LCD_BASE
export NIL_GAS_PRICES="${NIL_GAS_PRICES:-${POLYSTORE_TESTNET_GAS_PRICES:-0.001aatom}}"
export NIL_TX_SENDER_KEY="${NIL_TX_SENDER_KEY:-${POLYSTORE_TESTNET_TX_SENDER_KEY:-faucet}}"
export NIL_TX_SENDER_MNEMONIC="${NIL_TX_SENDER_MNEMONIC:-${POLYSTORE_TESTNET_TX_SENDER_MNEMONIC:-}}"
export NIL_TX_SUBMIT_MODE="${NIL_TX_SUBMIT_MODE:-direct}"

if ! curl -fsS "${GATEWAY_BASE}/health" >/dev/null 2>&1; then
  echo "error: local gateway is not healthy at ${GATEWAY_BASE}. Start Nil Gateway GUI before running this helper." >&2
  exit 1
fi

if [[ ! -d "$ROOT_DIR/polystore-website/node_modules" ]]; then
  echo "Installing polystore-website dependencies..."
  npm -C "$ROOT_DIR/polystore-website" install >/dev/null
fi

umask 077

wallet_json="$(cd "$ROOT_DIR/polystore-website" && node_modules/.bin/tsx "$ROOT_DIR/polystore-website/scripts/testnet_burner_wallet.ts" generate)"
PRIVATE_KEY="$(printf '%s' "$wallet_json" | jq -r '.private_key')"
EVM_ADDRESS="$(printf '%s' "$wallet_json" | jq -r '.address')"
NIL_ADDRESS="$(printf '%s' "$wallet_json" | jq -r '.nil_address')"

if [[ -z "$PRIVATE_KEY" || -z "$EVM_ADDRESS" || -z "$NIL_ADDRESS" || "$PRIVATE_KEY" == "null" ]]; then
  echo "error: failed to generate burner wallet" >&2
  exit 1
fi

cleanup() {
  if [[ "${DESTROY_LOCAL_KEY_AFTER_EXPORT:-1}" == "1" ]]; then
    unset PRIVATE_KEY EVM_ADDRESS NIL_ADDRESS KEYSTORE_PASSWORD || true
  fi
}
trap cleanup EXIT

echo "Burner wallet generated for testnet onboarding."
echo "EVM address: $EVM_ADDRESS"
echo "NIL address: $NIL_ADDRESS"

if [[ "$SKIP_FAUCET" != "1" ]]; then
  faucet_auth_token="${!FAUCET_AUTH_ENV:-}"
  faucet_payload="$(printf '{"address":"%s"}' "$NIL_ADDRESS")"

  echo "Requesting faucet funds..."
  faucet_http_code=""
  faucet_body=""
  for attempt in $(seq 1 "$FAUCET_RETRY_ATTEMPTS"); do
    if [[ -n "$faucet_auth_token" ]]; then
      faucet_resp="$(curl -sS -w $'\n%{http_code}' -X POST "$FAUCET_URL" -H "Content-Type: application/json" -H "X-Nil-Faucet-Auth: $faucet_auth_token" --data "$faucet_payload")"
    else
      faucet_resp="$(curl -sS -w $'\n%{http_code}' -X POST "$FAUCET_URL" -H "Content-Type: application/json" --data "$faucet_payload")"
    fi

    faucet_http_code="$(printf '%s' "$faucet_resp" | tail -n1)"
    faucet_body="$(printf '%s' "$faucet_resp" | sed '$d')"
    if [[ "$faucet_http_code" == "200" ]]; then
      break
    fi
    if [[ "$faucet_http_code" != "429" || "$attempt" -ge "$FAUCET_RETRY_ATTEMPTS" ]]; then
      echo "error: faucet request failed (HTTP $faucet_http_code): $faucet_body" >&2
      exit 1
    fi
    echo "Faucet rate limited (attempt $attempt/$FAUCET_RETRY_ATTEMPTS). Retrying in ${FAUCET_RETRY_DELAY_SECS}s..."
    sleep "$FAUCET_RETRY_DELAY_SECS"
  done

  echo "Waiting for balance on LCD..."
  start_ts="$(date +%s)"
  funded=0
  while true; do
    now_ts="$(date +%s)"
    if (( now_ts - start_ts > WAIT_BALANCE_TIMEOUT )); then
      break
    fi
    if balances_json="$(curl -fsS "$LCD_BASE/cosmos/bank/v1beta1/balances/$NIL_ADDRESS" 2>/dev/null)"; then
      nonzero="$(printf '%s' "$balances_json" | jq -r '[.balances[]? | select((.amount|tonumber) > 0)] | length')"
      if [[ "${nonzero:-0}" -gt 0 ]]; then
        funded=1
        break
      fi
    fi
    sleep 2
  done

  if [[ "$funded" != "1" ]]; then
    echo "error: timed out waiting for funded balance on $NIL_ADDRESS" >&2
    exit 1
  fi
fi

echo "Running create/upload/commit via enterprise_upload_job.sh..."
export EVM_PRIVKEY="$PRIVATE_KEY"
if [[ -n "$DEAL_ID" && -n "$NILFS_PATH" ]]; then
  "$ROOT_DIR/scripts/enterprise_upload_job.sh" "$FILE_PATH" "$DEAL_ID" "$NILFS_PATH"
elif [[ -n "$DEAL_ID" ]]; then
  "$ROOT_DIR/scripts/enterprise_upload_job.sh" "$FILE_PATH" "$DEAL_ID"
else
  "$ROOT_DIR/scripts/enterprise_upload_job.sh" "$FILE_PATH"
fi

KEYSTORE_PASSWORD="${!KEYSTORE_PASSWORD_ENV:-}"
if [[ -z "$KEYSTORE_PASSWORD" ]]; then
  read -r -s -p "Enter keystore export password: " KEYSTORE_PASSWORD
  echo
fi
if [[ -z "$KEYSTORE_PASSWORD" ]]; then
  echo "error: keystore password is required" >&2
  exit 1
fi

keystore_json="$(
  cd "$ROOT_DIR/polystore-website"
  KEYSTORE_PASSWORD="$KEYSTORE_PASSWORD" \
  KEYSTORE_OUT="$EXPORT_KEYSTORE" \
  EVM_PRIVKEY="$PRIVATE_KEY" \
  node_modules/.bin/tsx "$ROOT_DIR/polystore-website/scripts/testnet_burner_wallet.ts" export-keystore
)"
KEYSTORE_PATH="$(printf '%s' "$keystore_json" | jq -r '.keystore_path')"

if [[ -z "$KEYSTORE_PATH" || "$KEYSTORE_PATH" == "null" ]]; then
  echo "error: failed to export keystore" >&2
  exit 1
fi

if [[ "$ALLOW_RAW_KEY_EXPORT" == "1" && -n "$RAW_KEY_OUT" ]]; then
  printf '%s\n' "$PRIVATE_KEY" >"$RAW_KEY_OUT"
  chmod 600 "$RAW_KEY_OUT"
  echo "Raw private key written to: $RAW_KEY_OUT"
fi

echo
echo "Testnet burner-key flow complete."
echo "Keystore JSON (MetaMask import): $KEYSTORE_PATH"
echo "Wallet address: $EVM_ADDRESS"
echo "Security note: burner key flow is testnet-only and not for production custody."

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-${POLYSTORE_PUBLIC_HEALTHCHECK_ENV:-/etc/polystore/polystore-public-healthcheck.env}}"

if [[ ! -r "$ENV_FILE" ]]; then
  echo "ERROR: public healthcheck config is not readable: $ENV_FILE" >&2
  exit 2
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

required=(
  POLYSTORE_PUBLIC_RPC_BASE POLYSTORE_PUBLIC_LCD_BASE
  POLYSTORE_PUBLIC_EVM_BASE POLYSTORE_PUBLIC_GATEWAY_BASE
  POLYSTORE_PUBLIC_FAUCET_BASE POLYSTORE_PUBLIC_BROWSER_ORIGIN
  POLYSTORE_EXPECTED_COSMOS_CHAIN_ID POLYSTORE_EXPECTED_EVM_CHAIN_ID
  POLYSTORE_EXPECTED_EIP712_CHAIN_ID POLYSTORE_PRECOMPILE_ADDRESS
  POLYSTORE_EXPECTED_EVM_DENOM
  POLYSTORE_EXPECTED_MIN_PROVIDER_BOND
  POLYSTORE_EXPECTED_PROVIDER_1
)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "ERROR: $name is required in $ENV_FILE" >&2
    exit 2
  fi
done

args=(
  hub --public
  --rpc "$POLYSTORE_PUBLIC_RPC_BASE"
  --lcd "$POLYSTORE_PUBLIC_LCD_BASE"
  --evm "$POLYSTORE_PUBLIC_EVM_BASE"
  --gateway "$POLYSTORE_PUBLIC_GATEWAY_BASE"
  --faucet "$POLYSTORE_PUBLIC_FAUCET_BASE"
  --browser-origin "$POLYSTORE_PUBLIC_BROWSER_ORIGIN"
  --expected-cosmos-chain-id "$POLYSTORE_EXPECTED_COSMOS_CHAIN_ID"
  --expected-evm-chain-id "$POLYSTORE_EXPECTED_EVM_CHAIN_ID"
  --expected-eip712-chain-id "$POLYSTORE_EXPECTED_EIP712_CHAIN_ID"
  --expected-evm-denom "$POLYSTORE_EXPECTED_EVM_DENOM"
  --consensus-profile "${POLYSTORE_RETRIEVAL_CONSENSUS_PROFILE:-$ROOT_DIR/scripts/retrieval_consensus_profile.json}"
  --expected-min-provider-bond "$POLYSTORE_EXPECTED_MIN_PROVIDER_BOND"
  --polystore-precompile "$POLYSTORE_PRECOMPILE_ADDRESS"
  --block-wait "${POLYSTORE_PUBLIC_BLOCK_WAIT:-10}"
  --tls-min-valid-days "${POLYSTORE_TLS_MIN_VALID_DAYS:-7}"
)

for index in 1 2 3 4 5 6 7 8; do
  name="POLYSTORE_EXPECTED_PROVIDER_$index"
  [[ -n "${!name:-}" ]] || continue
  args+=(--expected-provider "${!name}")
done

if [[ -n "${POLYSTORE_PUBLIC_CHAIN_CLI:-}" ]]; then
  args+=(--chain-cli "$POLYSTORE_PUBLIC_CHAIN_CLI")
fi

exec "$ROOT_DIR/scripts/devnet_healthcheck.sh" "${args[@]}"

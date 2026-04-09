#!/usr/bin/env bash
set -euo pipefail

health() {
  local name="$1"
  local url="$2"
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$url" 2>/dev/null || true)"
  code="${code:-000}"
  printf '%-20s %s (%s)\n' "$name" "$url" "$code"
}

echo "PolyStore E2E stack status"
health "gateway" "http://localhost:8080/health"
health "faucet" "http://localhost:8081/faucet"
health "lcd" "http://localhost:1317/cosmos/base/tendermint/v1beta1/node_info"
health "web" "http://localhost:5173/"

for port in 8091 8092 8093 8094 8095 8096 8097 8098 8099 8100 8101 8102; do
  health "provider:$port" "http://localhost:${port}/health"
done

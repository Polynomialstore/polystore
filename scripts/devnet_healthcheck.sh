#!/usr/bin/env bash
#
# Devnet healthcheck (trusted soft launch).
# - Hub mode: validates RPC/LCD/EVM/gateway/faucet are responsive.
# - Provider mode: validates provider gateway is responsive and (optionally) that the hub can see it on-chain.
#
# Local checks are dependency-light. Public qualification requires curl, jq,
# and Python 3 so malformed deployment metadata cannot be silently skipped.

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
  --browser-origin ORIGIN
                   Optional browser origin to use for an EVM JSON-RPC CORS preflight + POST check
  --gateway URL    (default: http://127.0.0.1:8080)
  --faucet URL     (default: http://127.0.0.1:8081)
  --no-faucet      Skip faucet check
  --public         Require the complete public deployment qualification below
  --expected-cosmos-chain-id ID
  --expected-evm-chain-id ID
  --expected-eip712-chain-id ID
  --expected-evm-denom DENOM
  --expected-consensus-max-gas GAS
  --expected-consensus-max-bytes BYTES
  --expected-min-provider-bond COIN
  --expected-provider 'ADDR|HTTPS_BASE|ONCHAIN_MULTIADDR'
                   Repeat once per required provider-daemon
  --block-wait SECONDS
                   Seconds between block-height samples (default: 10)
  --tls-min-valid-days DAYS
                   Fail if a public certificate expires sooner (default: 7)
  --chain-cli PATH  Also verify the installed chain module CLI command surface
  --polystore-precompile ADDRESS
                   Require the PolyStore precompile and call a known view

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
    --browser-origin https://<domain> \
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

lowercase() {
  tr '[:upper:]' '[:lower:]'
}

header_value() {
  local file="$1"
  local name="$2"
  awk -v name="$name" '
    index(tolower($0), tolower(name) ":") == 1 {
      sub(/^[^:]+:[[:space:]]*/, "", $0)
      sub(/\r$/, "", $0)
      print
      exit
    }
  ' "$file"
}

header_list_contains() {
  local value="$1"
  local expected="$2"
  awk -v value="$value" -v expected="$expected" 'BEGIN {
    expected = tolower(expected)
    count = split(value, items, ",")
    for (i = 1; i <= count; i++) {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", items[i])
      if (tolower(items[i]) == expected) exit 0
    }
    exit 1
  }'
}

FAILS=0
LATEST_COMMITTED_HEIGHT=""

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
    catching_up="$(jq -r 'if (.result.sync_info.catching_up | type) == "boolean" then (.result.sync_info.catching_up | tostring) else empty end' <<<"$body" 2>/dev/null || true)"
    if [[ -n "$height" && -n "$catching_up" ]]; then
      ok "RPC status height=$height catching_up=$catching_up"
    else
      fail "RPC status ($url) returned unexpected JSON (missing latest_block_height)"
    fi
  else
    ok "RPC status (jq not installed; JSON parse skipped)"
  fi
}

json_field() {
  local body="$1"
  local expression="$2"
  jq -er "$expression | select(. != null and . != \"\")" <<<"$body" 2>/dev/null
}

require_https_base() {
  local name="$1"
  local base="$2"
  if [[ "$base" != https://* ]]; then
    fail "$name must use HTTPS in public mode: $base"
  fi
}

check_tls_validity() {
  local name="$1"
  local base="$2"
  local days="$3"
  local result
  if ! result="$(python3 - "$base" "$days" "$HC_TIMEOUT" <<'PY'
import datetime
import os
import socket
import ssl
import sys
import urllib.parse

url, days, timeout = sys.argv[1], int(sys.argv[2]), float(sys.argv[3])
parsed = urllib.parse.urlsplit(url)
if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
    raise SystemExit("invalid HTTPS URL")
port = parsed.port or 443
context = ssl.create_default_context()
if os.environ.get("POLYSTORE_TLS_CA_FILE"):
    context.load_verify_locations(cafile=os.environ["POLYSTORE_TLS_CA_FILE"])
with socket.create_connection((parsed.hostname, port), timeout=timeout) as raw:
    with context.wrap_socket(raw, server_hostname=parsed.hostname) as conn:
        not_after = conn.getpeercert().get("notAfter")
        if not not_after:
            raise SystemExit("certificate has no notAfter")
        expires = datetime.datetime.fromtimestamp(
            ssl.cert_time_to_seconds(not_after), datetime.timezone.utc
        )
minimum = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=days)
if expires <= minimum:
    raise SystemExit(f"certificate expires too soon: {expires.isoformat()}")
print(expires.isoformat())
PY
  )"; then
    fail "$name TLS certificate is invalid or expires within $days day(s): $base"
    return
  fi
  ok "$name TLS certificate valid through $result"
}

check_cors_preflight() {
  local name="$1"
  local url="$2"
  local browser_origin="$3"
  local request_method="${4:-POST}"
  local request_headers="${5:-content-type}"
  local headers body status allow_origin allow_methods allow_headers
  headers="$(mktemp)"
  body="$(mktemp)"
  if ! curl -sS --max-time "$HC_TIMEOUT" -D "$headers" -o "$body" -X OPTIONS \
    -H "Origin: $browser_origin" \
    -H "Access-Control-Request-Method: $request_method" \
    -H "Access-Control-Request-Headers: $request_headers" "$url" >/dev/null; then
    rm -f "$headers" "$body"
    fail "$name CORS preflight unreachable: $url"
    return
  fi
  status="$(awk 'NR == 1 { print $2 }' "$headers")"
  allow_origin="$(header_value "$headers" 'Access-Control-Allow-Origin')"
  allow_methods="$(header_value "$headers" 'Access-Control-Allow-Methods')"
  allow_headers="$(header_value "$headers" 'Access-Control-Allow-Headers')"
  rm -f "$headers" "$body"
  if [[ "$status" != "200" && "$status" != "204" ]]; then
    fail "$name CORS preflight expected HTTP 200/204, got ${status:-000}"
  elif [[ "$allow_origin" != "*" && "$allow_origin" != "$browser_origin" ]]; then
    fail "$name CORS preflight missing matching Access-Control-Allow-Origin"
  # Fetch's CORS-preflight algorithm allows safelisted methods without an
  # Allow-Methods entry, even when custom headers trigger the preflight.
  # https://fetch.spec.whatwg.org/#cors-preflight-fetch
  elif [[ "$request_method" != "GET" && "$request_method" != "HEAD" && "$request_method" != "POST" ]] &&
       ! header_list_contains "$allow_methods" "$request_method"; then
    fail "$name CORS preflight missing $request_method"
  elif ! python3 - "$allow_headers" "$request_headers" <<'PY'
import sys

allowed = {item.strip().lower() for item in sys.argv[1].split(",") if item.strip()}
required = {item.strip().lower() for item in sys.argv[2].split(",") if item.strip()}
raise SystemExit(0 if required and required <= allowed else 1)
PY
  then
    fail "$name CORS preflight missing required request headers: $request_headers"
  else
    ok "$name browser CORS origin=$browser_origin"
  fi
}

check_cors_get_response() {
  local name="$1"
  local url="$2"
  local browser_origin="$3"
  local request_header="$4"
  local request_value="$5"
  local exposed_header="$6"
  local headers body status allow_origin expose_headers actual_header
  headers="$(mktemp)"
  body="$(mktemp)"
  if ! curl -sS --max-time "$HC_TIMEOUT" -D "$headers" -o "$body" \
    -H "Origin: $browser_origin" -H "$request_header: $request_value" "$url" >/dev/null; then
    rm -f "$headers" "$body"
    fail "$name browser GET unreachable: $url"
    return
  fi
  status="$(awk 'NR == 1 { print $2 }' "$headers")"
  allow_origin="$(header_value "$headers" 'Access-Control-Allow-Origin')"
  expose_headers="$(header_value "$headers" 'Access-Control-Expose-Headers')"
  actual_header="$(header_value "$headers" "$exposed_header")"
  rm -f "$headers" "$body"
  if [[ "$status" != "200" ]]; then
    fail "$name browser GET expected HTTP 200, got ${status:-000}"
  elif [[ "$allow_origin" != "*" && "$allow_origin" != "$browser_origin" ]]; then
    fail "$name browser GET missing matching Access-Control-Allow-Origin"
  elif ! header_list_contains "$expose_headers" "$exposed_header"; then
    fail "$name browser GET missing exposed response header: $exposed_header"
  elif [[ "$actual_header" != "$request_value" ]]; then
    fail "$name browser GET response header mismatch: requested=$request_value actual=${actual_header:-missing}"
  else
    ok "$name browser GET exposes $exposed_header=$actual_header"
  fi
}

check_chain_cli_surface() {
  local binary="$1"
  local helper module help
  helper="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/chain_cli_helpers.sh"
  if [[ ! -x "$binary" ]]; then
    fail "chain CLI is not executable: $binary"
    return
  fi
  # shellcheck disable=SC1090
  source "$helper"
  if ! module="$(detect_chain_module_cli_name "$binary")"; then
    fail "chain CLI module namespace detection failed: $binary"
    return
  fi
  if ! help="$("$binary" tx "$module" register-provider --help 2>&1)"; then
    fail "chain CLI register-provider help failed (module=$module)"
    return
  fi
  if [[ "$help" != *"--endpoint"* || "$help" != *"--bond"* ]]; then
    fail "chain CLI register-provider lacks required --endpoint/--bond flags (module=$module)"
    return
  fi
  if ! "$binary" tx "$module" update-provider-endpoints --help >/dev/null 2>&1 ||
     ! "$binary" tx "$module" request-provider-link --help >/dev/null 2>&1; then
    fail "chain CLI provider lifecycle commands are incomplete (module=$module)"
    return
  fi
  ok "chain CLI provider lifecycle surface module=$module"
}

check_public_provider_inventory() {
  local body expected actual
  if ! body="$(http_get "$LCD/polystorechain/polystorechain/v1/providers")"; then
    fail "active provider inventory unavailable"
    return
  fi
  expected="$(printf '%s\n' "${EXPECTED_PROVIDERS[@]}" | jq -Rsc 'split("\n")[:-1] | map(split("|")[0]) | sort')"
  # ListProviders returns the complete registry, without pagination. Placement
  # considers every Active, non-draining provider, including unconfigured ones.
  if ! actual="$(jq -ce '
    .providers | select(type == "array") |
    select(all(.[]; (.address | type == "string" and length > 0) and
      (.status | type == "string") and (.draining | type == "boolean"))) |
    select((map(.address) | unique | length) == length) |
    map(select(.status == "Active" and .draining == false) | .address) | sort
  ' <<<"$body")"; then
    fail "active provider inventory is malformed"
  elif [[ "$actual" != "$expected" ]]; then
    fail "active provider inventory mismatch: expected=$expected actual=$actual"
  else
    ok "active provider inventory matches configured placement set"
  fi
}

check_provider_retrieval_handler() {
  local address="$1" base="$2" headers body status allow_origin
  headers="$(mktemp)"
  body="$(mktemp)"
  # A global OPTIONS responder cannot establish that this route exists. A
  # malformed session ID reaches its authorization parser without reading
  # customer data, opening a session, or submitting a transaction.
  if ! curl -sS --max-time "$HC_TIMEOUT" -D "$headers" -o "$body" \
    -H "Origin: $BROWSER_ORIGIN" -H 'X-PolyStore-Session-Id: invalid' \
    -H 'Accept: multipart/form-data; version=2' \
    "$base/sp/retrieval/mdu/0x0000000000000000000000000000000000000000000000000000000000000000/0"; then
    fail "Provider $address retrieval GET unreachable"
  else
    status="$(awk 'NR == 1 { print $2 }' "$headers")"
    allow_origin="$(header_value "$headers" 'Access-Control-Allow-Origin')"
    if [[ "$status" != "400" ]] || ! jq -e '.error == "invalid session_id"' "$body" >/dev/null 2>&1; then
      fail "Provider $address retrieval GET did not return the expected authorization rejection (HTTP ${status:-000})"
    elif [[ "$allow_origin" != "*" && "$allow_origin" != "$BROWSER_ORIGIN" ]]; then
      fail "Provider $address retrieval GET missing matching Access-Control-Allow-Origin"
    else
      ok "Provider $address retrieval GET reaches session authorization"
    fi
  fi
  rm -f "$headers" "$body"
}

check_gateway_upload_handler() {
  local headers body status allow_origin
  headers="$(mktemp)"
  body="$(mktemp)"
  # An invalid deal ID is rejected by RouterGatewayUpload before it resolves a
  # provider or reads/stores a request body. This distinguishes the actual
  # user-gateway route from a global OPTIONS responder or provider daemon.
  if ! curl -sS --max-time "$HC_TIMEOUT" -X POST -D "$headers" -o "$body" \
    -H "Origin: $BROWSER_ORIGIN" -H 'Content-Type: application/octet-stream' \
    --data-binary '' "$GATEWAY/gateway/upload?deal_id=invalid"; then
    fail "Gateway upload POST unreachable"
  else
    status="$(awk 'NR == 1 { print $2 }' "$headers")"
    allow_origin="$(header_value "$headers" 'Access-Control-Allow-Origin')"
    if [[ "$status" != "400" ]] || ! jq -e '.error == "invalid deal_id"' "$body" >/dev/null 2>&1; then
      fail "Gateway upload POST did not return the expected deal validation rejection (HTTP ${status:-000})"
    elif [[ "$allow_origin" != "*" && "$allow_origin" != "$BROWSER_ORIGIN" ]]; then
      fail "Gateway upload POST missing matching Access-Control-Allow-Origin"
    else
      ok "Gateway upload POST reaches user-gateway handler"
    fi
  fi
  rm -f "$headers" "$body"
}

check_public_provider() {
  local spec="$1"
  local address public_base endpoint body status actual_address status_address persona chain_id status_endpoint provider_status draining
  IFS='|' read -r address public_base endpoint <<<"$spec"
  if [[ -z "$address" || -z "$public_base" || -z "$endpoint" ]]; then
    fail "expected provider must be ADDR|HTTPS_BASE|ONCHAIN_MULTIADDR"
    return
  fi
  require_https_base "Provider $address" "$public_base"
  check_tls_validity "Provider $address" "$public_base" "$TLS_MIN_VALID_DAYS"
  check_http_200 "Provider $address public /health" "$public_base/health"
  check_cors_preflight "Provider $address retrieval" \
    "$public_base/sp/retrieval/mdu/0x00/0" "$BROWSER_ORIGIN" GET \
    'X-PolyStore-Session-Id,X-PolyStore-Start-Blob-Index,X-PolyStore-Blob-Count'
  check_provider_retrieval_handler "$address" "$public_base"
  if ! status="$(http_get "$public_base/status")"; then
    fail "Provider $address public /status unreachable"
    return
  fi
  status_address="$(json_field "$status" '.provider.address' || true)"
  persona="$(json_field "$status" '.persona' || true)"
  chain_id="$(json_field "$status" '.provider.chain_id' || true)"
  status_endpoint="$(json_field "$status" '.provider.public_base' || true)"
  if [[ "$status_address" != "$address" || "$persona" != "provider-daemon" || "$chain_id" != "$EXPECTED_COSMOS_CHAIN_ID" ]]; then
    fail "Provider $address public identity mismatch: address=${status_address:-missing} persona=${persona:-missing} chain_id=${chain_id:-missing}"
  elif ! python3 - "$public_base" "$status_endpoint" "$endpoint" <<'PY'
import ipaddress
import re
import sys
import urllib.parse

def canonical(raw):
    p = urllib.parse.urlsplit(raw)
    port = p.port or (443 if p.scheme == "https" else 80)
    return (p.scheme.lower(), (p.hostname or "").lower(), port, p.path.rstrip("/"))

# Require the explicit public HTTPS multiaddr profile; do not duplicate the
# gateway's discovery/override policy in the healthcheck.
match = re.fullmatch(r"/(dns|dns4|dns6|ip4|ip6)/([^/]+)/tcp/([0-9]+)/https", sys.argv[3])
if not match:
    raise SystemExit("expected endpoint must be a public HTTPS multiaddr")
kind, host, port = match.groups()
if kind in ("ip4", "ip6"):
    if ipaddress.ip_address(host).version != int(kind[-1]):
        raise SystemExit("endpoint IP version mismatch")
expected = ("https", host.lower(), int(port), "")
raise SystemExit(0 if canonical(sys.argv[1]) == canonical(sys.argv[2]) == expected else 1)
PY
  then
    fail "Provider $address public /status or configured endpoint differs from qualified public_base: $public_base"
  else
    ok "Provider $address public /status identity and endpoint"
  fi
  if ! body="$(http_get "$LCD/polystorechain/polystorechain/v1/providers/$address")"; then
    fail "Provider $address on-chain record unreachable"
    return
  fi
  actual_address="$(json_field "$body" '.provider.address' || true)"
  provider_status="$(json_field "$body" '.provider.status' || true)"
  draining="$(jq -er 'if (.provider.draining | type) == "boolean" then (.provider.draining | tostring) else empty end' <<<"$body" 2>/dev/null || true)"
  if [[ "$actual_address" != "$address" ]]; then
    fail "Provider identity mismatch: expected $address, got ${actual_address:-missing}"
  elif [[ "$provider_status" != "Active" || "$draining" != "false" ]]; then
    fail "Provider $address is not active and serving: status=${provider_status:-missing} draining=${draining:-missing}"
  elif ! jq -e --arg endpoint "$endpoint" '.provider.endpoints[0] == $endpoint' <<<"$body" >/dev/null 2>&1; then
    fail "Provider $address must advertise qualified endpoint first: $endpoint"
  else
    ok "Provider $address identity and on-chain endpoint"
  fi
  if ! body="$(http_get "$LCD/polystorechain/polystorechain/v1/providers/$address/collateral")"; then
    fail "Provider $address placement eligibility unreachable"
  elif ! jq -e --arg address "$address" '
      .collateral.provider == $address and .collateral.eligible_for_new_assignment == true
    ' <<<"$body" >/dev/null 2>&1; then
    fail "Provider $address is not eligible for new assignments"
  else
    ok "Provider $address eligible for new assignments"
  fi
}

check_public_identity_and_progress() {
  local rpc_first rpc_second lcd_info params evm_params consensus_params denom_metadata evm_body
  local rpc_chain lcd_chain catching first_height second_height evm_hex evm_decimal eip712 v2_height max_gas max_bytes denom
  local bond_amount bond_denom expected_bond_amount expected_bond_denom
  if ! rpc_first="$(http_get "$RPC/status")" || ! lcd_info="$(http_get "$LCD/cosmos/base/tendermint/v1beta1/node_info")" ||
     ! params="$(http_get "$LCD/polystorechain/polystorechain/v1/params")" ||
     ! evm_params="$(http_get "$LCD/cosmos/evm/vm/v1/params")" ||
     ! consensus_params="$(http_get "$LCD/cosmos/consensus/v1/params")" ||
     ! denom_metadata="$(http_get "$LCD/cosmos/bank/v1beta1/denoms_metadata/$EXPECTED_EVM_DENOM")" ||
     ! evm_body="$(curl -fsS --max-time "$HC_TIMEOUT" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$EVM")"; then
    fail "public chain identity endpoints are unreachable"
    return
  fi
  rpc_chain="$(json_field "$rpc_first" '.result.node_info.network' || true)"
  lcd_chain="$(json_field "$lcd_info" '.default_node_info.network // .node_info.network' || true)"
  catching="$(jq -er 'if (.result.sync_info.catching_up | type) == "boolean" then (.result.sync_info.catching_up | tostring) else empty end' <<<"$rpc_first" 2>/dev/null || true)"
  first_height="$(json_field "$rpc_first" '.result.sync_info.latest_block_height' || true)"
  evm_hex="$(json_field "$evm_body" '.result' || true)"
  eip712="$(json_field "$params" '.params.eip712_chain_id' || true)"
  v2_height="$(json_field "$params" '.params.retrieval_v2_activation_height' || true)"
  max_gas="$(json_field "$consensus_params" '.params.block.max_gas' || true)"
  max_bytes="$(json_field "$consensus_params" '.params.block.max_bytes' || true)"
  denom="$(json_field "$evm_params" '.params.evm_denom' || true)"
  bond_amount="$(json_field "$params" '.params.min_provider_bond.amount' || true)"
  bond_denom="$(json_field "$params" '.params.min_provider_bond.denom' || true)"
  expected_bond_amount="${EXPECTED_MIN_PROVIDER_BOND%%[!0-9]*}"
  expected_bond_denom="${EXPECTED_MIN_PROVIDER_BOND#"$expected_bond_amount"}"
  if [[ "$rpc_chain" != "$EXPECTED_COSMOS_CHAIN_ID" || "$lcd_chain" != "$EXPECTED_COSMOS_CHAIN_ID" ]]; then
    fail "Cosmos chain identity mismatch: expected=$EXPECTED_COSMOS_CHAIN_ID rpc=${rpc_chain:-missing} lcd=${lcd_chain:-missing}"
  fi
  if [[ "$catching" != "false" ]]; then
    fail "RPC catching_up must be false, got ${catching:-missing}"
  fi
  if [[ "$evm_hex" =~ ^0[xX][0-9a-fA-F]+$ ]]; then
    evm_decimal="$((evm_hex))"
  else
    evm_decimal=""
  fi
  if [[ "$evm_decimal" != "$EXPECTED_EVM_CHAIN_ID" ]]; then
    fail "EVM chain identity mismatch: expected=$EXPECTED_EVM_CHAIN_ID got=${evm_hex:-missing}"
  fi
  if [[ "$eip712" != "$EXPECTED_EIP712_CHAIN_ID" || "$EXPECTED_EIP712_CHAIN_ID" != "$EXPECTED_EVM_CHAIN_ID" ]]; then
    fail "EIP-712 chain identity mismatch: expected=$EXPECTED_EIP712_CHAIN_ID params=${eip712:-missing} evm=$EXPECTED_EVM_CHAIN_ID"
  fi
  if [[ "$denom" != "$EXPECTED_EVM_DENOM" ]] ||
     ! jq -e --arg denom "$EXPECTED_EVM_DENOM" '.metadata.base == $denom' <<<"$denom_metadata" >/dev/null 2>&1; then
    fail "EVM denom metadata mismatch: expected=$EXPECTED_EVM_DENOM evm=${denom:-missing}"
  fi
  if [[ ! "$v2_height" =~ ^[0-9]+$ || "$v2_height" -le 0 || ! "$first_height" =~ ^[0-9]+$ || "$first_height" -lt "$v2_height" ]]; then
    fail "retrieval v2 is not active: activation=${v2_height:-missing} height=${first_height:-missing}"
  fi
  if [[ "$max_gas" != "$EXPECTED_CONSENSUS_MAX_GAS" || "$max_bytes" != "$EXPECTED_CONSENSUS_MAX_BYTES" ]]; then
    fail "consensus block limits mismatch: expected gas=$EXPECTED_CONSENSUS_MAX_GAS bytes=$EXPECTED_CONSENSUS_MAX_BYTES got gas=${max_gas:-missing} bytes=${max_bytes:-missing}"
  fi
  if [[ -z "$expected_bond_amount" || -z "$expected_bond_denom" || "$bond_amount" != "$expected_bond_amount" || "$bond_denom" != "$expected_bond_denom" ]]; then
    fail "minimum provider bond mismatch: expected=$EXPECTED_MIN_PROVIDER_BOND got=${bond_amount:-missing}${bond_denom:-missing}"
  fi
  if ! jq -e --arg address "$(printf '%s' "$POLYSTORE_PRECOMPILE" | lowercase)" '
      [.params.active_static_precompiles[]? | ascii_downcase] | index($address) != null
    ' <<<"$evm_params" >/dev/null 2>&1; then
    fail "required EVM precompile is inactive: $POLYSTORE_PRECOMPILE"
  else
    ok "required EVM precompile active: $POLYSTORE_PRECOMPILE"
  fi
  sleep "$BLOCK_WAIT"
  if ! rpc_second="$(http_get "$RPC/status")"; then
    fail "RPC status unreachable for second block sample"
    return
  fi
  second_height="$(json_field "$rpc_second" '.result.sync_info.latest_block_height' || true)"
  LATEST_COMMITTED_HEIGHT="$second_height"
  if [[ ! "$first_height" =~ ^[0-9]+$ || ! "$second_height" =~ ^[0-9]+$ || "$second_height" -le "$first_height" ]]; then
    fail "chain did not advance during ${BLOCK_WAIT}s sample: first=${first_height:-missing} second=${second_height:-missing}"
  else
    ok "public chain identity Cosmos=$rpc_chain EVM=$evm_decimal EIP712=$eip712; blocks advanced $first_height->$second_height"
  fi
}

check_polystore_precompile_view() {
  local address="$1"
  # The empty input has one exact, implementation-defined revert. Matching the
  # selector, code, message, and ABI Error(string) data proves dispatch reached
  # the native precompile; eth_getCode is empty for native precompiles.
  local calldata expected_error_data request body code message error_data
  calldata="0x4b86a8e1$(printf '%064x' 32)$(printf '%064x' 0)"
  expected_error_data="0x08c379a0$(printf '%064x' 32)$(printf '%064x' 45)636f6d7075746552657472696576616c53657373696f6e4964733a2073657373696f6e7320697320656d707479$(printf '%038s' '' | tr ' ' 0)"
  request="$(jq -cn --arg to "$address" --arg data "$calldata" '{jsonrpc:"2.0",id:1,method:"eth_call",params:[{to:$to,data:$data},"latest"]}')"
  if ! body="$(curl -fsS --max-time "$HC_TIMEOUT" -H 'content-type: application/json' -d "$request" "$EVM")"; then
    fail "PolyStore precompile view call is unreachable: $address"
    return
  fi
  code="$(jq -er '.error.code' <<<"$body" 2>/dev/null || true)"
  message="$(jq -er '.error.message' <<<"$body" 2>/dev/null || true)"
  error_data="$(jq -er '.error.data' <<<"$body" 2>/dev/null || true)"
  if [[ "$code" != "3" || "$message" != "execution reverted: computeRetrievalSessionIds: sessions is empty" ||
        "$(printf '%s' "$error_data" | lowercase)" != "$expected_error_data" ]]; then
    fail "PolyStore precompile semantic probe returned unexpected response at $address"
  else
    ok "PolyStore precompile semantic probe matched computeRetrievalSessionIds empty-input ABI error"
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
    fail "PolyStore Chain params ($url) unreachable"
    return
  fi

  if have_cmd jq; then
    local dyn storage retrieval
    dyn="$(jq -r '.params.dynamic_pricing_enabled // empty' <<<"$body" 2>/dev/null || true)"
    storage="$(jq -r '.params.storage_price // empty' <<<"$body" 2>/dev/null || true)"
    retrieval="$(jq -r '.params.retrieval_price_per_blob // empty' <<<"$body" 2>/dev/null || true)"
    if [[ -n "$storage" && -n "$retrieval" ]]; then
      ok "PolyStore Chain params dynamic_pricing_enabled=$dyn storage_price=$storage retrieval_price_per_blob=$retrieval"
    else
      ok "PolyStore Chain params (jq parse partial; raw JSON fetched)"
    fi
  else
    ok "PolyStore Chain params (jq not installed; JSON parse skipped)"
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

check_evm_cors() {
  local evm_base="$1"
  local browser_origin="$2"
  local preflight_headers preflight_body preflight_status allow_origin allow_methods allow_headers
  local post_headers post_body post_status post_allow_origin chain_id
  preflight_headers="$(mktemp)"
  preflight_body="$(mktemp)"
  post_headers="$(mktemp)"
  post_body="$(mktemp)"

  if ! curl -sS --max-time "$HC_TIMEOUT" \
    -D "$preflight_headers" \
    -o "$preflight_body" \
    -X OPTIONS \
    -H "Origin: $browser_origin" \
    -H 'Access-Control-Request-Method: POST' \
    -H 'Access-Control-Request-Headers: content-type' \
    "$evm_base" >/dev/null; then
    rm -f "$preflight_headers" "$preflight_body" "$post_headers" "$post_body"
    fail "EVM CORS preflight ($evm_base, origin=$browser_origin) unreachable"
    return
  fi

  preflight_status="$(awk 'NR == 1 { print $2 }' "$preflight_headers")"
  allow_origin="$(header_value "$preflight_headers" 'Access-Control-Allow-Origin')"
  allow_methods="$(header_value "$preflight_headers" 'Access-Control-Allow-Methods')"
  allow_headers="$(header_value "$preflight_headers" 'Access-Control-Allow-Headers')"

  if [[ "$preflight_status" != "200" && "$preflight_status" != "204" ]]; then
    rm -f "$preflight_headers" "$preflight_body" "$post_headers" "$post_body"
    fail "EVM CORS preflight ($evm_base) expected HTTP 200/204, got ${preflight_status:-000}"
    return
  fi

  if [[ "$allow_origin" != "*" && "$allow_origin" != "$browser_origin" ]]; then
    rm -f "$preflight_headers" "$preflight_body" "$post_headers" "$post_body"
    fail "EVM CORS preflight ($evm_base) missing matching Access-Control-Allow-Origin for $browser_origin"
    return
  fi

  if [[ "$(printf '%s' "$allow_methods" | lowercase)" != *post* ]]; then
    rm -f "$preflight_headers" "$preflight_body" "$post_headers" "$post_body"
    fail "EVM CORS preflight ($evm_base) missing POST in Access-Control-Allow-Methods"
    return
  fi

  if [[ "$(printf '%s' "$allow_headers" | lowercase)" != *content-type* ]]; then
    rm -f "$preflight_headers" "$preflight_body" "$post_headers" "$post_body"
    fail "EVM CORS preflight ($evm_base) missing content-type in Access-Control-Allow-Headers"
    return
  fi

  if ! curl -sS --max-time "$HC_TIMEOUT" \
    -D "$post_headers" \
    -o "$post_body" \
    -H "Origin: $browser_origin" \
    -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
    "$evm_base" >/dev/null; then
    rm -f "$preflight_headers" "$preflight_body" "$post_headers" "$post_body"
    fail "EVM CORS POST ($evm_base, origin=$browser_origin) unreachable"
    return
  fi

  post_status="$(awk 'NR == 1 { print $2 }' "$post_headers")"
  post_allow_origin="$(header_value "$post_headers" 'Access-Control-Allow-Origin')"

  if [[ "$post_status" != "200" ]]; then
    rm -f "$preflight_headers" "$preflight_body" "$post_headers" "$post_body"
    fail "EVM CORS POST ($evm_base) expected HTTP 200, got ${post_status:-000}"
    return
  fi

  if [[ "$post_allow_origin" != "*" && "$post_allow_origin" != "$browser_origin" ]]; then
    rm -f "$preflight_headers" "$preflight_body" "$post_headers" "$post_body"
    fail "EVM CORS POST ($evm_base) missing matching Access-Control-Allow-Origin for $browser_origin"
    return
  fi

  if have_cmd jq; then
    chain_id="$(jq -r '.result // empty' <"$post_body" 2>/dev/null || true)"
    if [[ -z "$chain_id" ]]; then
      rm -f "$preflight_headers" "$preflight_body" "$post_headers" "$post_body"
      fail "EVM CORS POST ($evm_base) returned unexpected JSON (missing .result)"
      return
    fi
    ok "EVM browser CORS origin=$browser_origin chain_id=$chain_id"
  else
    ok "EVM browser CORS origin=$browser_origin"
  fi

  rm -f "$preflight_headers" "$preflight_body" "$post_headers" "$post_body"
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
BROWSER_ORIGIN=""
PUBLIC_MODE=0
EXPECTED_COSMOS_CHAIN_ID=""
EXPECTED_EVM_CHAIN_ID=""
EXPECTED_EIP712_CHAIN_ID=""
EXPECTED_EVM_DENOM=""
EXPECTED_CONSENSUS_MAX_GAS=""
EXPECTED_CONSENSUS_MAX_BYTES=""
EXPECTED_MIN_PROVIDER_BOND=""
EXPECTED_PROVIDERS=()
POLYSTORE_PRECOMPILE=""
BLOCK_WAIT=10
TLS_MIN_VALID_DAYS=7
CHAIN_CLI=""

PROVIDER="$PROVIDER_DEFAULT"
HUB_LCD=""
PROVIDER_ADDR=""
PROVIDER_PUBLIC=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rpc) RPC="$2"; shift 2 ;;
    --lcd) LCD="$2"; shift 2 ;;
    --evm) EVM="$2"; shift 2 ;;
    --browser-origin) BROWSER_ORIGIN="$2"; shift 2 ;;
    --gateway) GATEWAY="$2"; shift 2 ;;
    --faucet) FAUCET="$2"; CHECK_FAUCET=1; shift 2 ;;
    --no-faucet) CHECK_FAUCET=0; shift ;;
    --public) PUBLIC_MODE=1; shift ;;
    --expected-cosmos-chain-id) EXPECTED_COSMOS_CHAIN_ID="$2"; shift 2 ;;
    --expected-evm-chain-id) EXPECTED_EVM_CHAIN_ID="$2"; shift 2 ;;
    --expected-eip712-chain-id) EXPECTED_EIP712_CHAIN_ID="$2"; shift 2 ;;
    --expected-evm-denom) EXPECTED_EVM_DENOM="$2"; shift 2 ;;
    --expected-consensus-max-gas) EXPECTED_CONSENSUS_MAX_GAS="$2"; shift 2 ;;
    --expected-consensus-max-bytes) EXPECTED_CONSENSUS_MAX_BYTES="$2"; shift 2 ;;
    --expected-min-provider-bond) EXPECTED_MIN_PROVIDER_BOND="$2"; shift 2 ;;
    --expected-provider) EXPECTED_PROVIDERS+=("$2"); shift 2 ;;
    --polystore-precompile) POLYSTORE_PRECOMPILE="$2"; shift 2 ;;
    --block-wait) BLOCK_WAIT="$2"; shift 2 ;;
    --tls-min-valid-days) TLS_MIN_VALID_DAYS="$2"; shift 2 ;;
    --chain-cli) CHAIN_CLI="$2"; shift 2 ;;
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

if [[ ! "$HC_TIMEOUT" =~ ^[1-9][0-9]*$ || ! "$BLOCK_WAIT" =~ ^[1-9][0-9]*$ ||
      ! "$TLS_MIN_VALID_DAYS" =~ ^[0-9]+$ ]]; then
  echo "ERROR: timeout and block-wait must be positive integers; tls-min-valid-days must be a non-negative integer" >&2
  exit 2
fi

if [[ "$PUBLIC_MODE" == "1" ]]; then
  require_cmd jq
  require_cmd python3
  if [[ "$MODE" != "hub" || -z "$BROWSER_ORIGIN" || -z "$EXPECTED_COSMOS_CHAIN_ID" ||
        -z "$EXPECTED_EVM_CHAIN_ID" || -z "$EXPECTED_EIP712_CHAIN_ID" || -z "$EXPECTED_EVM_DENOM" ||
        -z "$EXPECTED_CONSENSUS_MAX_GAS" || -z "$EXPECTED_CONSENSUS_MAX_BYTES" ||
        -z "$EXPECTED_MIN_PROVIDER_BOND" ||
        "${#EXPECTED_PROVIDERS[@]}" -eq 0 || -z "$POLYSTORE_PRECOMPILE" ||
        "$CHECK_FAUCET" != "1" ]]; then
    echo "ERROR: --public hub mode requires browser origin, all three expected chain IDs, at least one provider, one required EVM precompile, and faucet" >&2
    exit 2
  fi
fi

RPC="$(trim_trailing_slash "$RPC")"
LCD="$(trim_trailing_slash "$LCD")"
EVM="$(trim_trailing_slash "$EVM")"
GATEWAY="$(trim_trailing_slash "$GATEWAY")"
FAUCET="$(trim_trailing_slash "$FAUCET")"
BROWSER_ORIGIN="$(trim_trailing_slash "$BROWSER_ORIGIN")"
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
  if [[ -n "$BROWSER_ORIGIN" ]]; then
    check_evm_cors "$EVM" "$BROWSER_ORIGIN"
  else
    ok "EVM browser CORS check skipped"
  fi
  check_gateway_health "$GATEWAY"
  if [[ "$CHECK_FAUCET" == "1" ]]; then
    check_faucet_health "$FAUCET"
  else
    ok "Faucet check skipped"
  fi
  if [[ "$PUBLIC_MODE" == "1" ]]; then
    for public_endpoint in "RPC|$RPC" "LCD|$LCD" "EVM|$EVM" "Gateway|$GATEWAY" "Faucet|$FAUCET"; do
      IFS='|' read -r endpoint_name endpoint_base <<<"$public_endpoint"
      require_https_base "$endpoint_name" "$endpoint_base"
      check_tls_validity "$endpoint_name" "$endpoint_base" "$TLS_MIN_VALID_DAYS"
    done
    check_public_identity_and_progress
    check_polystore_precompile_view "$POLYSTORE_PRECOMPILE"
    check_cors_preflight "LCD committed query" \
      "$LCD/polystorechain/polystorechain/v1/params" "$BROWSER_ORIGIN" GET \
      'x-cosmos-block-height'
    check_cors_get_response "LCD committed query" \
      "$LCD/polystorechain/polystorechain/v1/params" "$BROWSER_ORIGIN" \
      'x-cosmos-block-height' "$LATEST_COMMITTED_HEIGHT" 'x-cosmos-block-height'
    check_cors_preflight "Gateway" "$GATEWAY/gateway/upload" "$BROWSER_ORIGIN"
    check_gateway_upload_handler
    check_cors_preflight "Faucet" "$FAUCET/faucet" "$BROWSER_ORIGIN"
    check_public_provider_inventory
    for expected_provider in "${EXPECTED_PROVIDERS[@]}"; do
      check_public_provider "$expected_provider"
    done
  fi
  if [[ -n "$CHAIN_CLI" ]]; then
    check_chain_cli_surface "$CHAIN_CLI"
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

#!/usr/bin/env bash
set -euo pipefail

TOKEN_ENV_FILE="${POLYSTORE_CERT_TOKEN_ENV_FILE:-$HOME/.config/polystore-bench/cloudflare.env}"
LEGO_BIN="${POLYSTORE_LEGO_BIN:-$HOME/.local/bin/lego}"
LEGO_PATH="${POLYSTORE_LEGO_PATH:-$HOME/.config/polystore-bench/lego}"
LEGO_EMAIL="${POLYSTORE_LEGO_EMAIL:-}"
CERT_NAME="${POLYSTORE_CERT_NAME:-sp1.polynomialstore.com}"
CERT_DOMAINS="${POLYSTORE_CERT_DOMAINS:-sp1.polynomialstore.com sp2.polynomialstore.com sp3.polynomialstore.com}"
RENEW_DAYS="${POLYSTORE_CERT_RENEW_DAYS:-30}"
SETFACL_BIN="${POLYSTORE_SETFACL_BIN:-/usr/bin/setfacl}"
CADDY_BIN="${POLYSTORE_CADDY_BIN:-/usr/bin/caddy}"
CADDY_CONFIG="${POLYSTORE_CADDY_CONFIG:-/etc/caddy/Caddyfile}"
CADDY_USER="${POLYSTORE_CADDY_USER:-caddy}"

for binary in "$LEGO_BIN" "$SETFACL_BIN" "$CADDY_BIN"; do
  [[ -x "$binary" ]] || { echo "ERROR: required executable missing: $binary" >&2; exit 127; }
done
[[ -r "$TOKEN_ENV_FILE" ]] || { echo "ERROR: token environment is not readable: $TOKEN_ENV_FILE" >&2; exit 2; }
[[ -r "$CADDY_CONFIG" ]] || { echo "ERROR: Caddy config is not readable: $CADDY_CONFIG" >&2; exit 2; }
[[ -n "$LEGO_EMAIL" ]] || { echo "ERROR: POLYSTORE_LEGO_EMAIL is required" >&2; exit 2; }
token_mode="$(python3 - "$TOKEN_ENV_FILE" <<'PY'
import os
import stat
import sys
print(oct(stat.S_IMODE(os.stat(sys.argv[1]).st_mode))[2:])
PY
)"
if [[ "$token_mode" != "600" ]]; then
  echo "ERROR: token environment must have mode 600: $TOKEN_ENV_FILE" >&2
  exit 2
fi

set -a
# shellcheck disable=SC1090
source "$TOKEN_ENV_FILE"
set +a

# lego's Cloudflare provider reads the documented DNS token names. Preserve
# compatibility with the existing single-token deployment file while also
# accepting a least-privilege split DNS/zone token pair.
dns_api_token="${CLOUDFLARE_DNS_API_TOKEN:-${CF_DNS_API_TOKEN:-${CLOUDFLARE_API_TOKEN:-}}}"
zone_api_token="${CLOUDFLARE_ZONE_API_TOKEN:-${CF_ZONE_API_TOKEN:-}}"
[[ -n "$dns_api_token" ]] || {
  echo "ERROR: CLOUDFLARE_DNS_API_TOKEN (or CF_DNS_API_TOKEN) is required in token environment" >&2
  exit 2
}
export CLOUDFLARE_DNS_API_TOKEN="$dns_api_token"
if [[ -n "$zone_api_token" ]]; then
  export CLOUDFLARE_ZONE_API_TOKEN="$zone_api_token"
fi

domain_args=()
for domain in $CERT_DOMAINS; do
  domain_args+=(--domains "$domain")
done
[[ "${#domain_args[@]}" -gt 0 ]] || { echo "ERROR: no certificate domains configured" >&2; exit 2; }

"$LEGO_BIN" \
  --path "$LEGO_PATH" \
  --email "$LEGO_EMAIL" \
  --dns cloudflare \
  "${domain_args[@]}" \
  renew --days "$RENEW_DAYS" --no-random-sleep

cert="$LEGO_PATH/certificates/$CERT_NAME.crt"
key="$LEGO_PATH/certificates/$CERT_NAME.key"
[[ -r "$cert" && -r "$key" ]] || { echo "ERROR: renewed certificate/key missing" >&2; exit 1; }
chmod 600 "$key"
"$SETFACL_BIN" -m "u:$CADDY_USER:r" "$cert" "$key"
"$CADDY_BIN" reload --config "$CADDY_CONFIG" --force
echo "OK: provider certificate renewal and Caddy reload completed"

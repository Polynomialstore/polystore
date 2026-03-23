#!/usr/bin/env bash
# Fast browser-only sparse upload proof:
# - starts the website dev server with gateway disabled
# - runs the focused Playwright proof that asserts sparse + parallel uploads

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_PORT="${WEB_PORT:-5173}"
DEV_PID=""

cleanup() {
  if [[ -n "${DEV_PID}" ]]; then
    kill "${DEV_PID}" >/dev/null 2>&1 || true
    wait "${DEV_PID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

wait_for_http() {
  local name="$1"
  local url="$2"
  local max_attempts="${3:-60}"
  local delay_secs="${4:-1}"

  echo "==> Waiting for $name at $url ..."
  for attempt in $(seq 1 "$max_attempts"); do
    local code
    code=$(timeout 10s curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" 2>/dev/null || true)
    code="${code:-000}"
    if [ "$code" != "000" ]; then
      echo "    $name reachable (HTTP $code) after $attempt attempt(s)."
      return 0
    fi
    sleep "$delay_secs"
  done

  echo "ERROR: $name at $url not reachable" >&2
  return 1
}

export VITE_E2E=1
export VITE_ENABLE_FAUCET=1
export VITE_DISABLE_GATEWAY=1

echo "==> Starting website dev server (browser-only sparse proof)..."
(
  cd "$ROOT_DIR/nil-website"
  npm run dev -- --host 127.0.0.1 --port "$WEB_PORT"
) &
DEV_PID=$!

wait_for_http "web" "http://127.0.0.1:${WEB_PORT}/"

echo "==> Running sparse browser upload proof..."
(cd "$ROOT_DIR/nil-website" && npm run test:e2e:sparse-browser)

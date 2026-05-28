#!/usr/bin/env bash
set -euo pipefail

DEVNET_USER="${POLYSTORE_DEVNET_USER:-${SUDO_USER:-}}"
TARGET_ROOT="${TARGET_ROOT:-/opt/polystore}"
CHAIN_STATE_ROOT="${CHAIN_STATE_ROOT:-/var/lib/polystore}"
SUDOERS_FILE="${SUDOERS_FILE:-/etc/sudoers.d/polystore-devnet-systemctl}"
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-$(command -v systemctl)}"

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run this script with sudo/root." >&2
  echo "       Example: sudo $0" >&2
  exit 1
fi

if [ -z "$DEVNET_USER" ]; then
  echo "ERROR: devnet user is required." >&2
  echo "       Run via sudo as the target user or set POLYSTORE_DEVNET_USER=<user>." >&2
  exit 1
fi

if ! id "$DEVNET_USER" >/dev/null 2>&1; then
  echo "ERROR: devnet user does not exist: $DEVNET_USER" >&2
  exit 1
fi

if [ -z "$SYSTEMCTL_BIN" ] || [ ! -x "$SYSTEMCTL_BIN" ]; then
  echo "ERROR: systemctl not found or not executable." >&2
  exit 1
fi

if ! command -v visudo >/dev/null 2>&1; then
  echo "ERROR: visudo is required to validate sudoers changes." >&2
  exit 1
fi

echo "==> Granting $DEVNET_USER ownership of devnet install/state paths"
install -d -o "$DEVNET_USER" -g "$DEVNET_USER" "$TARGET_ROOT" "$TARGET_ROOT/backups" "$CHAIN_STATE_ROOT"
chown -R "$DEVNET_USER:$DEVNET_USER" "$TARGET_ROOT" "$CHAIN_STATE_ROOT"
chmod -R u+rwX,go+rX "$TARGET_ROOT"
chmod -R u+rwX,go-rwx "$CHAIN_STATE_ROOT"

tmp_sudoers="$(mktemp)"
cleanup() {
  rm -f "$tmp_sudoers"
}
trap cleanup EXIT

cat >"$tmp_sudoers" <<EOF
Defaults:$DEVNET_USER !requiretty
$DEVNET_USER ALL=(root) NOPASSWD: $SYSTEMCTL_BIN start polystorechaind.service, $SYSTEMCTL_BIN stop polystorechaind.service, $SYSTEMCTL_BIN restart polystorechaind.service, $SYSTEMCTL_BIN is-active polystorechaind.service
$DEVNET_USER ALL=(root) NOPASSWD: $SYSTEMCTL_BIN start polystore-faucet.service, $SYSTEMCTL_BIN stop polystore-faucet.service, $SYSTEMCTL_BIN restart polystore-faucet.service, $SYSTEMCTL_BIN is-active polystore-faucet.service
$DEVNET_USER ALL=(root) NOPASSWD: $SYSTEMCTL_BIN start polystore-gateway-router.service, $SYSTEMCTL_BIN stop polystore-gateway-router.service, $SYSTEMCTL_BIN restart polystore-gateway-router.service, $SYSTEMCTL_BIN is-active polystore-gateway-router.service
EOF

echo "==> Installing narrow sudoers allowlist at $SUDOERS_FILE"
install -m 0440 "$tmp_sudoers" "$SUDOERS_FILE"
visudo -cf "$SUDOERS_FILE"

echo "==> Verifying passwordless service control for $DEVNET_USER"
runuser -u "$DEVNET_USER" -- sudo -n -l "$SYSTEMCTL_BIN" start polystorechaind.service >/dev/null
runuser -u "$DEVNET_USER" -- sudo -n -l "$SYSTEMCTL_BIN" stop polystorechaind.service >/dev/null
runuser -u "$DEVNET_USER" -- sudo -n -l "$SYSTEMCTL_BIN" start polystore-faucet.service >/dev/null
runuser -u "$DEVNET_USER" -- sudo -n -l "$SYSTEMCTL_BIN" stop polystore-faucet.service >/dev/null
runuser -u "$DEVNET_USER" -- sudo -n -l "$SYSTEMCTL_BIN" start polystore-gateway-router.service >/dev/null
runuser -u "$DEVNET_USER" -- sudo -n -l "$SYSTEMCTL_BIN" stop polystore-gateway-router.service >/dev/null

echo "DONE: $DEVNET_USER can update $TARGET_ROOT and $CHAIN_STATE_ROOT and restart PolyStore root services with sudo -n systemctl."
echo "NOTE: systemctl status is intentionally not granted; update scripts read status without sudo."

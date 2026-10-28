# Upgrade the user-managed Cloudflare tunnel

The hub tunnel carries public RPC, LCD, EVM, user-gateway, and faucet traffic.
The provider hostnames use direct HTTPS through Caddy; their tunnel is an
inactive fallback. See [the direct HTTPS runbook](DIRECT_SP_HTTPS_RUNBOOK.md).

Check the service's executable, rather than relying on the interactive shell's
`cloudflared version`. The two can point at different installations:

```bash
systemctl --user show cloudflared-hub.service -p ExecStart -p MainPID
cloudflared version
```

## Install a verified release without root

Read the [official latest release](https://github.com/cloudflare/cloudflared/releases/latest)
and select the matching architecture. Compare the asset's SHA-256 with both
the release notes and the GitHub release asset digest before executing it.
Do not disable TLS verification when downloading.

On 2026-10-28, the latest release is
[2026.10.5](https://github.com/cloudflare/cloudflared/releases/tag/2026.10.5).
This example pins its Linux AMD64 asset. For a later release, update the
version and independently obtain its checksum from the official release.

Run from the repository root, with the `/mnt/fast4tb` mount available and writable:

```bash
set -euo pipefail
mountpoint -q /mnt/fast4tb
test -w /mnt/fast4tb
export TMPDIR=/mnt/fast4tb/polystore-cloudflared-upgrade/tmp
mkdir -p "$TMPDIR" "$HOME/.local/bin"
staged_binary="$(mktemp "$TMPDIR/cloudflared.XXXXXXXX")"
curl -fL --proto '=https' --proto-redir '=https' \
  https://github.com/cloudflare/cloudflared/releases/download/2026.10.5/cloudflared-linux-amd64 \
  -o "$staged_binary"
printf '%s  %s\n' \
  e1bc0cf084fd9e590554fe769a86b1db46701c3f847a43d902f7b974a4e16298 \
  "$staged_binary" | sha256sum -c -
chmod 755 "$staged_binary"
"$staged_binary" version
# Stage beside the destination so the final rename is atomic.
install -m 755 "$staged_binary" "$HOME/.local/bin/cloudflared.new"
mv -f "$HOME/.local/bin/cloudflared.new" "$HOME/.local/bin/cloudflared"
```

Back up existing local units and overrides before installing the optional
drop-ins. These override the executable path and survive copying a new base
unit from the repository. An unused root-owned `/usr/local/bin/cloudflared`
may still exist; these user services will use the verified user binary.

```bash
for unit in cloudflared-hub.service cloudflared-providers.service; do
  mkdir -p "$HOME/.config/systemd/user/$unit.d"
  cp "ops/systemd/$unit.d/20-user-binary.conf" \
    "$HOME/.config/systemd/user/$unit.d/20-user-binary.conf"
done
"$HOME/.local/bin/cloudflared" --config \
  "$HOME/.config/cloudflared/hub.polynomialstore.com.user.yml" tunnel ingress validate
"$HOME/.local/bin/cloudflared" --config \
  "$HOME/.config/cloudflared/providers.polynomialstore.com.yml" tunnel ingress validate
systemctl --user daemon-reload
systemctl --user enable cloudflared-hub.service
systemctl --user restart cloudflared-hub.service
```

Restart any other tunnel services that were already active so they load the
new executable. Leave the provider fallback inactive while direct HTTPS is
primary. A single hub connector restart briefly interrupts tunnel traffic.
Confirm `loginctl show-user "$USER" -p Linger --value` returns `yes` so enabled
user services run after logout and start at boot.

## Verify public service after the restart

```bash
systemctl --user show cloudflared-hub.service \
  -p ExecStart -p MainPID -p ActiveState -p UnitFileState -p Restart
journalctl --user -u cloudflared-hub.service --since '5 minutes ago' --no-pager
scripts/run_public_devnet_healthcheck.sh \
  ops/systemd/env/polystore-public-healthcheck.env
```

The current process's startup log must report the selected version and
registered tunnel connections. The public check validates advancing blocks,
chain identities, browser access, TLS expiry, provider identity, and placement
eligibility. Enable its existing five-minute timer using the
[systemd instructions](../../ops/systemd/README.md#public-qualification-and-provider-certificate-renewal).

Passing public qualification does not certify stored data or resolve pending
audit transactions. Inspect provider `/status` liveness errors and deal repair
state separately. Preserve unresolved audit records until their original
transaction outcomes or matching committed coverage can be established.

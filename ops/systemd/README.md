# systemd templates (Trusted Devnet Soft Launch)

These are **templates** for running a long-lived hub plus remote `provider-daemon` devnet using systemd.

Files:
- `ops/systemd/*.service`: unit templates
- `ops/systemd/env/*.env`: EnvironmentFile templates (copy to `/etc/polystore/*.env`)
- `ops/systemd/cloudflared-*.service`: user-systemd tunnel units for the `*.polynomialstore.com` deployment

For the full “blank box → running devnet” hub runbook, see `docs/TRUSTED_DEVNET_SOFT_LAUNCH.md`.

## Quick usage

1) Copy units:

```bash
sudo cp ops/systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
```

2) Copy env templates and edit paths/secrets:

```bash
sudo mkdir -p /etc/polystore
sudo cp ops/systemd/env/*.env /etc/polystore/
sudoedit /etc/polystore/polystore-gateway-router.env
```

3) Enable + start (hub):

```bash
sudo systemctl enable --now polystorechaind
sudo systemctl enable --now polystore-gateway-router
sudo systemctl enable --now polystore-faucet
```

### `polystorechaind` Redeploy Workflow

For recurring chain binary updates (build -> backup/install -> restart -> verify), use:

- runbook: `docs/POLYSTORECHAIND_REDEPLOY_RUNBOOK.md`
- script: `scripts/redeploy_polystorechaind.sh`

Typical flow:

```bash
./scripts/redeploy_polystorechaind.sh
sudo systemctl restart polystorechaind && sudo systemctl status --no-pager polystorechaind
./scripts/redeploy_polystorechaind.sh --verify-only
```

### Full Devnet Stack Rollout

For proof-format-coupled changes that must update the chain, `user-gateway`
legacy router service, faucet, CLI, runtime library, and all local
`provider-daemon` services together, use:

- runbook: `docs/devnet-polyfs-root-rollout.md`
- script: `scripts/update_devnet_stack.sh`

The stack rollout script covers `provider-daemon` services provider1 through
provider4 and restarts tunnel services only when `--restart-tunnels` is
supplied.

### Rootless Local Devnet Handoff

Routine local devnet deploys should not depend on root-owned hub services. For a
machine that already has `polystorechaind`, `polystore-faucet`, and
`polystore-gateway-router` installed as root units, run the one-time handoff:

```bash
sudo -E scripts/devnet_rootless_handoff.sh --run-user "$USER"
```

This moves the hub to user systemd units, chowns the devnet install/config/state
paths, and masks the root hub units by default. Afterward, use:

```bash
POLYSTORE_HUB_SERVICE_SCOPE=user scripts/update_devnet_stack.sh
```

See `docs/devnet-rootless-handoff.md`.

4) Tail logs:

```bash
journalctl -u polystorechaind -f
```

## User-level Cloudflare tunnel units

Cloudflare tunnels can run cleanly as user services:

```bash
mkdir -p ~/.config/systemd/user
cp ops/systemd/cloudflared-hub.service ~/.config/systemd/user/
cp ops/systemd/cloudflared-providers.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now cloudflared-hub.service
systemctl --user enable --now cloudflared-providers.service
```

These units intentionally use `Restart=always`. `cloudflared` can exit with status `0`
after all connections drop, and `Restart=on-failure` leaves the tunnel down.

For the current `polynomialstore.com` provider deployment, the three SP
hostnames are expected to use DNS-only direct HTTPS through Caddy, not
Cloudflare Tunnel. `cloudflared-providers.service` may still exist as a fallback,
but future agents should not assume it carries live `sp1`/`sp2`/`sp3` traffic.
See `docs/networking/DIRECT_SP_HTTPS_RUNBOOK.md`.

## Provider quick usage

Providers can run `polystore_gateway` in **provider** mode as a long-running service too:

```bash
sudo cp ops/systemd/polystore-gateway-provider.service /etc/systemd/system/
sudo systemctl daemon-reload

sudo mkdir -p /etc/polystore
sudo cp ops/systemd/env/polystore-gateway-provider.env /etc/polystore/
sudoedit /etc/polystore/polystore-gateway-provider.env

sudo systemctl enable --now polystore-gateway-provider
```

Minimum required edits in `polystore-gateway-provider.env`:
- `POLYSTORE_GATEWAY_SP_AUTH` must match the hub router
- `POLYSTORE_CHAIN_ID`, `POLYSTORE_NODE`, `POLYSTORE_LCD_BASE` must point at the hub
- `POLYSTORE_HOME` + `POLYSTORE_PROVIDER_KEY` must reference a key that exists locally

## Notes

- These templates assume you checked the repo out at `/opt/polystore`. Adjust as needed.
- Unit `ExecStart` commands intentionally use a shell wrapper so EnvironmentFile
  variables (for example `POLYSTORECHAIND_BIN`) are expanded correctly by systemd.
- The env templates include `LD_LIBRARY_PATH=/opt/polystore/polystore_core/target/release`
  so binaries linked against `libpolystore_core.so` start cleanly under systemd.
- The router↔provider auth token **must match** across the hub router and all providers:
  - `POLYSTORE_GATEWAY_SP_AUTH=...`
- If you run a reverse proxy for HTTPS subdomains, configure CORS to allow the website origin to call:
  - `gateway.*` (upload/fetch)
  - `lcd.*` / `evm.*` (wallet RPC)
- Caddy example configs live in `ops/caddy/`.

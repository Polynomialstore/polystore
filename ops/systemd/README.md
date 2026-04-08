# systemd templates (Trusted Devnet Soft Launch)

These are **templates** for running a long-lived hub + remote SP devnet using systemd.

Files:
- `ops/systemd/*.service`: unit templates
- `ops/systemd/env/*.env`: EnvironmentFile templates (copy to `/etc/nilstore/*.env`)

For the full “blank box → running devnet” hub runbook, see `docs/TRUSTED_DEVNET_SOFT_LAUNCH.md`.

## Quick usage

1) Copy units:

```bash
sudo cp ops/systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
```

2) Copy env templates and edit paths/secrets:

```bash
sudo mkdir -p /etc/nilstore
sudo cp ops/systemd/env/*.env /etc/nilstore/
sudoedit /etc/nilstore/polystore-gateway-router.env
```

3) Enable + start (hub):

```bash
sudo systemctl enable --now polystorechaind
sudo systemctl enable --now polystore-gateway-router
sudo systemctl enable --now polystore-faucet
```

### Nilchaind redeploy workflow

For recurring chain binary updates (build -> backup/install -> restart -> verify), use:

- runbook: `docs/NILCHAIND_REDEPLOY_RUNBOOK.md`
- script: `scripts/redeploy_polystorechaind.sh`

Typical flow:

```bash
./scripts/redeploy_polystorechaind.sh
sudo systemctl restart polystorechaind && sudo systemctl status --no-pager polystorechaind
./scripts/redeploy_polystorechaind.sh --verify-only
```

4) Tail logs:

```bash
journalctl -u polystorechaind -f
```

## Provider quick usage

Providers can run `polystore_gateway` in **provider** mode as a long-running service too:

```bash
sudo cp ops/systemd/polystore-gateway-provider.service /etc/systemd/system/
sudo systemctl daemon-reload

sudo mkdir -p /etc/nilstore
sudo cp ops/systemd/env/polystore-gateway-provider.env /etc/nilstore/
sudoedit /etc/nilstore/polystore-gateway-provider.env

sudo systemctl enable --now polystore-gateway-provider
```

Minimum required edits in `polystore-gateway-provider.env`:
- `NIL_GATEWAY_SP_AUTH` must match the hub router
- `NIL_CHAIN_ID`, `NIL_NODE`, `NIL_LCD_BASE` must point at the hub
- `NIL_HOME` + `NIL_PROVIDER_KEY` must reference a key that exists locally

## Notes

- These templates assume you checked the repo out at `/opt/nilstore`. Adjust as needed.
- Unit `ExecStart` commands intentionally use a shell wrapper so EnvironmentFile
  variables (for example `NILCHAIND_BIN`) are expanded correctly by systemd.
- The env templates include `LD_LIBRARY_PATH=/opt/nilstore/polystore_core/target/release`
  so binaries linked against `libpolystore_core.so` start cleanly under systemd.
- The router↔provider auth token **must match** across the hub router and all providers:
  - `NIL_GATEWAY_SP_AUTH=...`
- If you run a reverse proxy for HTTPS subdomains, configure CORS to allow the website origin to call:
  - `gateway.*` (upload/fetch)
  - `lcd.*` / `evm.*` (wallet RPC)
- Caddy example configs live in `ops/caddy/`.

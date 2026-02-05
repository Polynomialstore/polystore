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
sudoedit /etc/nilstore/nil-gateway-router.env
```

3) Enable + start (hub):

```bash
sudo systemctl enable --now nilchaind
sudo systemctl enable --now nil-gateway-router
sudo systemctl enable --now nil-faucet
```

4) Tail logs:

```bash
journalctl -u nilchaind -f
```

## Provider quick usage

Providers can run `nil_gateway` in **provider** mode as a long-running service too:

```bash
sudo cp ops/systemd/nil-gateway-provider.service /etc/systemd/system/
sudo systemctl daemon-reload

sudo mkdir -p /etc/nilstore
sudo cp ops/systemd/env/nil-gateway-provider.env /etc/nilstore/
sudoedit /etc/nilstore/nil-gateway-provider.env

sudo systemctl enable --now nil-gateway-provider
```

Minimum required edits in `nil-gateway-provider.env`:
- `NIL_GATEWAY_SP_AUTH` must match the hub router
- `NIL_CHAIN_ID`, `NIL_NODE`, `NIL_LCD_BASE` must point at the hub
- `NIL_HOME` + `NIL_PROVIDER_KEY` must reference a key that exists locally

## Notes

- These templates assume you checked the repo out at `/opt/nilstore`. Adjust as needed.
- The router↔provider auth token **must match** across the hub router and all providers:
  - `NIL_GATEWAY_SP_AUTH=...`
- If you run a reverse proxy for HTTPS subdomains, configure CORS to allow the website origin to call:
  - `gateway.*` (upload/fetch)
  - `lcd.*` / `evm.*` (wallet RPC)
- Caddy example configs live in `ops/caddy/`.

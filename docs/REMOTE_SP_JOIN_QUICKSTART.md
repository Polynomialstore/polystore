# Remote Storage Provider (SP) Join — Quickstart

This is the **fast path** for a trusted collaborator to join a shared devnet as a Storage Provider.

If you want the full guide, see `DEVNET_MULTI_PROVIDER.md`.

## What you need from the hub operator

- Hub RPC: `tcp://<hub-host>:26657` (or `https://rpc.<domain>`)
- Hub LCD: `http://<hub-host>:1317` (or `https://lcd.<domain>`)
- Shared chain ID: `<chain-id>`
- Shared router↔provider auth token: `NIL_GATEWAY_SP_AUTH=...`

## Provider machine prerequisites

- This repo checked out
- Go + Rust toolchains installed
- A reachable provider endpoint (either direct public IP/port-forward, or Cloudflare Tunnel HTTPS)
- (Optional, recommended) systemd + a reverse proxy:
  - systemd templates: `ops/systemd/nil-gateway-provider.service` + `ops/systemd/env/nil-gateway-provider.env`
  - HTTPS reverse proxy example: `ops/caddy/Caddyfile.provider.example`

## Step-by-step

### 1) Create your provider key (local keyring)

```bash
PROVIDER_KEY=provider1 ./scripts/run_devnet_provider.sh init
```

This prints your provider address (`nil1...`).

Optional: print the resolved provider config in machine-readable form:

```bash
PROVIDER_KEY=provider1 ./scripts/run_devnet_provider.sh print-config
```

### 2) Get funded for gas

Ask the hub operator to send you some `aatom` (gas) via the faucet or a direct bank send.

### 3) Pick an endpoint multiaddr

Option A (direct/public endpoint): register an IP+port endpoint:

- `/ip4/<your-public-ip>/tcp/8091/http`

Set it:

```bash
export PROVIDER_ENDPOINT="/ip4/<your-public-ip>/tcp/8091/http"
```

Option B (behind NAT with Cloudflare Tunnel): register DNS+HTTPS endpoint:

- `/dns4/sp.<domain>/tcp/443/https`

```bash
export PROVIDER_ENDPOINT="/dns4/sp.<domain>/tcp/443/https"
```

In your tunnel ingress, route that hostname to the local provider listener (for example `service: http://localhost:8091`).

Cloudflare Tunnel setup and endpoint helper details:
- `docs/networking/PROVIDER_ENDPOINTS.md`

### 4) Register your provider on-chain

```bash
export HUB_NODE="tcp://<hub-host>:26657"  # or https://rpc.<domain>
export HUB_LCD="http://<hub-host>:1317"   # or https://lcd.<domain>
export CHAIN_ID="<chain-id>"
export PROVIDER_KEY="provider1"

./scripts/run_devnet_provider.sh register
```

If you are letting Codex or Claude Code drive setup locally, you can also use:

```bash
./scripts/run_devnet_provider.sh bootstrap
```

`bootstrap` runs `init`, registers the provider if `PROVIDER_ENDPOINT` is set, starts the provider if `NIL_GATEWAY_SP_AUTH` is set, then runs a local doctor pass.

### 5) Start your provider gateway

```bash
export NIL_GATEWAY_SP_AUTH="<shared-from-hub>"
export NIL_LCD_BASE="$HUB_LCD"
export NIL_NODE="$HUB_NODE"
export NIL_CHAIN_ID="$CHAIN_ID"
export PROVIDER_KEY="provider1"
export PROVIDER_LISTEN=":8091"

./scripts/run_devnet_provider.sh start
```

Long-running (recommended): use the systemd templates in `ops/systemd/` and copy/edit `ops/systemd/env/nil-gateway-provider.env`.

### 6) Verify

On the provider:

```bash
curl -sf http://127.0.0.1:8091/health
```

Or run the healthcheck script (recommended):

```bash
scripts/devnet_healthcheck.sh provider --provider http://127.0.0.1:8091 --hub-lcd "$HUB_LCD" --provider-addr <nil1...>
```

Agent-oriented diagnostics:

```bash
./scripts/run_devnet_provider.sh doctor
./scripts/run_devnet_provider.sh verify
```

- `doctor` checks prerequisites, key state, endpoint configuration, local/public `/health`, and on-chain visibility when possible.
- `verify` runs the repo healthcheck with the current provider and hub settings.

From the hub (or anywhere with LCD access):

```bash
curl -sf "$HUB_LCD/nilchain/nilchain/v1/providers" | jq '.providers | length'
```

## Common failures

- Provider not visible on LCD:
  - the `register-provider` tx likely failed (often: not enough `aatom` for gas)
- Router can’t reach provider:
  - firewall/NAT; ensure your `PROVIDER_ENDPOINT` is reachable **from the hub**
  - confirm `NIL_GATEWAY_SP_AUTH` matches the hub router

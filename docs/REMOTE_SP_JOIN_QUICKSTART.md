# Remote Provider-Daemon Join — Quickstart

This is the **fast path** for a trusted collaborator to join a shared devnet as a PolyStore provider-daemon operator.

If you want the full guide, see `DEVNET_MULTI_PROVIDER.md`.

## What you need from the hub operator

- Shared `user-gateway` to `provider-daemon` auth token: `NIL_GATEWAY_SP_AUTH=...`
- Operator wallet address from website onboarding: `OPERATOR_ADDRESS=nil1...` (or `0x...`)

Treat `NIL_GATEWAY_SP_AUTH` as a secret. Paste it only on the provider host or into a trusted local agent session. Do not post it in chat, issues, or screenshots.

The default provider flow now targets the canonical public PolyStore testnet from `.env.testnet.public`.
Only set `HUB_NODE`, `HUB_LCD`, or `CHAIN_ID` when you are intentionally joining a non-public hub.

The web-first operator flow is:
1. Open `https://polynomialstore.com/#/sp-onboarding` on the website.
2. Connect the operator wallet and copy the operator address (`nil1...`).
3. Prepare the provider host checkout on the machine that will run the provider-daemon.
4. Pair provider identity: run one `pair` command on the provider host, let it create the key if needed, fund it and rerun if auto-funding is unavailable, then approve it from the website wallet step.
5. Configure public access: set the provider endpoint and paste `NIL_GATEWAY_SP_AUTH` from the hub operator.
6. Run bootstrap from the website command rail, then finish verification from `https://polynomialstore.com/#/sp-dashboard`.

## Provider machine prerequisites

- This repo checked out
- Go + Rust toolchains installed
- A reachable provider endpoint (either direct public IP/port-forward, or Cloudflare Tunnel HTTPS)
- (Optional, recommended) systemd + a reverse proxy:
  - systemd templates: `ops/systemd/polystore-gateway-provider.service` + `ops/systemd/env/polystore-gateway-provider.env`
  - HTTPS reverse proxy example: `ops/caddy/Caddyfile.provider.example`

## Step-by-step

### 1) Choose a provider key name

```bash
export PROVIDER_KEY="provider1"
```

The website pairing step will create this key if it does not already exist.

Optional: print the resolved provider config in machine-readable form:

```bash
PROVIDER_KEY=provider1 ./scripts/run_devnet_provider.sh print-config
```

### 2) Pick an endpoint multiaddr

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

### 3) Pair in the website flow, then bootstrap

```bash
export PROVIDER_KEY="provider1"
export OPERATOR_ADDRESS="<operator-nil1-or-0x-address>"

./scripts/run_devnet_provider.sh pair
```

If the key is new and the command prints a provider `nil1...` address that still needs gas, fund that address with `aatom` and rerun the same `pair` command.

Approve the pending provider link in `https://polynomialstore.com/#/sp-onboarding`, then continue with:

```bash
export PROVIDER_KEY="provider1"
export PROVIDER_ENDPOINT="/dns4/sp.<domain>/tcp/443/https" # or your /ip4/... endpoint
export NIL_GATEWAY_SP_AUTH="<shared-from-hub>"
export OPERATOR_ADDRESS="<operator-nil1-or-0x-address>"

./scripts/run_devnet_provider.sh bootstrap
```

`bootstrap` now:

- creates the provider key if needed
- opens provider link request on-chain (when needed)
- starts the provider-daemon
- registers the provider if it is new
- updates provider endpoints if it is already registered
- runs a doctor pass at the end

Website-managed `bootstrap` now fails fast unless `OPERATOR_ADDRESS`, `NIL_GATEWAY_SP_AUTH`, and `PROVIDER_ENDPOINT` are all present.

If you intentionally want a partial manual bootstrap, use the staged commands below (`pair`, `register`, `start`) or opt in explicitly with:

```bash
BOOTSTRAP_ALLOW_PARTIAL=1 ./scripts/run_devnet_provider.sh bootstrap
```

Do not expect `/#/sp-onboarding` or `/#/sp-dashboard` to track an unlinked provider until link request is opened and approved.

If you are targeting a non-public hub, export `HUB_NODE`, `HUB_LCD`, and `CHAIN_ID` before running `bootstrap`.

### 4) Advanced/manual path

Use this only when you want to split link request, registration, and process start into separate steps.

Register or update endpoints:

```bash
export PROVIDER_KEY="provider1"
export PROVIDER_ENDPOINT="/dns4/sp.<domain>/tcp/443/https"

./scripts/run_devnet_provider.sh register
```

Request provider link explicitly:

```bash
export PROVIDER_KEY="provider1"
export OPERATOR_ADDRESS="<operator-nil1-or-0x-address>"

./scripts/run_devnet_provider.sh link
```

Start only the provider-daemon:

```bash
export PROVIDER_KEY="provider1"
export NIL_GATEWAY_SP_AUTH="<shared-from-hub>"
export PROVIDER_LISTEN=":8091"

./scripts/run_devnet_provider.sh start
```

Long-running (recommended): use the systemd templates in `ops/systemd/` and copy/edit `ops/systemd/env/polystore-gateway-provider.env`.

### 5) Verify

On the provider:

```bash
curl -sf http://127.0.0.1:8091/health
```

For direct IPv4 deployments, also verify the public endpoint with:

```bash
curl -sf http://<public-ip>:8091/health
```

For tunnel / hostname deployments, verify:

```bash
curl -sf https://sp.<domain>/health
```

Or run the healthcheck script (recommended):

```bash
scripts/devnet_healthcheck.sh provider --provider http://127.0.0.1:8091 --hub-lcd "${HUB_LCD:-https://lcd.polynomialstore.com}" --provider-addr <nil1...>
```

Agent-oriented diagnostics:

```bash
./scripts/run_devnet_provider.sh doctor
./scripts/run_devnet_provider.sh verify
```

- `doctor` checks prerequisites, key state, link configuration, endpoint configuration, local/public `/health`, and on-chain visibility when possible.
- `verify` runs the repo healthcheck with the current provider and hub settings.

From the hub (or anywhere with LCD access):

```bash
curl -sf "${HUB_LCD:-https://lcd.polynomialstore.com}/polystorechain/polystorechain/v1/providers" | jq '.providers | length'
```

## Common failures

- Provider not visible on LCD:
  - the `register-provider` tx likely failed (often: not enough `aatom` for gas)
- Provider link is still missing:
  - `OPERATOR_ADDRESS` was wrong, or the operator wallet has not approved the pending provider link
- Router can’t reach provider:
  - firewall/NAT; ensure your `PROVIDER_ENDPOINT` is reachable **from the hub**
  - confirm `NIL_GATEWAY_SP_AUTH` matches the hub `user-gateway`

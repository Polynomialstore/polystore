# Trusted Devnet Collaborator Packet (nilstore.org)

This is the concrete collaborator packet for the current trusted devnet hub deployment.

Recommended public entry points:
- Storage users: `docs/ALPHA_STORAGE_USER_QUICKSTART.md`
- Provider operators: `docs/ALPHA_PROVIDER_QUICKSTART.md`

## Live Endpoints

- Website: `https://nilstore.org/#/first-file` (primary onboarding route) / `https://web.nilstore.org/#/first-file` (if enabled)
- EVM RPC: `https://evm.nilstore.org`
- Hub RPC: `https://rpc.nilstore.org`
- Hub LCD: `https://lcd.nilstore.org`
- Faucet: `https://faucet.nilstore.org/faucet`
- Chain ID: `20260211` (`0x1352573`)

Provider public endpoints (Mode 2 `2+1` baseline):
- `https://sp1.nilstore.org` → provider `nil1jtqzjx7y9kh3un3a86u774mucsq4q3vshh8sr0`
- `https://sp2.nilstore.org` → provider `nil1w98n98a8gnrwnyz62wfvya9wzvdr92uwz7dssk`
- `https://sp3.nilstore.org` → provider `nil182f6qy5taazj5fa722p2ut4d0v5j2gkap0dprj`

## What Collaborators Need From Hub Operator

- Faucet auth token (shared pre-alpha devnet bootstrap token; may already be embedded in the website build)
- Router/provider shared secret `NIL_GATEWAY_SP_AUTH` (SP operators only)

## Website Tester Quickstart

1) Open `https://nilstore.org/#/first-file` (use `https://web.nilstore.org/#/first-file` only if you are explicitly testing that host).
2) Connect MetaMask and switch to:
- RPC URL: `https://evm.nilstore.org`
- Chain ID: `20260211`
- Currency: `ATOM`
3) Fund test address:
- Use website faucet flow (this deployment may include a preconfigured faucet token), or
- POST to `https://faucet.nilstore.org/faucet` with header `X-Nil-Faucet-Auth: <token>`.
4) Run the flow:
- create the deal on `/#/first-file`
- continue to `/#/dashboard`
- upload → commit → retrieve

Fast full-local repo onboarding:
- Start Nil Gateway GUI on `http://localhost:8080`.
- Verify `curl -sf http://localhost:8080/health`.
- Use the repo-tracked public bootstrap defaults in `.env.testnet.public` unless you need explicit overrides.
- Run `scripts/testnet_burner_upload.sh <file_path>` with a small file.
- Import the exported keystore into MetaMask.
- Continue browser verification on `https://nilstore.org/#/dashboard` with that same wallet and local gateway after the first-file allocation step.

Local gateway app (recommended for localhost gateway-assisted flows):
- Start Nil Gateway GUI (or local `nil_gateway`) on `http://localhost:8080`.
- Download builds: `https://github.com/Nil-Store/nil-store/releases/latest`.

Notes:
- The website flow remains wallet-first. If `POST /gateway/create-deal-evm` returns `403`, that is expected (tx relay disabled).
- The repo helper `scripts/testnet_burner_upload.sh` uses the local gateway for upload and direct `nilchaind` submission for create/update, so it does not require a separately managed local faucet or gateway tx-relay setup.
- The website flow uses direct EVM transactions (MetaMask / precompile), then uses direct provider transport and optional localhost local-gateway mode.

## SP Operator Quickstart

Canonical docs:
- `docs/ALPHA_PROVIDER_QUICKSTART.md`
- `docs/REMOTE_SP_JOIN_QUICKSTART.md`
- `docs/networking/PROVIDER_ENDPOINTS.md`

Recommended website-first bootstrap:

```bash
export PROVIDER_KEY="provider1"
./scripts/run_devnet_provider.sh init
```

Fund the printed provider address with `aatom`, then run:

```bash
export PROVIDER_ENDPOINT="/dns4/sp1.nilstore.org/tcp/443/https" # or /ip4/<public-ip>/tcp/8091/http
export NIL_GATEWAY_SP_AUTH="<shared-secret-from-hub>"
export OPERATOR_ADDRESS="<operator-nil1-or-0x-address>"         # from website wallet step

./scripts/run_devnet_provider.sh bootstrap
```

Website-first operator flow:
- open `/sp-onboarding`
- connect the operator wallet
- run provider-host link request with `OPERATOR_ADDRESS`
- approve the pending link from the operator wallet
- finish verification from the website after bootstrap

Use `scripts/run_devnet_provider.sh` for `init`, `bootstrap`, `print-config`, `doctor`, and `verify`.

## Healthcheck Commands

Hub public surface:

```bash
scripts/devnet_healthcheck.sh hub \
  --rpc https://rpc.nilstore.org \
  --lcd https://lcd.nilstore.org \
  --evm https://evm.nilstore.org \
  --gateway http://127.0.0.1:18080 \
  --faucet https://faucet.nilstore.org
```

Provider operator baseline:

```bash
scripts/devnet_healthcheck.sh provider \
  --provider https://sp1.nilstore.org \
  --hub-lcd https://lcd.nilstore.org \
  --provider-addr nil1jtqzjx7y9kh3un3a86u774mucsq4q3vshh8sr0
```

## Reporting Template For Issues

When reporting failures, include:
- action (`create`, `upload`, `commit`, `retrieve`)
- deal id (if present)
- timestamp (UTC)
- for retrieval issues: response header `X-Nil-Provider`
- if using curl: relevant request/response headers (especially session headers)

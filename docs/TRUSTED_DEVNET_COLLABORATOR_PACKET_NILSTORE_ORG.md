# Trusted Devnet Collaborator Packet (nilstore.org)

This is the concrete collaborator packet for the current trusted devnet hub deployment.

Recommended public entry points:
- Storage users: `docs/ALPHA_STORAGE_USER_QUICKSTART.md`
- Provider operators: `docs/ALPHA_PROVIDER_QUICKSTART.md`

## Live Endpoints

- Website: `https://nilstore.org` (primary) / `https://web.nilstore.org` (if enabled)
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

1) Open `https://nilstore.org` (use `https://web.nilstore.org` only if you are explicitly testing that host).
2) Connect MetaMask and switch to:
- RPC URL: `https://evm.nilstore.org`
- Chain ID: `20260211`
- Currency: `ATOM`
3) Fund test address:
- Use website faucet flow (this deployment may include a preconfigured faucet token), or
- POST to `https://faucet.nilstore.org/faucet` with header `X-Nil-Faucet-Auth: <token>`.
4) Run the flow:
- create deal → upload → commit → retrieve.

Fast full-local repo onboarding:
- Start Nil Gateway GUI on `http://localhost:8080`.
- Verify `curl -sf http://localhost:8080/health`.
- Use the repo-tracked public bootstrap defaults in `.env.testnet.public` unless you need explicit overrides.
- Run `scripts/testnet_burner_upload.sh <file_path>` with a small file.
- Import the exported keystore into MetaMask.
- Continue browser verification on `https://nilstore.org/#/first-file` with that same wallet and local gateway.

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

Recommended env bootstrap:

```bash
export HUB_NODE="https://rpc.nilstore.org"
export HUB_LCD="https://lcd.nilstore.org"
export CHAIN_ID="20260211"
export PROVIDER_KEY="provider1"
export NIL_GATEWAY_SP_AUTH="<shared-secret-from-hub>"
```

Use `scripts/run_devnet_provider.sh` for `init`, `register`, `start`, `print-config`, `doctor`, and `verify`.

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

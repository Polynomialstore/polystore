# Trusted Devnet Collaborator Packet (nilstore.org)

This is the concrete collaborator packet for the current trusted devnet hub deployment.

## Live Endpoints

- Website: `https://web.nilstore.org` (externally hosted)
- EVM RPC: `https://evm.nilstore.org`
- Hub RPC: `https://rpc.nilstore.org`
- Hub LCD: `https://lcd.nilstore.org`
- Gateway: `https://gateway.nilstore.org`
- Faucet: `https://faucet.nilstore.org/faucet`
- Chain ID: `31337` (`0x7a69`)

## What Collaborators Need From Hub Operator

- Faucet auth token (invite-only; share out-of-band)
- Router/provider shared secret `NIL_GATEWAY_SP_AUTH` (SP operators only)

## Website Tester Quickstart

1) Open `https://web.nilstore.org`.
2) Connect MetaMask and switch to:
- RPC URL: `https://evm.nilstore.org`
- Chain ID: `31337`
- Currency: `ATOM`
3) Fund test address:
- Use website faucet flow if enabled, or
- POST to `https://faucet.nilstore.org/faucet` with header `X-Nil-Faucet-Auth: <token>`.
4) Run the flow:
- create deal → upload → commit → retrieve.

## SP Operator Quickstart

Canonical docs:
- `docs/REMOTE_SP_JOIN_QUICKSTART.md`
- `docs/networking/PROVIDER_ENDPOINTS.md`

Recommended env bootstrap:

```bash
export HUB_NODE="https://rpc.nilstore.org"
export HUB_LCD="https://lcd.nilstore.org"
export CHAIN_ID="31337"
export PROVIDER_KEY="provider1"
export NIL_GATEWAY_SP_AUTH="<shared-secret-from-hub>"
```

Use `scripts/run_devnet_provider.sh` for `init`, `register`, and `start`.

## Healthcheck Commands

Hub public surface:

```bash
scripts/devnet_healthcheck.sh hub \
  --rpc https://rpc.nilstore.org \
  --lcd https://lcd.nilstore.org \
  --evm https://evm.nilstore.org \
  --gateway https://gateway.nilstore.org \
  --faucet https://faucet.nilstore.org
```

Provider operator baseline:

```bash
scripts/devnet_healthcheck.sh provider \
  --provider https://provider.<domain> \
  --hub-lcd https://lcd.nilstore.org \
  --provider-addr nil1...
```

## Reporting Template For Issues

When reporting failures, include:
- action (`create`, `upload`, `commit`, `retrieve`)
- deal id (if present)
- timestamp (UTC)
- for retrieval issues: response header `X-Nil-Provider`
- if using curl: relevant request/response headers (especially session headers)

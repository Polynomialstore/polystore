# Multi-Provider Devnet (Join Guide)

This guide is for running a shared devnet where multiple people can join as Storage Providers (SPs) and the hub routes deals to them.

## Mental Model

- **Hub** runs: `nilchaind` (RPC/LCD/EVM), `nil_faucet`, **gateway-router** (`nil_gateway` in router mode), and optionally `nil-website`.
- **Provider** runs: `nil_gateway` in provider mode with its own `nilchaind` keyring key (pays gas for provider txs).
- **Users** use: the web UI (MetaMask) or curl. The web flow uses EIP-712 signatures for authorization; the hub still broadcasts some txs with its faucet key (devnet shortcut).

## One-Command Local Multi-SP (Single Machine)

If you just want multiple providers on one laptop:

```bash
PROVIDER_COUNT=5 ./scripts/run_devnet_alpha_multi_sp.sh start
```

## Multi-Machine Devnet (Hub + Remote Providers)

### 1) Hub operator

Start the hub stack:

```bash
./scripts/run_devnet_hub.sh start
```

Share these values with providers:

- Hub RPC: `tcp://<hub-host>:26657`
- Hub LCD: `http://<hub-host>:1317`
- Gateway router: `http://<hub-host>:8080`
- EVM RPC: `http://<hub-host>:8545` (chain id `31337` by default)
- The shared router↔provider auth token: `NIL_GATEWAY_SP_AUTH=...` (printed by the hub script)

### 2) Provider operator (remote machine)

Prereqs:
- repo checked out (build tools for Go + Rust)
- ports reachable from the hub (at least your provider HTTP port, e.g. `8091`)

Create a provider key (local keyring) and print your provider address:

```bash
PROVIDER_KEY=provider1 ./scripts/run_devnet_provider.sh init
```

Ask the hub operator to fund your `nil1...` address with some `aatom` (gas).

Register your provider endpoint (Multiaddr must be reachable from the hub router):

```bash
export HUB_NODE="tcp://<hub-host>:26657"
export HUB_LCD="http://<hub-host>:1317"
export CHAIN_ID="31337"
export PROVIDER_KEY="provider1"
export PROVIDER_ENDPOINT="/ip4/<public-ip>/tcp/8091/http"

./scripts/run_devnet_provider.sh register
```

Start your provider gateway:

```bash
export NIL_GATEWAY_SP_AUTH="<shared-from-hub>"
export NIL_LCD_BASE="$HUB_LCD"
export NIL_NODE="$HUB_NODE"
export NIL_CHAIN_ID="$CHAIN_ID"
export PROVIDER_KEY="provider1"
export PROVIDER_LISTEN=":8091"

./scripts/run_devnet_provider.sh start
```

### 3) Users

Open the web UI (hub):

`http://<hub-host>:5173/#/dashboard`

Create a deal, upload a file, and downloads will route through the hub gateway to the assigned provider.

## Troubleshooting

- Provider not showing up on `/nilchain/nilchain/v1/providers`:
  - ensure the registration tx succeeded and the provider address is funded for fees
  - ensure you passed a reachable `--endpoint` multiaddr
- Router can’t reach provider:
  - check firewall/NAT, and confirm `PROVIDER_ENDPOINT` is reachable *from the hub*
  - ensure both router + provider share the same `NIL_GATEWAY_SP_AUTH`
- Remote provider submitting txs to the wrong node:
  - set `NIL_NODE=tcp://<hub-host>:26657` (provider gateway uses this for `nilchaind tx/query`)


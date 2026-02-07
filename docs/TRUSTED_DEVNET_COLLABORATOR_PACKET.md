# Trusted Devnet Collaborator Packet (Feb 2026)

This is the “send this to collaborators” doc for the **trusted devnet soft launch**.

For a concrete example with real hostnames, see:
- `docs/TRUSTED_DEVNET_COLLABORATOR_PACKET_NILSTORE_ORG.md`

Audience:
- **Website testers** (no server required)
- **Storage Provider (SP) operators** (optional; run `nil_gateway` in provider mode)

If you are the hub operator, also read: `docs/TRUSTED_DEVNET_SOFT_LAUNCH.md`.

---

## What you need from the hub operator

You should receive:
- Website URL: `https://web.<domain>`
- EVM RPC: `https://evm.<domain>`
- Chain ID: `<chain-id>` (e.g. `31337`)
- Faucet URL (optional): `https://faucet.<domain>/faucet`
- Faucet auth token (optional): a secret string you paste into the website UI (do **not** share publicly)
- Local gateway sidecar endpoint (optional): `http://localhost:8080`

If you are running an SP, you also need:
- Hub RPC: `https://rpc.<domain>`
- Hub LCD: `https://lcd.<domain>`
- Router↔provider shared secret: `NIL_GATEWAY_SP_AUTH=...` (treat like a password)

---

## Path A — Website tester (no server)

Goal: run the end-to-end flow **create deal → upload → commit → retrieve** from the website using MetaMask.

### 1) Open the website + connect wallet

1. Open `https://web.<domain>`.
2. Click **Connect wallet** (MetaMask).
3. If prompted, add/switch to the NilStore devnet network using the RPC the hub operator gave you.

If you need to add the network manually:
- Network name: `NilStore Devnet`
- RPC URL: `https://evm.<domain>`
- Chain ID: `<chain-id>`
- Currency symbol: `ATOM` (gas denom is `aatom` in the current devnet profile)

### 2) Get test funds

If the faucet UI is enabled on the website:
1. Paste the faucet auth token (if provided).
2. Click **Fund** (or equivalent).

If the faucet UI is not enabled, ask the hub operator to fund your address.

### 3) Store your first file

1. Create a deal (capacity container).
2. Upload a small file (start with ~10–100 KiB).
3. Commit the content (this updates the on-chain `manifest_root`).
4. Retrieve the file back and confirm it matches what you uploaded.

Optional but recommended:
- Install Nil Gateway GUI and run it locally (`http://localhost:8080`) for gateway-assisted workflows.
- Download from: `https://github.com/Nil-Store/nil-store/releases/latest`.

Tip: if you test with a text file, change a line and re-upload to confirm the commit changes the retrieval.

---

## Path B — Storage Provider (SP) operator (optional)

Goal: register a provider on-chain and run a provider gateway so the hub router can place data on you.

This packet is intentionally short; the canonical SP join docs are:
- Fast path: `docs/REMOTE_SP_JOIN_QUICKSTART.md`
- Full guide: `DEVNET_MULTI_PROVIDER.md`
- Endpoint formats: `docs/networking/PROVIDER_ENDPOINTS.md`

### 0) Prereqs

- A Linux host (publicly reachable **or** behind NAT via Cloudflare Tunnel)
- Go + Rust toolchains installed
- This repo checked out

### 1) Initialize your provider key

```bash
PROVIDER_KEY=provider1 ./scripts/run_devnet_provider.sh init
```

Save the printed provider address (`nil1...`).

### 2) Get gas funds

Ask the hub operator to fund your provider address with a small amount of `aatom` for gas.

### 3) Choose your provider endpoint multiaddr

Option A (direct HTTP, public IP + port):

```bash
export PROVIDER_ENDPOINT="/ip4/<your-public-ip>/tcp/8091/http"
```

Option B (Cloudflare Tunnel HTTPS, behind NAT):

```bash
# After creating a Cloudflare Tunnel hostname (example: sp1.<domain>)
export PROVIDER_ENDPOINT="/dns4/sp1.<domain>/tcp/443/https"
```

In your tunnel config, point that hostname to the local provider listener (for example `service: http://localhost:8091`).

Cloudflare Tunnel setup reference (recommended for NAT): `docs/networking/PROVIDER_ENDPOINTS.md`.

### 4) Register on-chain (uses the hub RPC/LCD)

```bash
export HUB_NODE="https://rpc.<domain>"
export HUB_LCD="https://lcd.<domain>"
export CHAIN_ID="<chain-id>"
export PROVIDER_KEY="provider1"

./scripts/run_devnet_provider.sh register
```

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

Verify locally:

```bash
curl -sf http://127.0.0.1:8091/health
```

Recommended verification:

```bash
scripts/devnet_healthcheck.sh provider \
  --provider http://127.0.0.1:8091 \
  --hub-lcd "$HUB_LCD" \
  --provider-addr <nil1...>
```

### 6) Tell the hub operator

Send:
- your provider address (`nil1...`)
- your registered endpoint (`/ip4/.../tcp/.../http`)

---

## What to report when something breaks

Please capture:
- What path you were following (A: website tester, B: provider operator)
- Deal ID (if visible) and the action that failed (create / upload / commit / retrieve)
- For retrieval failures:
  - request headers you used (notably `X-Nil-Session-Id`, if you were using curl)
  - hub response header `X-Nil-Provider` (who served the bytes)
  - whether you were using a local sidecar gateway (`http://localhost:8080`) and timestamp
- A screenshot + browser console log (website), or command output (CLI)

If you can reproduce reliably, that’s gold: include “steps to reproduce” from a fresh page load or fresh process start.

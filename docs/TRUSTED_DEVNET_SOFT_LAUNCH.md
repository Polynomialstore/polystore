# Trusted Devnet Soft Launch (Feb 2026)

Goal: onboard **10–20 trusted collaborators** (invite-only) to run Storage Providers (SPs) and to test end-to-end flows (create deal → upload → commit → retrieve) for **2–3 weeks**.

This doc is written for the **hub operator** and **remote providers**.

Related:
- Provider endpoint types: `docs/networking/PROVIDER_ENDPOINTS.md`
- Remote SP join quickstart: `docs/REMOTE_SP_JOIN_QUICKSTART.md`
- Monitoring checklist: `docs/TRUSTED_DEVNET_MONITORING_CHECKLIST.md`

## Architecture (locked for soft launch)

- **Hub (VPS)** runs:
  - `nilchaind` (CometBFT RPC + LCD + EVM JSON-RPC)
  - `nil_gateway` in **router** mode
  - `nil_faucet` (enabled, rate-limited; collaborator-only)
  - `nil-website` (static build behind HTTPS)
- **Providers (remote SPs)** run:
  - `nil_gateway` in **provider** mode (one per SP)
- **Users** interact via:
  - Website + MetaMask (wallet-first), or curl for debugging

Security posture:
- This is **trusted** and **invite-only** (not Sybil resistant).
- The router↔provider channel uses a shared secret (`NIL_GATEWAY_SP_AUTH`). Treat it like a password.

## Public endpoints (recommended)

Use HTTPS subdomains (reverse-proxied to localhost ports):

- `https://rpc.<domain>` → `http://127.0.0.1:26657` (CometBFT RPC)
- `https://lcd.<domain>` → `http://127.0.0.1:1317` (LCD REST)
- `https://evm.<domain>` → `http://127.0.0.1:8545` (EVM JSON-RPC)
- `https://gateway.<domain>` → `http://127.0.0.1:8080` (router gateway)
- `https://faucet.<domain>` → `http://127.0.0.1:8081` (faucet)
- `https://web.<domain>` → static website build

Reverse proxy templates:
- Caddy examples live in `ops/caddy/` (`ops/caddy/Caddyfile.hub.example` + `ops/caddy/Caddyfile.provider.example`).

## Hub VPS runbook (blank box → running devnet)

This section is the **hub operator** checklist for standing up the public endpoints on a fresh VPS.

### 0) DNS + firewall (required)

1) Create DNS records (A/AAAA) for:
- `rpc.<domain>`
- `lcd.<domain>`
- `evm.<domain>`
- `gateway.<domain>`
- `faucet.<domain>`
- `web.<domain>`

2) Open inbound ports:
- `22/tcp` (SSH)
- `80/tcp` + `443/tcp` (Caddy / HTTPS)

Keep the underlying service ports **local-only** (recommended) or **firewalled**:
- `26657` (CometBFT RPC)
- `1317` (LCD REST)
- `8545` (EVM JSON-RPC)
- `8080` (router gateway)
- `8081` (faucet)

### 1) Install prerequisites (one-time)

You need toolchains to build binaries + the static website:
- Go (see `go.mod`; currently Go `1.25.x`)
- Rust (stable) + `wasm-pack` + `wasm32-unknown-unknown`
- Node.js + npm
- Caddy (for HTTPS)

### 2) Clone + bootstrap chain home (one-time)

This produces a persistent chain home directory and prints the router↔provider shared secret.

```bash
sudo mkdir -p /opt && sudo chown "$USER":"$USER" /opt
git clone https://github.com/Nil-Store/nil-store.git /opt/nilstore
cd /opt/nilstore

# Use a persistent chain home outside the repo (matches `ops/systemd/env/nilchaind.env` defaults).
sudo mkdir -p /var/lib/nilstore
sudo chown -R "$USER":"$USER" /var/lib/nilstore

# One-time init (hub only; no local providers; no web).
NIL_HOME=/var/lib/nilstore/nilchaind PROVIDER_COUNT=0 START_WEB=0 ./scripts/run_devnet_alpha_multi_sp.sh start
```

Note: the bootstrap script binds LCD + EVM JSON-RPC to localhost by default (safe for the hub-behind-Caddy profile).
If you intentionally want to bind them to `0.0.0.0` for LAN / non-proxy debugging, set `NIL_BIND_ALL=1` and firewall accordingly.

Copy out (and store safely):
- the printed `SP Auth` token (also at `_artifacts/devnet_alpha_multi_sp/sp_auth.txt`)
- the printed `Home:` directory (should match the `NIL_HOME` you chose; keep it for systemd)

Stop the script-managed processes:

```bash
PROVIDER_COUNT=0 START_WEB=0 ./scripts/run_devnet_alpha_multi_sp.sh stop
```

Important: `run_devnet_alpha_multi_sp.sh start` **re-initializes** its chain home on every start. Use it only for bootstrap and local smoke tests.

### 3) systemd (hub services)

Systemd templates live in `ops/systemd/` (also see `ops/systemd/README.md`).

1) Install units:

```bash
sudo cp ops/systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
```

2) Install env files and fill in the `<set-me>` values:

```bash
sudo mkdir -p /etc/nilstore
sudo cp ops/systemd/env/*.env /etc/nilstore/

sudoedit /etc/nilstore/nilchaind.env
sudoedit /etc/nilstore/nil-gateway-router.env
sudoedit /etc/nilstore/nil-faucet.env
```

Minimum required edits:
- set `NIL_HOME` to the persistent chain home printed by the bootstrap script
- set `NIL_CHAIN_ID` (use the value printed by the bootstrap script, or your chosen chain id)
- set `NIL_GATEWAY_SP_AUTH` on the router and providers (shared secret)
- set `NIL_FAUCET_AUTH_TOKEN` (recommended for invite-only; share with collaborators out-of-band)
- recommended (hub behind Caddy): bind services to localhost and expose only via HTTPS (systemd env templates default to this):
  - `nilchaind.env`: `NIL_RPC_LADDR=tcp://127.0.0.1:26657`
  - `nil-gateway-router.env`: `NIL_LISTEN_ADDR=127.0.0.1:8080`
  - `nil-faucet.env`: `NIL_LISTEN_ADDR=127.0.0.1:8081`

3) Enable + start (recommended order):

```bash
sudo systemctl enable --now nilchaind
sudo systemctl enable --now nil-gateway-router
sudo systemctl enable --now nil-faucet
```

### 4) Caddy (HTTPS reverse proxy)

1) Copy the hub example and replace `example.com`:

```bash
sudo cp /opt/nilstore/ops/caddy/Caddyfile.hub.example /etc/caddy/Caddyfile
sudoedit /etc/caddy/Caddyfile
```

2) Reload:

```bash
sudo systemctl reload caddy || sudo systemctl restart caddy
```

### 5) Website build (static, served at `web.<domain>`)

The website is built with Vite; the **endpoint URLs are embedded at build time**.

Build requirements:
- Rust + `wasm-pack` (the build compiles `nil_core` → WASM)
- `wasm32-unknown-unknown` target (`rustup target add wasm32-unknown-unknown`)

Build example:

```bash
cd /opt/nilstore/nil-website
npm ci

VITE_API_BASE=https://faucet.<domain> \
VITE_LCD_BASE=https://lcd.<domain> \
VITE_GATEWAY_BASE=https://gateway.<domain> \
VITE_EVM_RPC=https://evm.<domain> \
VITE_COSMOS_CHAIN_ID=31337 \
VITE_CHAIN_ID=31337 \
VITE_ENABLE_FAUCET=1 \
npm run build
```

Note: the canonical list of env vars lives in `nil-website/website-spec.md`.

### 6) MetaMask “add network” snippet (share with collaborators)

In MetaMask → **Add network manually**:
- Network name: `NilStore Devnet`
- New RPC URL: `https://evm.<domain>`
- Chain ID: `31337` (`0x7a69`)
- Currency symbol: `ATOM` (EVM gas denom is `aatom` in the current devnet profile)
- Block explorer URL: (leave blank)

### 7) Verify (hub)

Sanity checks (replace `<domain>`):

```bash
curl -fsS https://lcd.<domain>/cosmos/base/tendermint/v1beta1/node_info >/dev/null
curl -fsS https://lcd.<domain>/nilchain/nilchain/v1/params >/dev/null
curl -fsS https://evm.<domain> -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' >/dev/null
curl -fsS https://gateway.<domain>/health >/dev/null
curl -fsS -o /dev/null -w '%{http_code}\n' https://faucet.<domain>/faucet
curl -fsS https://web.<domain>/ >/dev/null
```

## Economics knobs (soft launch)

Nilchain module params are stored in genesis under `app_state.nilchain.params` and can be patched at init-time
by `scripts/run_devnet_alpha_multi_sp.sh` via env vars.

Recommended soft-launch defaults:
- Keep costs **low but non-zero**: set a small `deal_creation_fee`, non-zero `base_retrieval_fee`, and either:
  - set a static non-zero `storage_price`, or
  - enable the (bounded) dynamic pricing controller.

Supported genesis overrides (all optional):
- Static pricing:
  - `NIL_DEAL_CREATION_FEE` (coin, e.g. `10stake`)
  - `NIL_STORAGE_PRICE` (LegacyDec string, e.g. `0.00000000001`)
  - `NIL_BASE_RETRIEVAL_FEE` (coin, e.g. `1stake`)
  - `NIL_RETRIEVAL_PRICE_PER_BLOB` (coin, e.g. `1stake`)
- Dynamic pricing (devnet experiment; disabled by default):
  - `NIL_DYNAMIC_PRICING_ENABLED=1`
  - Storage: `NIL_STORAGE_PRICE_MIN`, `NIL_STORAGE_PRICE_MAX`, `NIL_STORAGE_TARGET_UTILIZATION_BPS`
  - Retrieval: `NIL_RETRIEVAL_PRICE_PER_BLOB_MIN`, `NIL_RETRIEVAL_PRICE_PER_BLOB_MAX`, `NIL_RETRIEVAL_TARGET_BLOBS_PER_EPOCH`
  - Clamp: `NIL_DYNAMIC_PRICING_MAX_STEP_BPS` (0 = no clamp)

Notes:
- When `NIL_DYNAMIC_PRICING_ENABLED=1` and a `*_MIN` value is provided, the init script defaults the current
  price (`storage_price` / `retrieval_price_per_blob`) to the min unless explicitly set.
- These are just genesis-time knobs; governance can update params later if desired.

## One-time: hub bootstrap (fastest path)

The quickest way to get a working hub is to bring up a hub-only stack once (no local providers) and then switch to systemd.

1) Start hub-only devnet once:

```bash
PROVIDER_COUNT=0 START_WEB=0 ./scripts/run_devnet_alpha_multi_sp.sh start
```

Example (enable bounded dynamic pricing at startup):

```bash
NIL_DYNAMIC_PRICING_ENABLED=1 \
NIL_DYNAMIC_PRICING_MAX_STEP_BPS=500 \
NIL_STORAGE_PRICE_MIN=0.00000000001 \
NIL_STORAGE_PRICE_MAX=0.00000000010 \
NIL_STORAGE_TARGET_UTILIZATION_BPS=8000 \
NIL_RETRIEVAL_PRICE_PER_BLOB_MIN=1stake \
NIL_RETRIEVAL_PRICE_PER_BLOB_MAX=5stake \
NIL_RETRIEVAL_TARGET_BLOBS_PER_EPOCH=1000 \
PROVIDER_COUNT=0 START_WEB=0 ./scripts/run_devnet_alpha_multi_sp.sh start
```

2) Copy out (and store safely):
- The printed `SP Auth` token (router↔provider secret). Also saved at `_artifacts/devnet_alpha_multi_sp/sp_auth.txt`.
- The chain home directory used by the script (printed as `Home:`).

3) Stop the script-managed processes:

```bash
PROVIDER_COUNT=0 START_WEB=0 ./scripts/run_devnet_alpha_multi_sp.sh stop
```

Important: `run_devnet_alpha_multi_sp.sh start` **re-initializes** its chain home on every start. Do not use it as a long-running “service manager” for the soft launch.

## Hub: long-running (systemd templates)

Systemd templates live in `ops/systemd/`.

Minimum units to run on the hub:
- `ops/systemd/nilchaind.service`
- `ops/systemd/nil-gateway-router.service`
- `ops/systemd/nil-faucet.service` (optional but recommended for collaborators)

Use the env templates under `ops/systemd/env/` and make sure:
- All hub services share the same `NIL_HOME` (chain home directory).
- `nil-gateway-router` and all providers share the same `NIL_GATEWAY_SP_AUTH`.

## Provider onboarding

Send each collaborator:
- Hub endpoints (rpc/lcd/evm/gateway/faucet)
- The chain ID(s)
- The shared router↔provider auth token (`NIL_GATEWAY_SP_AUTH`)

Then have them follow:

- `docs/REMOTE_SP_JOIN_QUICKSTART.md`

## Faucet / funding (collaborators)

Collaborators must have funds for gas (and any protocol fees). For the current devnet profile:
- EVM gas denom is `aatom` (see `nilchain` params / genesis).
- The faucet can send both `aatom` and `stake` (default `NIL_AMOUNT`).

Faucet access control (recommended for invite-only):
- Deploy behind reverse-proxy auth, and/or set `NIL_FAUCET_AUTH_TOKEN` on the faucet service.
  - When set, requests MUST include `X-Nil-Faucet-Auth: <token>`.

Faucet request (example):

```bash
curl -X POST -H "Content-Type: application/json" \
  -H "X-Nil-Faucet-Auth: <token>" \
  -d '{"address":"nil1..."}' \
  https://faucet.<domain>/faucet
```

Website UI (optional):
- If you enable faucet funding in the web build (`VITE_ENABLE_FAUCET=1`), collaborators can paste the token into the UI
  (Dashboard / First File wizard) and then use the “Get Testnet NIL” button.

## Collaborator “first file” smoke

For a collaborator validating their SP is actually participating:

1) Use the website to upload a file.
2) Retrieve it back (byte-for-byte).
3) If retrieval fails, grab:
   - the hub `X-Nil-Provider` response header (who served the bytes)
   - the provider’s `/health` response
   - the hub router logs around the request

## Troubleshooting (hub)

- Provider doesn’t show up on `/nilchain/nilchain/v1/providers`:
  - the registration tx likely failed (fund provider key for gas)
- Router can’t reach provider:
  - endpoint multiaddr not reachable from hub (firewall/NAT)
  - `NIL_GATEWAY_SP_AUTH` mismatch between router and provider
- Fetch fails with “missing X-Nil-Session-Id”:
  - sessions are **required by default** (`NIL_REQUIRE_ONCHAIN_SESSION=1`)

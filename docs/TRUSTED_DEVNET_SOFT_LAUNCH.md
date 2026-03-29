# Trusted Devnet Soft Launch (Feb 2026)

Goal: onboard **10–20 trusted collaborators** (invite-only) to run Storage Providers (SPs) and to test end-to-end flows (create deal → upload → commit → retrieve) for **2–3 weeks**.

This doc is written for the **hub operator** and **remote providers**.

Related:
- Provider endpoint types: `docs/networking/PROVIDER_ENDPOINTS.md`
- Remote SP join quickstart: `docs/REMOTE_SP_JOIN_QUICKSTART.md`
- Monitoring checklist: `docs/TRUSTED_DEVNET_MONITORING_CHECKLIST.md`

## Architecture (locked for soft launch)

- **Hub** runs (either public VPS or home server behind NAT):
  - `nilchaind` (CometBFT RPC + LCD + EVM JSON-RPC)
  - `nil_gateway` in **router** mode
  - `nil_faucet` (enabled, rate-limited; collaborator-only)
  - `nil-website` (static build behind HTTPS)
- **Providers (remote SPs)** run (direct endpoint or Cloudflare Tunnel endpoint):
  - `nil_gateway` in **provider** mode (one per SP)
- **Users** interact via:
  - Website + MetaMask (wallet-first), or curl for debugging
  - Optional local Gateway app (`nil_gateway_gui` / `nil_gateway`) on `http://localhost:8080`

Security posture:
- This is **trusted** and **invite-only** (not Sybil resistant).
- The router↔provider channel uses a shared secret (`NIL_GATEWAY_SP_AUTH`). Treat it like a password.

## Public endpoints (recommended)

Use HTTPS subdomains (reverse-proxied to localhost ports):

- `https://rpc.<domain>` → `http://127.0.0.1:26657` (CometBFT RPC)
- `https://lcd.<domain>` → `http://127.0.0.1:1317` (LCD REST)
- `https://evm.<domain>` → `http://127.0.0.1:8545` (EVM JSON-RPC)
- `https://faucet.<domain>` → `http://127.0.0.1:8081` (faucet)
- `https://web.<domain>` → static website build (optional if hosted elsewhere)

Gateway policy for this soft launch:
- Do **not** publish a shared `gateway.<domain>` endpoint.
- Keep router gateway local-only on the hub (`127.0.0.1:<router-port>`).
- Website users should run a local Gateway when they want localhost gateway-assisted flows.

Reverse proxy templates:
- Caddy examples live in `ops/caddy/` (`ops/caddy/Caddyfile.hub.example` + `ops/caddy/Caddyfile.provider.example`).

## Connectivity profiles (choose one)

### Profile A — Public ingress + Caddy (default)

- Hub has reachable inbound `80/443`.
- DNS (`rpc/lcd/evm/faucet/web`) resolves directly to the hub public IP.
- Caddy terminates TLS and proxies to localhost ports.

### Profile B — Home server behind NAT/CGNAT + Cloudflare Tunnel

- Hub is not directly reachable from the internet.
- `cloudflared` publishes the same public hostnames and forwards to localhost ports.
- Inbound `80/443` on the hub is not required.
- Provider machines can also use Cloudflare Tunnel endpoints (`/dns4/<host>/tcp/443/https`) when they cannot open inbound ports.
- Endpoint details for providers: `docs/networking/PROVIDER_ENDPOINTS.md`.

## Hub runbook (blank box → running devnet)

This section is the **hub operator** checklist for standing up public endpoints on either:
- a public VPS (Profile A), or
- a home server behind NAT/CGNAT (Profile B).

### 0) Choose ingress profile (required)

#### Profile A (public ingress + Caddy)

1) Create DNS records (A/AAAA) for:
- `rpc.<domain>`
- `lcd.<domain>`
- `evm.<domain>`
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

#### Profile B (home server behind NAT/CGNAT + Cloudflare Tunnel)

1) In Cloudflare DNS, use proxied hostnames for:
- `rpc.<domain>`
- `lcd.<domain>`
- `evm.<domain>`
- `faucet.<domain>`
- `web.<domain>` (optional if website is hosted separately, e.g. GitHub/Netlify)

2) Keep only SSH inbound to the server (typically `22/tcp` on LAN/VPN as you prefer).

3) Keep all NilStore services bound to localhost (`127.0.0.1`), then publish them through `cloudflared` (section 4B).

### 1) Install prerequisites (one-time)

You need toolchains to build binaries + the static website:
- Go (see `go.mod`; currently Go `1.25.x`)
- Rust (stable) + `wasm-pack` + `wasm32-unknown-unknown`
- Node.js + npm
- Caddy (Profile A reverse proxy, or Profile B local static web server on `127.0.0.1:8088`)
- cloudflared (Profile B)

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

If you need to re-run bootstrap later, the script will refuse to delete an existing non-`_artifacts/` home unless you explicitly opt in:

```bash
NIL_HOME=/var/lib/nilstore/nilchaind NIL_REINIT_HOME=1 PROVIDER_COUNT=0 START_WEB=0 ./scripts/run_devnet_alpha_multi_sp.sh start
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

Important: `run_devnet_alpha_multi_sp.sh start` **wipes/re-initializes** its chain home when the home is under `_artifacts/` (default) or when `NIL_REINIT_HOME=1` is set. Use it only for bootstrap and local smoke tests.

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
- set `LD_LIBRARY_PATH=/opt/nilstore/nil_core/target/release` in all nilstore env files
- recommended (hub behind Caddy or Cloudflare Tunnel): bind services to localhost and expose only via the public edge:
  - `nilchaind.env`: `NIL_RPC_LADDR=tcp://127.0.0.1:26657`
  - `nil-gateway-router.env`: `NIL_LISTEN_ADDR=127.0.0.1:8080` (or another free local port if `8080` is occupied)
  - `nil-faucet.env`: `NIL_LISTEN_ADDR=127.0.0.1:8081`

3) Enable + start (recommended order):

```bash
sudo systemctl enable --now nilchaind
sudo systemctl enable --now nil-gateway-router
sudo systemctl enable --now nil-faucet
```

### 4) Caddy (HTTPS reverse proxy, Profile A)

If you are using Profile B (Cloudflare Tunnel), skip this section and use section 4B.

1) Copy the hub example and replace `example.com`:

```bash
sudo cp /opt/nilstore/ops/caddy/Caddyfile.hub.example /etc/caddy/Caddyfile
sudoedit /etc/caddy/Caddyfile
```

2) Reload:

```bash
sudo systemctl reload caddy || sudo systemctl restart caddy
```

### 4B) Cloudflare Tunnel (NAT/CGNAT profile, replaces public ingress)

Use this when the hub is behind NAT and you cannot expose inbound `80/443`.

1) Authenticate and create the hub tunnel:

```bash
cloudflared tunnel login
cloudflared tunnel create nilstore-hub
cloudflared tunnel route dns nilstore-hub rpc.<domain>
cloudflared tunnel route dns nilstore-hub lcd.<domain>
cloudflared tunnel route dns nilstore-hub evm.<domain>
cloudflared tunnel route dns nilstore-hub faucet.<domain>
# Optional if this host serves web.<domain>:
cloudflared tunnel route dns nilstore-hub web.<domain>
```

2) Create `/etc/cloudflared/config.yml`:

```yaml
tunnel: <HUB_TUNNEL_ID>
credentials-file: /etc/cloudflared/<HUB_TUNNEL_ID>.json
ingress:
  - hostname: rpc.<domain>
    service: http://127.0.0.1:26657
  - hostname: lcd.<domain>
    service: http://127.0.0.1:1317
  - hostname: evm.<domain>
    service: http://127.0.0.1:8545
  - hostname: faucet.<domain>
    service: http://127.0.0.1:8081
  # Optional if this host serves web.<domain>:
  - hostname: web.<domain>
    service: http://127.0.0.1:8088
  - service: http_status:404
```

3) Run a local web static server at `127.0.0.1:8088` (one simple option):

```bash
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
{
  auto_https off
}

:8088 {
  bind 127.0.0.1
  root * /opt/nilstore/nil-website/dist
  encode zstd gzip
  file_server
}
EOF
sudo systemctl restart caddy
```

Operational note:
- `web.<domain>` serves whatever files exist under `/opt/nilstore/nil-website/dist` (or whatever path you configure in Caddy).
- If you build the website from a different checkout than the one Caddy serves, you **must** publish that build output into the served `dist/` directory or `web.<domain>` will keep showing the older site.
- Recommended pattern for this host profile:
  - build from the checkout you actually want to publish
  - sync the resulting `nil-website/dist/` into `/opt/nilstore/nil-website/dist`
  - then verify `http://127.0.0.1:8088/` before checking `https://web.<domain>/`

4) Install the tunnel credentials/config under `/etc/cloudflared/`, then run the tunnel as a service.
Package-manager path (preferred when apt/dnf is healthy):

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

If package-manager state is broken, install `cloudflared` from the official GitHub release binary:

```bash
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) CF_ARCH=amd64 ;;
  aarch64|arm64) CF_ARCH=arm64 ;;
  *) echo "unsupported arch: $ARCH" && exit 1 ;;
esac
curl -fL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}" -o /tmp/cloudflared
chmod +x /tmp/cloudflared
sudo install -m 0755 /tmp/cloudflared /usr/local/bin/cloudflared
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

5) Validate public endpoints:

```bash
curl -fsS https://rpc.<domain>/status >/dev/null
# Optional if this host serves web.<domain>:
curl -fsS https://web.<domain>/ >/dev/null
```

### 4C) Profile B local multi-SP: publish `sp1/sp2/sp3` via Cloudflare Tunnel

If you run multiple provider gateways on the hub host (for example local RS `2+1` on `:8091/:8092/:8093`), publish each provider under its own hostname:

- `sp1.<domain>` → `http://127.0.0.1:8091`
- `sp2.<domain>` → `http://127.0.0.1:8092`
- `sp3.<domain>` → `http://127.0.0.1:8093`

Recommended pattern: use a **separate** tunnel for provider hostnames so hub ingress config and provider ingress config are independent.

```bash
cloudflared tunnel create nilstore-providers
cloudflared tunnel route dns nilstore-providers sp1.<domain>
cloudflared tunnel route dns nilstore-providers sp2.<domain>
cloudflared tunnel route dns nilstore-providers sp3.<domain>
```

Example user-level config (`~/.config/cloudflared/providers.<domain>.yml`):

```yaml
tunnel: <PROVIDER_TUNNEL_ID>
credentials-file: /home/<user>/.cloudflared/<PROVIDER_TUNNEL_ID>.json
ingress:
  - hostname: sp1.<domain>
    service: http://127.0.0.1:8091
  - hostname: sp2.<domain>
    service: http://127.0.0.1:8092
  - hostname: sp3.<domain>
    service: http://127.0.0.1:8093
  - service: http_status:404
```

Run it with user systemd (works without root changes to `/etc/cloudflared/config.yml`):

```bash
loginctl enable-linger <user>
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/cloudflared-providers.service <<'EOF'
[Unit]
Description=cloudflared tunnel for NilStore provider hostnames
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/cloudflared --no-autoupdate --config %h/.config/cloudflared/providers.<domain>.yml tunnel run
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now cloudflared-providers.service
```

Then register provider endpoints on-chain as:

- `/dns4/sp1.<domain>/tcp/443/https`
- `/dns4/sp2.<domain>/tcp/443/https`
- `/dns4/sp3.<domain>/tcp/443/https`

If the router/local Gateway runs on the same host as those provider processes, set a local upload fast-path override so Mode2 uploads avoid Cloudflare round-trips:

```bash
export NIL_PROVIDER_HTTP_BASE_OVERRIDES="sp1.<domain>=http://127.0.0.1:8091,sp2.<domain>=http://127.0.0.1:8092,sp3.<domain>=http://127.0.0.1:8093"
```

- Supported keys in `NIL_PROVIDER_HTTP_BASE_OVERRIDES` are:
  - provider address (`nil1...`)
  - endpoint hostname (`sp1.<domain>`)
  - full endpoint multiaddr (`/dns4/sp1.<domain>/tcp/443/https`)
- Value must be an `http://` or `https://` base URL.
- Keep this override only on hosts that can directly reach provider processes; do not enable it for remote collaborators.

### 5) Website build (static, served at `web.<domain>`)

Skip this section if your website is already hosted elsewhere (for example a GitHub-integrated deploy).

The website is built with Vite.

- You can set explicit endpoint URLs at build time (`VITE_*` vars below).
- If deployed on `nilstore.org` (or `*.nilstore.org`) and `VITE_*` are omitted, the app auto-infers:
  - `https://faucet.nilstore.org`
  - `https://lcd.nilstore.org`
  - `https://evm.nilstore.org`
- Gateway remains localhost-only (`http://localhost:8080`) and is treated as a user-local app.
- Recommended local Gateway distribution for collaborators: `nil_gateway_gui` release artifacts from `https://github.com/Nil-Store/nil-store/releases/latest`.

Build requirements:
- Rust + `wasm-pack` (the build compiles `nil_core` → WASM)
- `wasm32-unknown-unknown` target (`rustup target add wasm32-unknown-unknown`)

Build example:

```bash
cd /opt/nilstore/nil-website
npm ci

VITE_API_BASE=https://faucet.<domain> \
VITE_LCD_BASE=https://lcd.<domain> \
VITE_EVM_RPC=https://evm.<domain> \
VITE_COSMOS_CHAIN_ID=20260211 \
VITE_CHAIN_ID=20260211 \
VITE_ENABLE_FAUCET=1 \
# Optional (public/demo convenience): embed faucet auth token in web build.
# WARNING: anyone with browser access can extract and use this token.
VITE_FAUCET_AUTH_TOKEN=<token> \
npm run build
```

If `/opt/nilstore` is your long-running hub checkout and you built from that same checkout, the build is already in the served location.

If you built from a different checkout (for example a newer workspace under `~/dev/...`), publish the output into the hub-served path:

```bash
rm -rf /opt/nilstore/nil-website/dist
cp -a /path/to/your/current/checkout/nil-website/dist /opt/nilstore/nil-website/dist
```

Then verify the local static server is serving the new build:

```bash
curl -fsS http://127.0.0.1:8088/ >/dev/null
```

Helper script (from repo root):

```bash
scripts/build_website_public.sh <domain>
# example:
scripts/build_website_public.sh nilstore.org
```

Note: the canonical list of env vars lives in `nil-website/website-spec.md`.

### 6) MetaMask “add network” snippet (share with collaborators)

In MetaMask → **Add network manually**:
- Network name: `NilStore Devnet`
- New RPC URL: `https://evm.<domain>`
- Chain ID: `20260211` (`0x1352573`)
- Currency symbol: `ATOM` (EVM gas denom is `aatom` in the current devnet profile)
- Block explorer URL: (leave blank)

### 7) Verify (hub)

Sanity checks (replace `<domain>`):

```bash
curl -fsS https://lcd.<domain>/cosmos/base/tendermint/v1beta1/node_info >/dev/null
curl -fsS https://lcd.<domain>/nilchain/nilchain/v1/params >/dev/null
curl -fsS https://evm.<domain> -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' >/dev/null
curl -fsS -o /dev/null -w '%{http_code}\n' https://faucet.<domain>/faucet
curl -fsS https://web.<domain>/ >/dev/null
# local-only router gateway check (run on hub host):
curl -fsS http://127.0.0.1:8080/health >/dev/null
# local static website check (run on hub host if web is served here):
curl -fsS http://127.0.0.1:8088/ >/dev/null
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

Important: `run_devnet_alpha_multi_sp.sh start` **wipes/re-initializes** its chain home when the home is under `_artifacts/` (default) or when `NIL_REINIT_HOME=1` is set. Do not use it as a long-running “service manager” for the soft launch.

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
- Hub endpoints (rpc/lcd/evm/faucet)
- The chain ID(s)
- The shared router↔provider auth token (`NIL_GATEWAY_SP_AUTH`)

Then have them follow:

- `docs/REMOTE_SP_JOIN_QUICKSTART.md`
- `docs/networking/PROVIDER_ENDPOINTS.md` (choose `direct` or `cloudflare-tunnel` endpoint type)

### Optional: Local multi-provider Phase A (single host, RS 2+1)

For trusted-devnet bring-up, you can run multiple logical providers on the hub host itself.

- Recommended target for Phase A: `3` providers (`K=2`, `M=1`).
- For externally reachable browser flows, register public HTTPS provider endpoints on-chain:
  - `/dns4/sp1.<domain>/tcp/443/https`
  - `/dns4/sp2.<domain>/tcp/443/https`
  - `/dns4/sp3.<domain>/tcp/443/https`
- Keep `127.0.0.1` endpoint registration only for temporary local-only debugging.
- Important protocol caveat: provider endpoints are immutable per provider address in the current devnet build.
  - If you accidentally register `/ip4/127.0.0.1/...` and need public endpoints later, rotate to new provider keys, register the public endpoints, and mark old providers as draining.
- Keep each provider isolated with its own:
  - `NIL_HOME` (separate keyring + state)
  - `NIL_UPLOAD_DIR`
  - `NIL_SESSION_DB_PATH`
- If faucet throttling slows provider funding, fund provider keys directly from the local `faucet` key via `nilchaind tx bank send`.

Provider health checks:

```bash
scripts/devnet_healthcheck.sh provider --provider http://127.0.0.1:8091 --hub-lcd https://lcd.<domain> --provider-addr nil1...
scripts/devnet_healthcheck.sh provider --provider http://127.0.0.1:8092 --hub-lcd https://lcd.<domain> --provider-addr nil1...
scripts/devnet_healthcheck.sh provider --provider http://127.0.0.1:8093 --hub-lcd https://lcd.<domain> --provider-addr nil1...
scripts/devnet_healthcheck.sh provider --provider https://sp1.<domain> --hub-lcd https://lcd.<domain> --provider-addr nil1...
scripts/devnet_healthcheck.sh provider --provider https://sp2.<domain> --hub-lcd https://lcd.<domain> --provider-addr nil1...
scripts/devnet_healthcheck.sh provider --provider https://sp3.<domain> --hub-lcd https://lcd.<domain> --provider-addr nil1...
```

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
- If you enable faucet funding in the web build (`VITE_ENABLE_FAUCET=1`), collaborators can:
  - paste the token into the UI (Dashboard / First File wizard), or
  - use a deployment-level token via `VITE_FAUCET_AUTH_TOKEN` so no manual token entry is required.

## Collaborator “first file” smoke

For a collaborator validating their SP is actually participating:

1) Use the website to create a deal (trusted-devnet default: Mode 2 `2+1`).
2) Wait for the success message: `Capacity Allocated. Deal ID: <id>`.
3) Select that exact deal row, upload a file, and commit.
   - In local-gateway Mode 2 fast path, the UI may go directly to `Commit to Chain` (no separate upload button).
4) Verify on-chain deal state is updated:

```bash
curl -sf https://lcd.<domain>/nilchain/nilchain/v1/deals/<id> | jq '.deal | {id,size,manifest_root,total_mdus,witness_mdus}'
```

5) Verify provider-side file presence (local Phase A example):

```bash
curl -sf "http://127.0.0.1:8091/gateway/list-files/<manifest_root_hex>?deal_id=<id>&owner=<nil1...>" | jq
curl -sf "http://127.0.0.1:8092/gateway/list-files/<manifest_root_hex>?deal_id=<id>&owner=<nil1...>" | jq
curl -sf "http://127.0.0.1:8093/gateway/list-files/<manifest_root_hex>?deal_id=<id>&owner=<nil1...>" | jq
```

6) Retrieve it back (byte-for-byte).
7) If retrieval fails, grab:
   - the hub `X-Nil-Provider` response header (who served the bytes)
   - the provider’s `/health` response
   - the hub router logs around the request

### Public CLI smoke (wallet-first / tx relay disabled)

If `POST /gateway/create-deal-evm` returns `403`, that is expected in wallet-first mode (`NIL_ENABLE_TX_RELAY=0`).
Use this flow instead:

1) Generate EVM intents with `nil-website/scripts/sign_intent.ts` (`create-deal`, then `update-content`).
2) Submit intents directly on-chain:
   - `nilchaind tx nilchain create-deal-from-evm <create_payload.json> ...`
   - `nilchaind tx nilchain update-deal-content-from-evm <update_payload.json> ...`
3) Use local gateway data path:
   - upload: `POST http://127.0.0.1:8080/gateway/upload?deal_id=<id>`
   - plan session: `GET http://127.0.0.1:8080/gateway/plan-retrieval-session/<manifest_root>?...`
4) Open retrieval session with `nil-website/scripts/open_retrieval_session.ts`.
5) Sign fetch request with `nil-website/scripts/sign_intent.ts sign-fetch-request`.
6) Fetch bytes from `http://127.0.0.1:8080/gateway/fetch/<manifest_root>?...` with session + signed request headers.
7) Verify byte equality (`cmp` / sha256).

### Testnet CLI burner-key helper (onboarding bootstrap)

For trusted testnet onboarding where `EVM_PRIVKEY` is not pre-provisioned, use:

```bash
scripts/testnet_burner_upload.sh <file_path> [deal_id] [nilfs_path]
```

Behavior:
- generates a local burner EVM key
- requests faucet funds for its mapped `nil1...` address
- runs create/upload/commit via `scripts/enterprise_upload_job.sh`
- exports an encrypted keystore JSON for MetaMask import handoff

Recommended onboarding order:
- bring up the local gateway first
- run the burner helper with a small file to establish the wallet and first committed deal
- import the exported keystore into MetaMask
- continue browser and gateway verification with that same wallet

Important:
- this is **testnet-only** convenience flow, not production custody
- the flow still requires relay-capable gateway behavior for create/update endpoints

## Troubleshooting (hub)

- Provider doesn’t show up on `/nilchain/nilchain/v1/providers`:
  - the registration tx likely failed (fund provider key for gas)
- You registered `/ip4/127.0.0.1/...` and need public endpoint hostnames now:
  - endpoint updates are immutable for an already registered provider address
  - rotate to a new provider key, register `/dns4/<public-host>/tcp/443/https`, then set old provider to draining
- Router can’t reach provider:
  - endpoint multiaddr not reachable from hub (firewall/NAT)
  - provider tunnel misconfigured (`cloudflared` down, wrong hostname, or wrong local service port)
  - `NIL_GATEWAY_SP_AUTH` mismatch between router and provider
- Mode2 upload feels unexpectedly slow for small files:
  - ensure router + providers are on a build that supports sparse upload transport (`X-Nil-Full-Size`)
  - sparse transport is enabled by default; verify it wasn't disabled via `NIL_MODE2_SPARSE_UPLOAD=0`
  - restart router + providers after updating binaries/config so the optimization applies end-to-end
- Fetch fails with “missing X-Nil-Session-Id”:
  - sessions are **required by default** (`NIL_REQUIRE_ONCHAIN_SESSION=1`)
- systemd service exits with `203/EXEC`:
  - ensure unit templates use the shell wrapper in `ops/systemd/*.service` and run `systemctl daemon-reload`
- nil services fail with `libnil_core.so: cannot open shared object file`:
  - ensure `LD_LIBRARY_PATH=/opt/nilstore/nil_core/target/release` is set in each `/etc/nilstore/*.env`
- `nilchaind` fails binding gRPC `localhost:9090`:
  - set a free port in `/var/lib/nilstore/nilchaind/config/app.toml` (`[grpc].address`, e.g. `127.0.0.1:19090`)
- Multiple providers on one host fail to start (port bind errors):
  - either disable provider libp2p for the soft launch (`NIL_P2P_ENABLED=0`) or assign unique `NIL_P2P_LISTEN_ADDRS` per provider
- Provider logs are noisy with repeated `system liveness` proof failures (for example `no such file or directory` on old shard paths):
  - in the current gateway build, system liveness now auto-skips expired deals (`height >= end_block`) and applies per-challenge retry backoff for expected local-data misses
  - inspect counters via provider `/status`:
    - `curl -sf http://127.0.0.1:8091/status | jq '.extra | with_entries(select(.key|startswith("system_liveness_")))'`
  - inspect Mode2 reconstruction counters (assigned-provider vs fallback-provider behavior):
    - `curl -sf http://127.0.0.1:8091/status | jq '.extra | with_entries(select(.key|startswith("mode2_reconstruct_")))'`
    - key signals:
      - `mode2_reconstruct_fallback_provider_successes` rising means repair-aware fallback is actively serving chunks.
      - `mode2_reconstruct_not_enough_shards_failures` rising means RS quorum is not available for reconstruction.
  - if counters keep climbing for stale/old deals, run cleanup in dry-run first:
    - `scripts/devnet_provider_cleanup.sh --provider-root /var/lib/nilstore/providers --lcd http://127.0.0.1:1317`
    - apply mode (removes only expired/orphan dirs): `scripts/devnet_provider_cleanup.sh --provider-root /var/lib/nilstore/providers --lcd http://127.0.0.1:1317 --apply`

## Go/No-Go checklist (before inviting collaborators)

This is the “are we ready to invite people?” checklist. If any item is failing, treat it as a **No-Go** until resolved.

### Hub

- DNS + HTTPS are live for `rpc.*`, `lcd.*`, `evm.*`, `faucet.*` (and `web.*` if hosted on the hub) with correct CORS.
- Hub healthcheck passes (preferred):
  - `scripts/devnet_healthcheck.sh hub --rpc https://rpc.<domain> --lcd https://lcd.<domain> --evm https://evm.<domain> --faucet https://faucet.<domain> --gateway http://127.0.0.1:8080`
- Chain is producing blocks and not catching up:
  - `curl -s https://rpc.<domain>/status | jq '.result.sync_info.latest_block_height,.result.sync_info.catching_up'`
- Hub services are bound to localhost (recommended; only edge processes listen publicly: Caddy for Profile A, cloudflared for Profile B):
  - `ss -lntp | rg '(:26657|:1317|:8545|:8080|:8081)'` (replace `8080` if you chose a non-default router port)
- Faucet is configured for invite-only (recommended):
  - `NIL_FAUCET_AUTH_TOKEN` set and tested via curl.
- Pricing params are sane (and dynamic pricing status is intentional):
  - `curl -sf https://lcd.<domain>/nilchain/nilchain/v1/params | jq '.params.dynamic_pricing_enabled,.params.storage_price,.params.retrieval_price_per_blob'`

### Providers (remote SP baseline)

- Provider healthcheck passes:
  - `scripts/devnet_healthcheck.sh provider --provider https://sp1.<domain> --hub-lcd https://lcd.<domain> --provider-addr nil1...`
- Provider is visible on-chain and has reachable endpoints:
  - `curl -sf https://lcd.<domain>/nilchain/nilchain/v1/providers/<nil1...> | jq '.provider.endpoints'`
- Active providers are registered with public `/dns4/.../tcp/443/https` endpoints (not localhost):
  - `curl -sf https://lcd.<domain>/nilchain/nilchain/v1/providers | jq -r '.providers[] | select((.draining // false) == false) | [.address, (.endpoints[0] // \"\")] | @tsv'`
- Router↔provider auth secret matches (`NIL_GATEWAY_SP_AUTH`) and is stored out-of-band (treat like a password).

### Website (collaborator UX)

- Web build points at the correct HTTPS endpoints (`VITE_*` vars) and loads without console errors.
- “Connect wallet” works and MetaMask is on the correct network (RPC + chain id).
- Mode2 retrieval succeeds with temporary SP outage (website retries alternate providers when a primary fetch path fails).
- If faucet UI is enabled (`VITE_ENABLE_FAUCET=1`), the token flow works (paste token → fund → clear token works).
  - If using `VITE_FAUCET_AUTH_TOKEN`, verify faucet requests succeed without manual token entry.

### End-to-end smoke (must pass)

- From the website: create deal → upload → commit → retrieve a file; verify the retrieved bytes match the upload.
- Confirm requests are session-scoped (sessions are required by default):
  - successful fetch includes `X-Nil-Session-Id` on the request path
  - hub response includes `X-Nil-Provider` (who served the bytes)

### Rollback / safety (know before inviting)

- How to pause/disable the faucet quickly (systemd stop + reverse-proxy disable).
- How to rotate `NIL_GATEWAY_SP_AUTH` (requires restarting hub router + all providers).
- How to snapshot/backup the chain home (`NIL_HOME`) and the hub’s gateway data dirs before changes.

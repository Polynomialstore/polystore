# Caddy reverse proxy templates (Trusted Devnet Soft Launch)

These files are **optional** helpers for running the trusted devnet behind HTTPS subdomains.

Why:
- Give collaborators a single “copy/paste” set of endpoints (`https://rpc.*`, `https://lcd.*`, `https://evm.*`, etc.).
- Avoid exposing a bunch of raw ports directly to the internet.

## Hub (VPS)

1) Install Caddy (package or official installer).
2) Copy `ops/caddy/Caddyfile.hub.example` to `/etc/caddy/Caddyfile` and edit the domain names.
3) Ensure the hub services are running on localhost:
   - `nilchaind` RPC: `127.0.0.1:26657`
   - LCD/API: `127.0.0.1:1317`
   - EVM JSON-RPC: `127.0.0.1:8545`
   - Router gateway: `127.0.0.1:8080`
   - Faucet: `127.0.0.1:8081`
4) Build the website once:

```bash
cd /opt/nilstore/nil-website
npm ci
npm run build
```

Then `web.<domain>` serves `/opt/nilstore/nil-website/dist`.

## Provider (remote SP)

If a provider wants a clean HTTPS endpoint on port 443:
1) Run the provider gateway locally (e.g. `:8091`).
2) Use `ops/caddy/Caddyfile.provider.example` and set a DNS name (e.g. `sp1.<domain>`).
3) Register the provider endpoint multiaddr as:

- `/dns4/sp1.<domain>/tcp/443/https`

Notes:
- Caddy automatically handles TLS and WebSockets for these reverse proxies.


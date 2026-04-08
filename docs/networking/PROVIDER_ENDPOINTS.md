# Provider Endpoint Types (Testnet)

PolyStore providers (SPs) must register at least one reachable **endpoint multiaddr** on-chain via `register-provider`.

This doc defines the two supported endpoint "types" for testnet onboarding:

- `cloudflare-tunnel` (recommended for the trusted soft-launch / home-server path): expose HTTPS via Cloudflare Tunnel.
- `direct` (recommended when you already control stable public ingress): provider has an open inbound port or reverse proxy.

Future (not testnet-blocking):

- `webrtc`: NAT traversal optimization for browser/native clients.
- `hole-punch`: NAT traversal for native clients (QUIC/UDP).

## What Gets Registered On-Chain

The chain stores endpoints as strings, expected to be **multiaddrs**, e.g.:

- `/ip4/1.2.3.4/tcp/8091/http`
- `/dns4/sp.example.com/tcp/443/https`

The gateway router understands `/http` and `/https` and converts them to `http(s)://host:port`.

Important (current protocol behavior):
- `register-provider` is create-only per provider address.
- Endpoint updates are supported with `update-provider-endpoints`.
- If you accidentally register localhost endpoints (for example `/ip4/127.0.0.1/...`) or need to rotate to a better public endpoint:
  - keep the existing provider key when possible
  - update the endpoint list with `update-provider-endpoints`
  - only create a new provider key if the chain explicitly rejects endpoint updates or you intentionally want a new identity

## Helper: Print Endpoint Multiaddrs

From `polystore_gateway/`, you can generate the exact `--endpoint` values:

```bash
go run . --print-endpoints
```

Useful flags:

- `--json` or `--format=json` to emit machine-readable output
- `--include-p2p` to also print optional libp2p endpoints (not required for the `direct`/`cloudflare-tunnel` testnet posture)

Environment variables used by the helper:

- `NIL_PUBLIC_HTTP_MULTIADDR` (highest precedence): explicit multiaddr to print
- `NIL_CLOUDFLARE_TUNNEL_HOSTNAME`: if set, prints `/dns4/<host>/tcp/443/https` and labels as `cloudflare-tunnel`
- `NIL_PUBLIC_HTTP_HOST` / `NIL_PUBLIC_HTTP_PORT` / `NIL_PUBLIC_HTTP_SCHEME`: used for `direct` derivation (falls back to `NIL_LISTEN_ADDR`)

## Type: direct (recommended when public ingress is already available)

Goal: make the provider reachable at `https://sp.example.com` and register:

- `/dns4/sp.example.com/tcp/443/https`

One straightforward approach is to run the provider gateway locally on `:8082` and use a reverse proxy on `:443`:

```bash
# Provider machine
cd polystore_gateway
NIL_LISTEN_ADDR=:8082 NIL_GATEWAY_ROUTER=0 go run .
```

Example TLS reverse proxy (Caddy):

```bash
# Provider machine, requires DNS + inbound 443
caddy reverse-proxy --from sp.example.com --to localhost:8082
```

Now print the endpoint to register:

```bash
cd polystore_gateway
NIL_PUBLIC_HTTP_HOST=sp.example.com NIL_PUBLIC_HTTP_SCHEME=https NIL_PUBLIC_HTTP_PORT=443 \
  go run . --print-endpoints
```

Register it on-chain:

```bash
polystorechaind tx polystorechain register-provider General 1099511627776 \
  --from <your-key> \
  --chain-id <chain-id> \
  --yes \
  --endpoint "/dns4/sp.example.com/tcp/443/https"
```

Rotate or correct endpoints later:

```bash
polystorechaind tx polystorechain update-provider-endpoints \
  --from <your-key> \
  --chain-id <chain-id> \
  --yes \
  --endpoint "/dns4/sp.example.com/tcp/443/https"
```

## Type: cloudflare-tunnel (recommended soft-launch default)

Goal: expose the provider at `https://sp.example.com` without opening inbound ports.

This routes traffic through Cloudflare, but is simple and works behind NAT.

### Minimal tunnel setup

1) Run the provider gateway locally (same as direct):

```bash
cd polystore_gateway
NIL_LISTEN_ADDR=:8082 NIL_GATEWAY_ROUTER=0 go run .
```

2) Create a tunnel and map DNS:

```bash
cloudflared tunnel login
cloudflared tunnel create nilstore-sp
cloudflared tunnel route dns nilstore-sp sp.example.com
```

3) Configure ingress (example `~/.cloudflared/config.yml`):

```yaml
tunnel: <YOUR_TUNNEL_ID>
credentials-file: /Users/you/.cloudflared/<YOUR_TUNNEL_ID>.json
ingress:
  - hostname: sp.example.com
    service: http://localhost:8082
  - service: http_status:404
```

4) Run the tunnel:

```bash
cloudflared tunnel run nilstore-sp
```

5) Print the multiaddr to register:

```bash
cd polystore_gateway
NIL_CLOUDFLARE_TUNNEL_HOSTNAME=sp.example.com go run . --print-endpoints
```

6) Register the endpoint on-chain:

```bash
polystorechaind tx polystorechain register-provider General 1099511627776 \
  --from <your-key> \
  --chain-id <chain-id> \
  --yes \
  --endpoint "/dns4/sp.example.com/tcp/443/https"
```

Rotate or correct endpoints later with:

```bash
polystorechaind tx polystorechain update-provider-endpoints \
  --from <your-key> \
  --chain-id <chain-id> \
  --yes \
  --endpoint "/dns4/sp.example.com/tcp/443/https"
```

## Future Work (Not Testnet-Blocking)

### WebRTC (browser-friendly NAT traversal)

Medium-to-large lift. Typically needs:

- signaling channel (offer/answer + ICE candidates)
- STUN configuration (cheap, required in most NAT scenarios)
- optional TURN for worst-case networks (expensive; relays bytes)
- provider-side transport support (WebRTC data channel / compatible libp2p transport)

### Hole punching (native gateway)

Since we have native clients, we can attempt:

- direct QUIC/UDP + hole punching (with a coordination service)
- fallback to `direct` or `cloudflare-tunnel` endpoints when it fails

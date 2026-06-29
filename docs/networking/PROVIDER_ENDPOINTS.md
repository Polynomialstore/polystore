# Provider Endpoint Types (Testnet)

PolyStore providers (SPs) must register at least one reachable **endpoint multiaddr** on-chain via `register-provider`.

This doc defines the two supported endpoint "types" for testnet onboarding:

- `direct` (recommended when inbound `443` can reach the provider host): provider has an open inbound port or reverse proxy.
- `cloudflare-tunnel` (fallback when inbound ports are unavailable): expose HTTPS via Cloudflare Tunnel.

For the current `polynomialstore.com` SP deployment, direct DNS-only HTTPS is
the primary shape. This was chosen after empirical transfer tests showed a large
slowdown when Cloudflare Tunnel or orange-cloud/proxied `A` records carried SP
payload traffic, while the same origin was fast over direct HTTPS. See
`docs/networking/DIRECT_SP_HTTPS_RUNBOOK.md` for the validation procedure.

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

Shared `polynomialstore.com` devnet rule:

- The provider daemon may listen on `127.0.0.1:<port>` behind Caddy or
  Cloudflare Tunnel, but `127.0.0.1` must not be registered on-chain for the
  shared devnet.
- Register the public SP hostname multiaddrs:
  - `/dns4/sp1.polynomialstore.com/tcp/443/https`
  - `/dns4/sp2.polynomialstore.com/tcp/443/https`
  - `/dns4/sp3.polynomialstore.com/tcp/443/https`
- `scripts/run_devnet_provider.sh` rejects loopback endpoints for the default
  `polystore-public-testnet` profile. Use
  `POLYSTORE_ALLOW_LOCAL_PROVIDER_ENDPOINTS=1` only for an isolated local
  devnet where no remote user-gateway, website, or collaborator will resolve
  the provider endpoint.

## Helper: Print Endpoint Multiaddrs

From `polystore_gateway/`, you can generate the exact `--endpoint` values:

```bash
go run . --print-endpoints
```

Useful flags:

- `--json` or `--format=json` to emit machine-readable output
- `--include-p2p` to also print optional libp2p endpoints (not required for the `direct`/`cloudflare-tunnel` testnet posture)

Environment variables used by the helper:

- `POLYSTORE_PUBLIC_HTTP_MULTIADDR` (highest precedence): explicit multiaddr to print
- `POLYSTORE_CLOUDFLARE_TUNNEL_HOSTNAME`: if set, prints `/dns4/<host>/tcp/443/https` and labels as `cloudflare-tunnel`
- `POLYSTORE_PUBLIC_HTTP_HOST` / `POLYSTORE_PUBLIC_HTTP_PORT` / `POLYSTORE_PUBLIC_HTTP_SCHEME`: used for `direct` derivation (falls back to `POLYSTORE_LISTEN_ADDR`)

## Type: direct (recommended when public ingress is already available)

Goal: make the provider reachable at `https://sp.example.com` and register:

- `/dns4/sp.example.com/tcp/443/https`

One straightforward approach is to run the provider gateway locally on `:8082` and use a reverse proxy on `:443`:

```bash
# Provider machine
cd polystore_gateway
POLYSTORE_LISTEN_ADDR=:8082 POLYSTORE_GATEWAY_ROUTER=0 go run .
```

Example TLS reverse proxy (Caddy):

```bash
# Provider machine, requires DNS + inbound 443
caddy reverse-proxy --from sp.example.com --to localhost:8082
```

For a multi-provider host, Caddy can terminate TLS once on `443` and route by
hostname:

```caddyfile
sp1.example.com {
  reverse_proxy 127.0.0.1:8091
}

sp2.example.com {
  reverse_proxy 127.0.0.1:8092
}

sp3.example.com {
  reverse_proxy 127.0.0.1:8093
}
```

When using Cloudflare DNS with this profile, the SP records must be **DNS-only**
for bulk transfer. Orange-cloud/proxied records route traffic through
Cloudflare and can behave like the tunnel path for large provider payloads. If
large uploads or retrievals regress, benchmark direct origin HTTPS against the
Cloudflare path before changing provider-daemon code.

Now print the endpoint to register:

```bash
cd polystore_gateway
POLYSTORE_PUBLIC_HTTP_HOST=sp.example.com POLYSTORE_PUBLIC_HTTP_SCHEME=https POLYSTORE_PUBLIC_HTTP_PORT=443 \
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

For the current shared devnet hostnames, set the endpoint explicitly for the
daemon identity that actually serves each hostname:

```bash
PROVIDER_KEY=<key-serving-sp1> PROVIDER_ENDPOINT="$POLYSTORE_TESTNET_SP1_ENDPOINT" \
  ./scripts/run_devnet_provider.sh register
PROVIDER_KEY=<key-serving-sp2> PROVIDER_ENDPOINT="$POLYSTORE_TESTNET_SP2_ENDPOINT" \
  ./scripts/run_devnet_provider.sh register
PROVIDER_KEY=<key-serving-sp3> PROVIDER_ENDPOINT="$POLYSTORE_TESTNET_SP3_ENDPOINT" \
  ./scripts/run_devnet_provider.sh register
```

Do not assume `provider1` always maps to `sp1` after a recovery or chain
refresh. Verify the route before registering:

```bash
curl -fsS https://sp1.polynomialstore.com/status | jq -r '.provider.address'
curl -fsS https://sp2.polynomialstore.com/status | jq -r '.provider.address'
curl -fsS https://sp3.polynomialstore.com/status | jq -r '.provider.address'
```

## Recovery After a Stack Refresh

A refreshed local stack can leave two independent kinds of stale chain state:

- endpoint drift: a live provider still advertises `/ip4/127.0.0.1/...` on-chain
- health drift: a live provider is reachable and collateralized, but still has
  old soft-fault `provider_delinquent` or `provider_degraded` health from prior
  missed epochs

Fix endpoint drift in place with `update-provider-endpoints`; do not reset the
chain or rotate provider keys unless the identity is intentionally changing.

Fix health drift with an authorized provider/operator maintenance top-up after
the daemon is reachable and the provider has enough collateral headroom. The
keeper treats this as a check-in and clears recoverable soft/degraded placement
health, but it does not clear administrative states such as `Draining`, `Jailed`,
or `Exited`.

```bash
CHAIN_MODULE="${POLYSTORE_CHAIN_MODULE:-nilchain}" # older local binaries may use polystorechain
MAINTENANCE_BOND="${POLYSTORE_PROVIDER_MAINTENANCE_BOND:-5stake}"

polystorechaind tx "$CHAIN_MODULE" add-provider-bond "$PROVIDER_ADDRESS" "$MAINTENANCE_BOND" \
  --from "$PROVIDER_KEY" \
  --chain-id "$CHAIN_ID" \
  --node "$NODE_ADDR" \
  --home "$POLYSTORE_HOME" \
  --keyring-backend test \
  --gas auto \
  --gas-adjustment 1.6 \
  --gas-prices "$POLYSTORE_GAS_PRICES" \
  --yes
```

For the shared `polynomialstore.com` host, verify all public SPs are both
reachable and eligible before retrying deal creation:

```bash
for host in sp1.polynomialstore.com sp2.polynomialstore.com sp3.polynomialstore.com; do
  addr="$(curl -fsS "https://$host/status" | jq -r '.provider.address')"
  curl -fsS "$POLYSTORE_TESTNET_LCD_BASE/polystorechain/polystorechain/v1/providers/$addr/health" |
    jq --arg host "$host" '.health | {host: $host, address: .provider, lifecycle: .lifecycle_status, reason}'
  curl -fsS "$POLYSTORE_TESTNET_LCD_BASE/polystorechain/polystorechain/v1/providers/$addr/collateral" |
    jq '.collateral | {eligible_for_new_assignment, ineligibility_reason, assignment_headroom}'
done
```

## Type: cloudflare-tunnel (fallback when inbound ports are unavailable)

Goal: expose the provider at `https://sp.example.com` without opening inbound ports.

This routes traffic through Cloudflare, but is simple and works behind NAT.
Use it when the provider host cannot expose inbound `443`. If inbound `443` is
available, prefer the direct DNS-only HTTPS profile above.

### Minimal tunnel setup

1) Run the provider gateway locally (same as direct):

```bash
cd polystore_gateway
POLYSTORE_LISTEN_ADDR=:8082 POLYSTORE_GATEWAY_ROUTER=0 go run .
```

2) Create a tunnel and map DNS:

```bash
cloudflared tunnel login
cloudflared tunnel create polystore-sp
cloudflared tunnel route dns polystore-sp sp.example.com
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
cloudflared tunnel run polystore-sp
```

5) Print the multiaddr to register:

```bash
cd polystore_gateway
POLYSTORE_CLOUDFLARE_TUNNEL_HOSTNAME=sp.example.com go run . --print-endpoints
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

If a chain refresh already registered loopback endpoints, repair it in place
with the same provider keys instead of resetting the chain:

```bash
polystorechaind tx polystorechain update-provider-endpoints \
  --from <key-serving-sp1-or-sp2-or-sp3> \
  --chain-id <chain-id> \
  --yes \
  --endpoint "/dns4/sp1.polynomialstore.com/tcp/443/https"
```

Then query the provider list and verify that every non-draining provider used
by the shared stack advertises the matching `sp1`, `sp2`, or `sp3`
`/dns4/.../tcp/443/https` endpoint. Extra loopback-only records should be
drained or excluded from placement rather than left active.

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

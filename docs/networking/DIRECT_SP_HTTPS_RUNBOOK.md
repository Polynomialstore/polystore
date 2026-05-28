# Direct Storage Provider HTTPS Runbook

This runbook documents the preferred provider-daemon ingress shape for the
trusted devnet when the operator can forward inbound TCP `443` to the provider
host.

Use this shape for bulk provider traffic. Keep Cloudflare Tunnel as a fallback
for hosts that cannot receive inbound traffic.

## Current Network Shape

The current `polynomialstore.com` provider hostnames are expected to use:

- Cloudflare DNS records in **DNS-only** mode, not proxied.
- `A` records for `sp1.polynomialstore.com`, `sp2.polynomialstore.com`, and
  `sp3.polynomialstore.com` pointing at the current provider host public
  address.
- Caddy listening on public TCP `443` on the provider host.
- One public Let's Encrypt certificate covering all three SP hostnames.
- Host-based Caddy reverse proxy:
  - `sp1.polynomialstore.com` -> `127.0.0.1:8091`
  - `sp2.polynomialstore.com` -> `127.0.0.1:8092`
  - `sp3.polynomialstore.com` -> `127.0.0.1:8093`
- On-chain provider endpoints remain:
  - `/dns4/sp1.polynomialstore.com/tcp/443/https`
  - `/dns4/sp2.polynomialstore.com/tcp/443/https`
  - `/dns4/sp3.polynomialstore.com/tcp/443/https`

Do not commit the current provider host public IP address to the repo. Read it
from Cloudflare DNS, the router/NAT configuration, or operator notes when
operating the live deployment.

## Why DNS-only Direct HTTPS

Direct DNS-only HTTPS keeps the provider endpoint shape browser-friendly and
compatible with the existing multiaddrs while avoiding Cloudflare as the bulk
data path.

Empirical same-host transfer checks during the cutover showed:

- DNS-only direct HTTPS: tens of MB/s for 64 MiB uploads/downloads through the
  SP hostnames.
- Cloudflare Tunnel and Cloudflare-proxied `A` records: around 1 MiB/s for the
  same class of transfer in the Hawaii deployment.

Treat those numbers as deployment evidence, not a universal benchmark. The
operational conclusion is stable for this devnet: use direct DNS-only HTTPS for
SP payload paths when inbound `443` is available.

## Certificate Strategy

Use a local publicly trusted certificate. A Cloudflare Origin Certificate is not
enough for DNS-only mode because clients connect directly to the provider host.

Preferred certificate:

- one SAN certificate for exactly:
  - `sp1.polynomialstore.com`
  - `sp2.polynomialstore.com`
  - `sp3.polynomialstore.com`
- issued with ACME DNS-01 before DNS cutover
- loaded explicitly by Caddy

DNS-01 avoids the cutover window where DNS has moved but the origin does not yet
have a valid certificate.

Example with `lego` and a scoped Cloudflare token:

```bash
export CLOUDFLARE_DNS_API_TOKEN="<token-with-zone-dns-edit>"
export CLOUDFLARE_ZONE_API_TOKEN="$CLOUDFLARE_DNS_API_TOKEN"

lego \
  --path "$HOME/.config/polystore-bench/lego" \
  --email "<operator-email>" \
  --accept-tos \
  --dns cloudflare \
  --domains sp1.polynomialstore.com \
  --domains sp2.polynomialstore.com \
  --domains sp3.polynomialstore.com \
  --key-type ec256 \
  run
```

The live Caddy service must be able to read the resulting certificate and key.
Prefer a root-owned deployment path under `/etc/caddy` or `/var/lib/caddy`.
For local operator-owned cert storage, grant only the `caddy` service user read
access to the cert/key and traverse access to parent directories.

Renew before expiry:

```bash
export CLOUDFLARE_DNS_API_TOKEN="<token-with-zone-dns-edit>"
export CLOUDFLARE_ZONE_API_TOKEN="$CLOUDFLARE_DNS_API_TOKEN"

lego \
  --path "$HOME/.config/polystore-bench/lego" \
  --email "<operator-email>" \
  --accept-tos \
  --dns cloudflare \
  --domains sp1.polynomialstore.com \
  --domains sp2.polynomialstore.com \
  --domains sp3.polynomialstore.com \
  --key-type ec256 \
  renew

sudo systemctl reload caddy || sudo systemctl restart caddy
```

## Caddy Configuration

For the three-provider host, Caddy should terminate TLS on `443` and proxy each
hostname to its local provider-daemon port.

```caddyfile
{
	auto_https off
}

(polystore_sp_tls) {
	tls /path/to/sp1.polynomialstore.com.crt /path/to/sp1.polynomialstore.com.key
}

sp1.polynomialstore.com {
	import polystore_sp_tls
	reverse_proxy 127.0.0.1:8091
}

sp2.polynomialstore.com {
	import polystore_sp_tls
	reverse_proxy 127.0.0.1:8092
}

sp3.polynomialstore.com {
	import polystore_sp_tls
	reverse_proxy 127.0.0.1:8093
}
```

Keep `auto_https off` if this Caddy instance is intentionally not managing ACME
for these names. This prevents accidental HTTP redirect listeners and makes the
explicit cert/key the source of truth.

Validate before restarting:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl restart caddy
```

## DNS Cutover

Before cutover:

1. Confirm provider-daemons are healthy locally:

```bash
curl -sf http://127.0.0.1:8091/health
curl -sf http://127.0.0.1:8092/health
curl -sf http://127.0.0.1:8093/health
```

2. Confirm direct HTTPS works before DNS changes:

```bash
curl --resolve sp1.polynomialstore.com:443:<provider-public-ip> https://sp1.polynomialstore.com/health
curl --resolve sp2.polynomialstore.com:443:<provider-public-ip> https://sp2.polynomialstore.com/health
curl --resolve sp3.polynomialstore.com:443:<provider-public-ip> https://sp3.polynomialstore.com/health
```

3. Back up the existing Cloudflare DNS records.

Then replace the old tunnel CNAMEs with DNS-only `A` records:

```text
sp1.polynomialstore.com A <provider-public-ip> DNS-only
sp2.polynomialstore.com A <provider-public-ip> DNS-only
sp3.polynomialstore.com A <provider-public-ip> DNS-only
```

Do not use orange-cloud/proxied mode for provider payload paths unless you are
intentionally testing Cloudflare as the data path.

## Validation

After DNS changes:

```bash
for host in sp1.polynomialstore.com sp2.polynomialstore.com sp3.polynomialstore.com; do
  dig +short "$host" A
  curl --noproxy '*' -fsS -o /dev/null \
    -w "$host code=%{http_code} version=%{http_version} remote=%{remote_ip} tls=%{ssl_verify_result} time=%{time_total}\n" \
    "https://$host/health"
done
```

Expected:

- DNS returns the provider host public address, not Cloudflare anycast IPs.
- `remote_ip` is the provider host public address.
- HTTP status is `200`.
- TLS verify result is `0`.
- HTTP version is usually `2`.

For a safe network-path throughput check, add a temporary Caddy-only benchmark
route above the provider routes and remove it immediately after testing. Do not
POST arbitrary benchmark blobs to the live provider API unless the payload is a
valid protocol upload you intend to keep.

## Rollback

Rollback is DNS-only:

1. Restore the previous Cloudflare Tunnel CNAME records for
   `sp1.polynomialstore.com`, `sp2.polynomialstore.com`, and
   `sp3.polynomialstore.com`.
2. Set them back to proxied mode if they were proxied before.
3. Confirm `cloudflared-providers.service` is running on the provider host.

The on-chain multiaddrs do not need to change for rollback because both direct
HTTPS and Tunnel HTTPS use `/dns4/<host>/tcp/443/https`.

## Future Agent Notes

- Do not assume `cloudflared-providers.service` carries live SP traffic. In the
  current deployment it is a fallback while DNS-only direct HTTPS is primary.
- If `spN.polynomialstore.com` resolves to Cloudflare anycast IPs, the record is
  proxied or stale in a resolver cache.
- If it resolves to the provider host public address but HTTPS fails, inspect
  Caddy first, then provider-daemon health on the local `809N` port.
- If transfer speed regresses to around Tunnel-like throughput, check for an
  accidental orange-cloud/proxied DNS record before investigating provider code.

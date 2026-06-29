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
- Host-based Caddy reverse proxy to the local provider-daemon listeners, for
  example:
  - `sp1.polynomialstore.com` -> `127.0.0.1:8091`
  - `sp2.polynomialstore.com` -> `127.0.0.1:8092`
  - `sp3.polynomialstore.com` -> `127.0.0.1:8093`
- On-chain provider endpoints remain:
  - `/dns4/sp1.polynomialstore.com/tcp/443/https`
  - `/dns4/sp2.polynomialstore.com/tcp/443/https`
  - `/dns4/sp3.polynomialstore.com/tcp/443/https`

The `127.0.0.1:<port>` values above are private origin addresses only. Do not
register them in `Provider.endpoints` for the shared devnet. If a recovery or
chain refresh changes which local daemon serves a hostname, keep the on-chain
endpoint as the matching `sp1`, `sp2`, or `sp3`
`/dns4/.../tcp/443/https` hostname and update the reverse proxy or tunnel
route to point that hostname at the correct daemon.

Before submitting `register-provider` or `update-provider-endpoints`, verify
the hostname-to-provider identity mapping:

```bash
curl -fsS https://sp1.polynomialstore.com/status | jq -r '.provider.address'
curl -fsS https://sp2.polynomialstore.com/status | jq -r '.provider.address'
curl -fsS https://sp3.polynomialstore.com/status | jq -r '.provider.address'
```

Do not commit the current provider host public IP address to the repo. Read it
from Cloudflare DNS, the router/NAT configuration, or operator notes when
operating the live deployment.

## Why DNS-only Direct HTTPS

Direct DNS-only HTTPS keeps the provider endpoint shape browser-friendly and
compatible with the existing multiaddrs while avoiding Cloudflare as the bulk
data path.

This recommendation is empirical, not theoretical. It was adopted after
same-origin transfer checks showed that the provider-daemon and local reverse
proxy were healthy, while the Cloudflare transit path was the bottleneck for
large payloads in the Hawaii deployment.

Same-host transfer checks during the cutover showed:

- DNS-only direct HTTPS: tens of MB/s for 64 MiB uploads/downloads through the
  SP hostnames.
- Cloudflare Tunnel and Cloudflare-proxied `A` records: around 1 MiB/s for the
  same class of transfer in the Hawaii deployment.

Treat those numbers as deployment evidence, not a universal benchmark. The
operational conclusion is stable for this devnet: use direct DNS-only HTTPS for
SP payload paths when inbound `443` is available.

If future agents see slow provider upload or retrieval again, validate the
network path before changing provider code. A direct-origin path that is fast
and a Cloudflare path that is slow points at the DNS/proxy/tunnel layer, not the
provider-daemon.

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

If this host is temporarily using Cloudflare Tunnel instead of direct DNS-only
`A` records, the same identity rule applies: the tunnel ingress service may be
`http://127.0.0.1:<port>`, but the chain endpoint must still be the public
`/dns4/sp1.polynomialstore.com/tcp/443/https`,
`/dns4/sp2.polynomialstore.com/tcp/443/https`, or
`/dns4/sp3.polynomialstore.com/tcp/443/https` multiaddr.

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

Also verify the chain records after any stack refresh:

```bash
curl -fsS https://lcd.polynomialstore.com/polystorechain/polystorechain/v1/providers \
  | jq -r '.providers[] | [.address, (.draining // false), (.endpoints | join(","))] | @tsv'
```

Every non-draining shared-devnet SP should advertise one of the three
`sp1`, `sp2`, or `sp3` `/dns4/.../tcp/443/https` endpoints. If a
non-draining record advertises `/ip4/127.0.0.1/...`, update that provider
with `update-provider-endpoints` from its local key or mark the extra provider
draining if it is not one of the public three.

## Validating Cloudflare Slowdown

Use this procedure when troubleshooting slow uploads/downloads. It compares the
same origin server through two paths:

- direct origin HTTPS
- Cloudflare-proxied or Cloudflare Tunnel HTTPS

Do not POST arbitrary benchmark blobs to the live provider API unless the
payload is a valid protocol upload you intend to keep. Use a temporary
Caddy-only benchmark route or a disposable benchmark hostname.

### 1. Start a local benchmark sink

Create a 64 MiB payload:

```bash
dd if=/dev/urandom of=/tmp/polystore-netbench-64m.bin bs=1M count=64 status=progress
```

This small Go server uses only the standard library. It consumes upload bodies
and serves a fixed-size download stream without touching provider state.

```bash
cat >/tmp/polystore-netbench.go <<'EOF'
package main

import (
	"fmt"
	"io"
	"log"
	"net/http"
)

func main() {
	http.HandleFunc("/__netbench/upload", func(w http.ResponseWriter, r *http.Request) {
		n, err := io.Copy(io.Discard, r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		_, _ = fmt.Fprintf(w, "read=%d\n", n)
	})

	http.HandleFunc("/__netbench/download", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		http.ServeFile(w, r, "/tmp/polystore-netbench-64m.bin")
	})

	log.Fatal(http.ListenAndServe("127.0.0.1:18181", nil))
}
EOF

go run /tmp/polystore-netbench.go
```

### 2. Add a temporary Caddy route

Use either an existing SP hostname during a maintenance window or a temporary
benchmark hostname whose certificate is valid on the origin.

```caddyfile
sp-bench.example.com {
	tls /path/to/sp-bench.example.com.crt /path/to/sp-bench.example.com.key
	reverse_proxy /__netbench/* 127.0.0.1:18181
}
```

Validate and reload Caddy:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy || sudo systemctl restart caddy
```

Remove this route when testing is complete.

### 3. Measure direct origin HTTPS

Bypass DNS with `--connect-to` or `--resolve` so the request uses the same
hostname and SNI but connects directly to the provider host public address.

```bash
BENCH_HOST=sp-bench.example.com
ORIGIN_IP=<provider-public-ip>

curl --noproxy '*' --connect-to "$BENCH_HOST:443:$ORIGIN_IP:443" \
  -o /dev/null -w "direct download bytes=%{size_download} rate=%{speed_download} remote=%{remote_ip} time=%{time_total}\n" \
  "https://$BENCH_HOST/__netbench/download"

curl --noproxy '*' --connect-to "$BENCH_HOST:443:$ORIGIN_IP:443" \
  --data-binary "@/tmp/polystore-netbench-64m.bin" \
  -o /dev/null -w "direct upload bytes=%{size_upload} rate=%{speed_upload} remote=%{remote_ip} time=%{time_total}\n" \
  "https://$BENCH_HOST/__netbench/upload"
```

The `rate` values are bytes per second. Divide by `1048576` for MiB/s.

### 4. Measure Cloudflare path

For Cloudflare-proxied `A` testing, temporarily set the benchmark hostname to
proxied mode in Cloudflare DNS. For Tunnel testing, route the benchmark hostname
through `cloudflared` to the same local `127.0.0.1:18181` sink.

Then run the same requests without `--connect-to`:

```bash
curl --noproxy '*' \
  -o /dev/null -w "cloudflare download bytes=%{size_download} rate=%{speed_download} remote=%{remote_ip} time=%{time_total}\n" \
  "https://$BENCH_HOST/__netbench/download"

curl --noproxy '*' \
  --data-binary "@/tmp/polystore-netbench-64m.bin" \
  -o /dev/null -w "cloudflare upload bytes=%{size_upload} rate=%{speed_upload} remote=%{remote_ip} time=%{time_total}\n" \
  "https://$BENCH_HOST/__netbench/upload"
```

Expected troubleshooting signal:

- If direct origin HTTPS is fast and Cloudflare is much slower for the same
  payload, the bottleneck is the Cloudflare proxy/tunnel path.
- If both paths are slow, inspect local provider-daemon health, Caddy, NAT,
  disk, CPU, and uplink saturation before blaming Cloudflare.
- If `remote_ip` is a Cloudflare anycast address during the supposed direct
  test, the record is still proxied or the test did not bypass DNS correctly.

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
- If `sp1.polynomialstore.com`, `sp2.polynomialstore.com`, or
  `sp3.polynomialstore.com` resolves to Cloudflare anycast IPs, the record is
  proxied or stale in a resolver cache.
- If it resolves to the provider host public address but HTTPS fails, inspect
  Caddy first, then provider-daemon health on the local `809N` port.
- If transfer speed regresses to around Tunnel-like throughput, check for an
  accidental orange-cloud/proxied DNS record before investigating provider code.

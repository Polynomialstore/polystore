# Trusted Devnet Monitoring Checklist (Soft Launch)

This is a **minimal** checklist for keeping the Feb 2026 trusted devnet healthy.

## Hub (VPS) — daily checks

- Run the healthcheck script (recommended; `curl` required, `jq` optional):
  - Hub-local ports: `scripts/devnet_healthcheck.sh hub`
  - Public HTTPS endpoints + local router: `scripts/devnet_healthcheck.sh hub --rpc https://rpc.<domain> --lcd https://lcd.<domain> --evm https://evm.<domain> --gateway http://127.0.0.1:8080 --faucet https://faucet.<domain>`
- Chain is producing blocks:
  - `curl -s http://127.0.0.1:26657/status | jq '.result.sync_info.latest_block_height,.result.sync_info.catching_up'`
- LCD is responsive:
  - `curl -sf http://127.0.0.1:1317/cosmos/base/tendermint/v1beta1/node_info >/dev/null`
- EVM JSON-RPC is responsive:
  - `curl -sf -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' http://127.0.0.1:8545 >/dev/null`
- Router gateway is healthy:
  - `curl -sf http://127.0.0.1:8080/health >/dev/null`
- Faucet is healthy (if enabled):
  - `curl -sf http://127.0.0.1:8081/health >/dev/null`
- Pricing params are sane (and dynamic pricing status is intentional):
  - `curl -sf http://127.0.0.1:1317/nilchain/nilchain/v1/params | jq '.params.dynamic_pricing_enabled,.params.storage_price,.params.retrieval_price_per_blob'`

## Hub — resource / network checks

- Disk: `df -h` (watch the chain home + gateway upload dirs)
- RAM: `free -h`
- Open ports (hub-local): `ss -lntp | rg '(:26657|:1317|:8545|:8080|:8081)'`
- Reverse-proxy/TLS (if used): confirm each public subdomain returns 200s (and CORS headers where needed).

## Hub — logs

- `journalctl -u nilchaind -S today --no-pager | tail -n 200`
- `journalctl -u polystore-gateway-router -S today --no-pager | tail -n 200`
- `journalctl -u polystore-faucet -S today --no-pager | tail -n 200`

## Providers (remote SPs) — daily checks

- Run the healthcheck script (recommended):
  - `scripts/devnet_healthcheck.sh provider --provider http://127.0.0.1:<PORT> --hub-lcd https://lcd.<domain> --provider-addr nil1...`
  - Public endpoint example: `scripts/devnet_healthcheck.sh provider --provider https://sp1.<domain> --hub-lcd https://lcd.<domain> --provider-addr nil1...`
- Provider gateway is healthy:
  - `curl -sf http://127.0.0.1:<PORT>/health >/dev/null`
- Provider is visible on-chain (from hub):
  - `curl -sf http://127.0.0.1:1317/nilchain/nilchain/v1/providers/<nil1...> | jq '.provider.endpoints'`
- Router can reach provider endpoint (from hub):
  - `curl -sf <provider-public-url>/health >/dev/null`
- Active providers are using public endpoints (no accidental localhost endpoint leakage):
  - `curl -sf https://lcd.<domain>/nilchain/nilchain/v1/providers | jq -r '.providers[] | select((.draining // false) == false) | [.address, (.endpoints[0] // \"\"), (.draining // false)] | @tsv'`
  - Ensure active entries resolve to `/dns4/<public-host>/tcp/443/https`.
- System liveness is progressing (and not thrashing on stale local shards):
  - `curl -sf http://127.0.0.1:<PORT>/status | jq '.extra | with_entries(select(.key|startswith("system_liveness_")))'`
  - Watch `system_liveness_proofs_backoff_skipped` and `system_liveness_missing_data_skips`; if they climb continuously for old deals, dry-run cleanup:
    - `scripts/devnet_provider_cleanup.sh --provider-root /var/lib/nilstore/providers --lcd http://127.0.0.1:1317`
    - then `--apply` and restart the provider service.
- Mode2 reconstruction fallback is healthy:
  - `curl -sf http://127.0.0.1:<PORT>/status | jq '.extra | with_entries(select(.key|startswith("mode2_reconstruct_")))'`
  - `mode2_reconstruct_fallback_provider_successes` should increase during provider mismatch/outage recovery.
  - `mode2_reconstruct_not_enough_shards_failures` should stay near zero during normal operation.

## When something breaks (quick triage)

- **Chain stuck**: check disk full first, then `nilchaind` logs for consensus errors; restart only after disk/IO is healthy.
- **Provider missing**: re-check funding for provider key (gas), endpoint multiaddr reachability, and `NIL_GATEWAY_SP_AUTH` match.
- **Fetch failing**: confirm sessions are opening on-chain and clients are sending `X-Nil-Session-Id` (sessions are required by default).
- **Mode2 fetch intermittently failing**: inspect `mode2_reconstruct_*` counters and verify at least `K` shards remain available across assigned + fallback providers.

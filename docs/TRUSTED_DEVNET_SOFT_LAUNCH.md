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

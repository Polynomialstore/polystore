# Local “Happy Path” Runbook

This is the fastest way to prove the stack works **locally** (what CI uses) and
to understand the intended devnet posture.

If you want a deeper manual checklist, use `docs/manual-devnet-runbook.md`.

## Option A — Scripted lifecycle (CI smoke)

Runs: stack start → create deal → upload → commit → open retrieval session → fetch → stop.

```bash
scripts/e2e_lifecycle.sh
```

Notes:
- This script **enables gateway tx relay + faucet** for convenience:
  - `NIL_ENABLE_TX_RELAY=1`
  - `NIL_START_FAUCET=1`

## Option B — Scripted lifecycle (no local gateway)

Same as Option A, but forces a “gateway absent” profile (direct SP fallback paths).

```bash
scripts/e2e_lifecycle_no_gateway.sh
```

## Option C — Browser wallet-first E2E (Playwright)

These are “wallet-first” flows (no gateway tx relay). They install an in-page
E2E wallet when `VITE_E2E=1`.

Notes:
- These scripts run with gateway tx relay explicitly disabled (`NIL_ENABLE_TX_RELAY=0`).

```bash
# Upload falls back to direct SP (gateway absent)
scripts/e2e_browser_smoke_no_gateway.sh

# Retrieval uses libp2p relay transport
scripts/e2e_browser_libp2p_relay.sh

# Mode2 StripeReplica: 12 providers + gateway router + browser sharding
scripts/e2e_mode2_stripe_multi_sp.sh
```

## Option D — Manual stack + manual steps

```bash
scripts/run_local_stack.sh start
```

Then follow: `docs/manual-devnet-runbook.md`.

Stop the stack:

```bash
scripts/run_local_stack.sh stop
```

## Resetting local state (safe re-init)

`scripts/run_local_stack.sh start` **always re-initializes** the chain home.

- Default behavior (safe): if you do **not** set `NIL_HOME`, the script uses `_artifacts/polystorechain_data` and will wipe/re-init that directory on each `start`.
- Persistent home safety: if you set `NIL_HOME` to a path **outside** `_artifacts/`, the script will **refuse** to wipe it unless you explicitly opt in with `NIL_REINIT_HOME=1`.
  - Example: `NIL_HOME=/var/lib/polystore/local NIL_REINIT_HOME=1 scripts/run_local_stack.sh start`

## Common “why did fetch fail?”

- `missing X-PolyStore-Session-Id`: sessions are **required by default** on byte-serving
  endpoints (`NIL_REQUIRE_ONCHAIN_SESSION=1`).
- If you want legacy behavior (dev-only), you must explicitly opt-in:
  - `NIL_UNSAFE_ALLOW_LEGACY_DOWNLOAD_SESSION=1` (do not use for testnet posture)

# PolyStore E2E testing profiles

This repo now supports two standard E2E profiles for browser + gateway flows.
Deterministic upload, commit, and sparse transport assertions should prefer the
Node integration lane (`cd polystore-website && npm run test:integration`).
Playwright is retained for browser-only smoke paths.
The browser-only sparse upload proof is also a push-gated fast check because it
verifies the exact browser transport contract for sparse and parallel uploads
without requiring the local stack.

## Fast profile (PR/default)

- Targets short feedback cycles and deterministic behavior.
- Uses 3 local Storage Providers.
- Retained browser-only checks:
  - wallet connect / faucet / basic dashboard readiness
  - Mode 2 worker bootstrap and file input wiring
  - one gateway-backed Mode 2 upload/commit/download smoke
  - one gateway-absent direct-SP download smoke
  - one browser-only sparse upload proof asserting:
    - truncated request bodies with `X-PolyStore-Full-Size`
    - bounded in-flight upload overlap (`peakActiveUploads > 1`)

```bash
set -a
source .env.e2e.fast
set +a
scripts/e2e_stack_up.sh
cd polystore-website && npm run test:e2e -- tests/mode2-stripe.spec.ts --grep "mode2 deal"
scripts/e2e_stack_down.sh
```

## Heavy profile (nightly/manual)

- Uses 12 local Storage Providers.
- Runs full mode2 stripe suite.

```bash
set -a
source .env.e2e.heavy
set +a
scripts/e2e_mode2_stripe_multi_sp.sh
```

## Utility commands

```bash
scripts/e2e_stack_status.sh
scripts/e2e_stack_down.sh
```

## CI behavior

- Push CI uses the fast Mode2 E2E profile.
- Push CI also keeps the gateway-absent Playwright smoke for browser-only no-gateway behavior.
- Push CI also runs `scripts/e2e_sparse_browser_upload.sh` as the fast browser-only
  proof for sparse + parallel uploads.
- LibP2P relay Playwright is removed from push gating and available only in `PolyStore E2E Heavy` via manual dispatch.

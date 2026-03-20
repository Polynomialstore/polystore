# NilStore E2E testing profiles

This repo now supports two standard E2E profiles for browser + gateway flows.

## Fast profile (PR/default)

- Targets short feedback cycles and deterministic behavior.
- Uses 3 local Storage Providers.

```bash
set -a
source .env.e2e.fast
set +a
scripts/e2e_stack_up.sh
cd nil-website && npm run test:e2e -- tests/mode2-stripe.spec.ts --grep "^mode2 deal"
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
- LibP2P relay Playwright is removed from push gating and available only in `NilStore E2E Heavy` via manual dispatch.

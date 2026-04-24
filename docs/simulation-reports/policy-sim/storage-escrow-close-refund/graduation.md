# Graduation Assessment: Storage Escrow Close And Refund

Model the storage lock-in lifecycle for committed content. The policy question is whether storage fees are locked, earned over time by eligible providers, and refunded on early close without leaving hidden outstanding escrow.

## Recommendation

**Candidate for implementation planning.** The fixture passed its assertion contract and exercised the expected enforcement path.

## Readiness Checklist

| Check | Result | Why It Matters |
|---|---|---|
| Assertion contract passes | `true` | The scenario must have explicit machine-readable policy expectations. |
| No modeled data loss | `true` | Temporary unavailable reads can be scenario-specific, but durability loss should block graduation. |
| Availability within scenario contract | `true` | Enforcement must not harm users beyond the availability bounds chosen for this case. |
| Corrupt bytes not paid | `true` | Bad data must never be economically rewarded. |
| Repair path exercised when expected | `true` | Fault scenarios should prove detection, pending-provider readiness, and promotion. |
| Hard enforcement represented when expected | `true` | Corruption fixtures should prove the simulated slash/jail accounting path before keeper work. |

## Scenario-Specific Graduation Semantics

Graduation means storage lock-in, earned-fee payout, early close refund, and run-end outstanding escrow are deterministic before keeper close/refund semantics are implemented.

## Candidate Next Artifact

Create a keeper/gateway planning ticket that names storage quote parity, upfront lock-in, per-epoch earned-fee payout, early close refund, expiry auto-close, and refund rounding semantics.

## Missing Human Decisions

- Confirm whether the assertion bounds are the intended policy thresholds.
- Confirm whether this scenario should graduate to keeper tests, gateway e2e tests, provider-daemon tests, or remain simulator-only.
- Confirm which metrics become governance parameters versus internal monitoring thresholds.
- Confirm whether any economic assumption is realistic enough to affect product or token policy.

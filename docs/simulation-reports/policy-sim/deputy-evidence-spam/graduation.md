# Graduation Assessment: Deputy Evidence Spam

Model a deputy submitting low-quality failure claims. The policy question is whether evidence bonds and conviction-gated bounties make spam uneconomic before evidence-market keeper code exists.

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

Graduation means low-quality deputy evidence is economically negative-EV and cannot trigger live provider punishment without conviction.

## Candidate Next Artifact

Create a keeper/runtime planning ticket that names evidence bond escrow, burn-on-expiry, conviction-gated bounty payout, spam throttles, and deputy reputation inputs.

## Missing Human Decisions

- Confirm whether the assertion bounds are the intended policy thresholds.
- Confirm whether this scenario should graduate to keeper tests, gateway e2e tests, provider-daemon tests, or remain simulator-only.
- Confirm which metrics become governance parameters versus internal monitoring thresholds.
- Confirm whether any economic assumption is realistic enough to affect product or token policy.

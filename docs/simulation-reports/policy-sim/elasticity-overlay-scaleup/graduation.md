# Graduation Assessment: Elasticity Overlay Scale-Up

Model the positive path for user-funded overflow capacity. Sustained hot retrieval pressure buys temporary overlay routes, the routes become ready after a delay, serve reads, and expire instead of becoming permanent unpaid responsibility.

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

Graduation means user-funded overflow routes can be activated, become ready, serve reads, and expire without turning into permanent base responsibility or bypassing spend caps.

## Candidate Next Artifact

Create a keeper/gateway/provider-daemon planning ticket that names MsgSignalSaturation inputs, overlay readiness proof, spend-window accounting, TTL expiration, route preference, and overlay reward/audit rules.

## Missing Human Decisions

- Confirm whether the assertion bounds are the intended policy thresholds.
- Confirm whether this scenario should graduate to keeper tests, gateway e2e tests, provider-daemon tests, or remain simulator-only.
- Confirm which metrics become governance parameters versus internal monitoring thresholds.
- Confirm whether any economic assumption is realistic enough to affect product or token policy.

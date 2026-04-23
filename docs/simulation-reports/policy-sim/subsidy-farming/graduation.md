# Graduation Assessment: Subsidy Farming

Model providers attempting to collect base rewards while skipping useful liveness work. The policy concern is reward leakage, not retrieval correctness alone.

## Recommendation

**Candidate for further simulation review.** The fixture passed, but it primarily informs economic/product policy rather than immediate keeper enforcement.

## Readiness Checklist

| Check | Result | Why It Matters |
|---|---|---|
| Assertion contract passes | `true` | The scenario must have explicit machine-readable policy expectations. |
| No modeled data loss | `true` | Temporary unavailable reads can be scenario-specific, but durability loss should block graduation. |
| Availability within scenario contract | `true` | Enforcement must not harm users beyond the availability bounds chosen for this case. |
| Corrupt bytes not paid | `true` | Bad data must never be economically rewarded. |
| Repair path exercised when expected | `true` | Fault scenarios should prove recovery, not only detection. |
| Hard enforcement represented when expected | `true` | Corruption fixtures should prove the simulated slash/jail accounting path before keeper work. |

## Scenario-Specific Graduation Semantics

Graduation means non-compliant responsibility is not profitably subsidized by base rewards.

## Candidate Next Artifact

Create a policy-review note that compares this scenario against at least one baseline and one adversarial variant.

## Missing Human Decisions

- Confirm whether the assertion bounds are the intended policy thresholds.
- Confirm whether this scenario should graduate to keeper tests, gateway e2e tests, provider-daemon tests, or remain simulator-only.
- Confirm which metrics become governance parameters versus internal monitoring thresholds.
- Confirm whether any economic assumption is realistic enough to affect product or token policy.

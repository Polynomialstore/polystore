# Graduation Assessment: Single Provider Outage

Model an honest provider that becomes unavailable for several epochs. The policy question is whether the network can preserve user-facing availability while detecting the failing slot and performing make-before-break repair.

## Recommendation

**Candidate for implementation planning.** The fixture passed its assertion contract and exercised the expected enforcement path.

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

Graduation means an honest outage triggers repair after threshold while preserving the durability invariant.

## Candidate Next Artifact

Create a keeper/e2e planning ticket that names the exact evidence rows, reward-accounting rule, and repair transition this fixture should enforce.

## Missing Human Decisions

- Confirm whether the assertion bounds are the intended policy thresholds.
- Confirm whether this scenario should graduate to keeper tests, gateway e2e tests, provider-daemon tests, or remain simulator-only.
- Confirm which metrics become governance parameters versus internal monitoring thresholds.
- Confirm whether any economic assumption is realistic enough to affect product or token policy.

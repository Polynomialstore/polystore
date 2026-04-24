# Graduation Assessment: Performance Market Latency Tiers

Model Hot-service retrieval demand across providers with heterogeneous latency. The policy question is whether the simulator can separate correctness from QoS by recording Platinum/Gold/Silver/Fail service tiers and paying tiered performance rewards without treating slow-but-correct service as corrupt data.

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

Graduation means latency-tier windows, service-class attribution, and tiered performance rewards are deterministic and inspectable before keeper params are implemented.

## Candidate Next Artifact

Create a keeper/runtime planning ticket that names service-class params, latency-tier windows, reward multipliers, telemetry inputs, and which QoS tiers affect placement without becoming slashable evidence.

## Missing Human Decisions

- Confirm whether the assertion bounds are the intended policy thresholds.
- Confirm whether this scenario should graduate to keeper tests, gateway e2e tests, provider-daemon tests, or remain simulator-only.
- Confirm which metrics become governance parameters versus internal monitoring thresholds.
- Confirm whether any economic assumption is realistic enough to affect product or token policy.

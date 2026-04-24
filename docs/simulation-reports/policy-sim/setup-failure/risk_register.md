# Risk Register: Setup Phase Failure

Model a provider failing during early placement/upload setup. The policy concern is avoiding a bad initial assignment that leaves the deal under-replicated before steady-state liveness has much evidence.

## Material Risks

| Risk | Severity | Evidence | Impact | Recommended Follow-Up |
|---|---|---|---|---|
| Provider economic churn pressure | `medium` | 1 of 48 providers ended with negative modeled P&L. | A technically healthy network may still be unstable if rational providers exit. | Review storage price, retrieval price, reward pool, provider cost assumptions, and dynamic-pricing thresholds. |

## Evidence Counters

- Evidence events: `12`
- Repair events: `18`
- Failed assertions: `0`
- Providers with negative P&L: `1`
- Elasticity rejections: `0`
- Data-loss events: `0`
- Saturated responses: `0`
- Repair attempts: `6`
- Repair backoffs: `0`
- Repair cooldowns: `0`
- Repair attempt-cap events: `0`

## Review Questions

- Are the modeled thresholds strict enough to catch griefing without punishing honest jitter?
- Does the risk severity match how we would respond in a real devnet incident?
- Should any risk item become a keeper test, gateway e2e test, or explicit governance parameter decision?

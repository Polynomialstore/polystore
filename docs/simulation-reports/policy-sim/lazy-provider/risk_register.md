# Risk Register: Lazy Provider

Model a provider that does not satisfy liveness quota even when user-facing reads may still succeed. This tests whether the network detects free-riding on redundancy instead of only detecting outright retrieval failures.

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
- Performance Fail-tier serves: `0`
- Performance reward paid: `0.0000`
- Suspect slot-epochs: `6`
- Delinquent slot-epochs: `12`
- Repair attempts: `6`
- Repair backoffs: `0`
- Repair cooldowns: `0`
- Repair attempt-cap events: `0`

## Review Questions

- Are the modeled thresholds strict enough to catch griefing without punishing honest jitter?
- Does the risk severity match how we would respond in a real devnet incident?
- Should any risk item become a keeper test, gateway e2e test, or explicit governance parameter decision?

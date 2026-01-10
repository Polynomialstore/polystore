# Prompt: Mainnet Parity + Devnet/Testnet Launch Resolution

You are tasked with producing a concrete, implementable Mainnet parity plan: **finalize remaining policy** and **turn it into staged engineering work**.

Use the brief in `assets_for_prompt.md` as the source of truth. The repo includes a current proposal in `notes/mainnet_policy_resolution_jan2026.md`; treat it as the **baseline** and either **confirm** it or propose specific revisions with rationale.

## A) Well-defined high-level steps (must produce an implementation plan)
- Storage lock-in + escrow accounting (pay-at-ingest, deterministic debits, spend windows)
- Retrieval session economics (base fee burn, variable fee lock, settlement, refunds)
- Deterministic challenge derivation + quotas (synthetic fill, penalties)
- Evidence / fraud proofs pipeline (verify, replay-protect, slash/evict/jail)
- Mode 2 repair + make-before-break replacement (slot status, catch-up, promotion)
- HealthState + eviction curve (per-(deal, provider/slot) health tracking)

## B) Underspecified items (you must propose and clarify)
- Exact slashing policy + parameters (thresholds, amounts, jailing)
- Staking/bond requirements (minimums, lock periods, slashing linkage)
- Pricing parameterization + equilibrium targets (storage price, retrieval fees, burn bps, halving)
- Repair/replacement selection policy (candidate choice, churn/griefing controls)
- Deputy market compensation (proxy retrieval payment, evidence incentives, audit debt funding)
- Challenge economics (organic retrieval credits: accrual rules, caps, phase-in)

## Required outputs
1. A **policy resolution** for every item in B:
   - either “accept baseline” from `notes/mainnet_policy_resolution_jan2026.md`, or
   - “change baseline” with explicit new values and a brief rationale.
2. A **parameter sheet** mapping each decision to a concrete on-chain param name, with separate defaults for `devnet`, `testnet`, and `mainnet` where applicable.
3. A **delivery plan** that turns A into a staged roadmap (Stage 0–7), including dependencies, repo areas, and test gates (unit/e2e/sim).
4. A short **risk list** (top 5) if any B item is deferred or implemented later.
5. A short **contentious/underspecified list** (if any): items that still need human decision, with 2–3 crisp options each.

Keep it crisp and actionable for engineering.

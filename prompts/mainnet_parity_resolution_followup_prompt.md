# Follow-up Prompt: Contentious Mainnet Econ/Security Decisions

Context: `notes/mainnet_policy_resolution_jan2026.md` records baseline defaults for the remaining underspecified items (slashing/jailing, bonding, pricing, replacement, deputy incentives, credits phase-in). Some decisions remain contentious or require product/governance sign-off (e.g., audit budget sizing, evidence-bond burn fraction, and any “trusted override” for repeated repair failures).

Use `assets_for_prompt.md` and `notes/mainnet_policy_resolution_jan2026.md`.

## Task

For each topic below, choose an option (or propose a better option) and justify it based on:
- expected operator behavior on testnet/mainnet,
- user UX/cost targets,
- griefing/Sybil risk,
- parameter sensitivity (what breaks if we’re off by 2×).

## Topics to decide

### 1) Slashing + jailing (B1)
- Should quota shortfall ever slash, or remain HealthState-only?
- Are the proposed bps defaults (0.5% invalid proof, 5% wrong data, 1% non-response) too weak/strong?
- Should jailing durations be epoch-based or block-based?
- Should eviction thresholds differ for hot vs cold deals (recommended split)?

### 2) Provider bonding (B2)
- Flat bond only vs base bond + assignment collateral (recommended)?
- If assignment collateral: what should `bond_months` be (1, 2, 3+) and why?
- What should `min_provider_bond` be for testnet to avoid excluding small operators?

### 3) Pricing targets (B3)
- Target `NIL / GiB-month` and `NIL / GiB retrieval` for testnet and mainnet.
- `base_retrieval_fee`: what level prevents spam but keeps UX acceptable?
- `retrieval_burn_bps`: what burn fraction (0–20%) matches desired sink vs payout?
- Halving schedule: “1 year in blocks” vs faster/slower; what governance knobs are allowed?

### 4) Replacement policy + churn controls (B4)
- Replacement cooldown length and whether it’s per-slot or per-deal.
- Candidate eligibility: do we require capacity proofs, or is bond + not-jailed enough initially?
- How to cap repair attempts and what the fallback escalation should be after repeated failures.

### 5) Deputy market + audit debt (B5)
- Audit debt funding is set to Option A; decide **audit budget sizing** and caps (how much to mint per epoch and limits).
- Proxy premium default: 10% vs 20% vs dynamic.
- Evidence incentives: evidence bond/bounty sizes and the burn fraction on non-conviction (baseline is 50% burn on TTL expiry).

### 6) Credits phase-in (B6)
- Enable credits on devnet vs testnet only vs mainnet only.
- Credit caps (hot/cold) and whether credits can reduce quota beyond 50% in any mode.

## Output format
- A table of final decisions (devnet/testnet/mainnet defaults where relevant).
- 3–5 bullet “why” notes per topic.
- A list of “monitoring signals” to calibrate each parameter on testnet (metrics and thresholds).

# RFC: Heat & Dynamic Placement for Mode 1

**Status:** Draft / Non‑normative
**Target:** NilStore Mode 1 (FullReplica)
**Scope:** Research / experimental design, _not_ part of the core retrievability spec yet

---

## 1. Summary

This RFC proposes a small, additive “heat layer” on top of the existing Mode 1 retrievability and self‑healing design.

The aim is to:

- Measure **per‑deal demand** (`heat H(D)`) from already‑available on‑chain signals (bytes served, failures),
- Expose that as a simple, cheap per‑deal state (`DealHeatState`),
- Eventually (optionally) allow small, bounded **tilts in storage rewards per deal** to make hot deals slightly more lucrative for Storage Providers (SPs),
- Bias SP audit‑debt sampling toward hot deals.

The core Mode 1 invariants and mechanics are **not changed**:

- Synthetic KZG challenges and retrieval receipts remain the source of storage proofs.
- Fraud proofs and explicit challenges remain the only basis for slashing.
- HealthState and eviction remain the primary self‑healing mechanism.
- Bandwidth pricing and escrow accounting remain as currently specified.

This document is explicitly **non‑normative**. It is a research and implementation guide for experiments on devnet/testnet. No behavior described here should be treated as part of the mainline spec until we explicitly promote a subset.

---

## 2. Background & Constraints

The existing Mode 1 spec (and `retrievability-memo.md`) already defines:

- **Retrievability / accountability:** For each `(Deal, Provider)`, either the data is retrievable under protocol rules, or there is verifiable evidence of failure leading to punishment.
- **Self‑healing placement:** Persistently bad SPs are evicted and replaced.
- **Mechanics:**
  - Deals with on‑chain commitments (root CID, MDU/KZG roots),
  - Retrieval protocol with deterministic KZG checkpoints via `DeriveCheckPoint`,
  - Synthetic storage challenges `S_e(D,P)`,
  - `RetrievalReceipt`–based proofs,
  - Fraud proofs and panic‑mode challenges,
  - SP audit debt, HealthState per `(Deal, Provider)`.

This RFC must satisfy:

- **No change** to the correctness layer:
  - What counts as a valid retrieval challenge,
  - What counts as valid evidence,
  - How slashing and eviction work.
- **No change** to bandwidth semantics for the first iteration:
  - `PricePerByte(D)` and escrow debits remain fixed as in Mode 1.
- **Minimal on‑chain complexity:**
  - No per‑MDU state in consensus,
  - Per‑deal metrics only,
  - Simple arithmetic and bounded state updates.

---

## 3. Design Overview

### 3.1 Data Unit and Heat

- For this RFC, a **Data Unit (DU)** is a single **Deal**:

  ```text
  DU(D) := DealId D
  ```

- For each deal `D` we maintain a small `DealHeatState` with:
  - A smoothed notion of **utilization**: “file‑equivalents served per epoch,”
  - Optional **failure rate** (synthetic challenge failures),
  - A scalar **heat score** `H(D)`,
  - Optional **storage multiplier** `m_storage(D)` (bounded tilt around 1.0),
  - Advisory **target replication** `r_target(D)`.

Heat is **derived** from already‑existing events:

- Bytes served per deal (observed at bandwidth settlement),
- Synthetic challenge failures and fraud proofs (already recorded for slashing).

### 3.2 Strict non‑goals for this RFC

The following are explicitly out of scope for the initial heat design:

- Per‑MDU heat, stripe‑level overlays, or CDN‑style per‑segment placement.
- Any change to:
  - Retrieval semantics,
  - Evidence formats,
  - Synthetic challenge schedules,
  - Bandwidth pricing (no `m_bw(D) ≠ 1`).
- Diversity constraints / anti‑concentration enforced in consensus.
- Using heat as a **direct** slashing or eviction signal.

All of those remain separate research tracks and must be evaluated independently.

---

## 4. DealHeatState and Metrics (Measurement Layer)

### 4.1 On‑chain state (measurement only)

For each deal `D`, we introduce a non‑normative state struct:

```text
struct DealHeatState {
    // Smoothed metrics
    ewma_util;      // fixed-point EWMA of utilization U(D)
    ewma_fail;      // fixed-point EWMA of failure rate F(D) (optional)

    // Derived heat score
    H;              // fixed-point heat in [0, H_max]

    // Optional economic hints (may remain =1 in early phases)
    m_storage;      // storage reward tilt multiplier, ≈1.0
    m_bw;           // bandwidth multiplier, kept at 1.0 in v1

    // Redundancy advisory (not enforced in consensus)
    r_min;          // copy of deal's minimum redundancy
    r_max;          // protocol-bound maximum redundancy
    r_target;       // advisory target redundancy from H(D)

    // Per-epoch accumulators
    bytes_served_epoch;
    failed_challenges_epoch;
    epoch_last_updated;
}
```

Notes:

- `DealHeatState` is **additive**: no existing state or logic needs to change to add it.
- For a v1 experiment we can:
  - Set `ewma_fail = 0`, `m_bw = 1`,
  - Use `m_storage = 1` initially (no economic effect).

### 4.2 Metric collection

Per epoch `e`, for each `deal_id = D`:

- **Bytes served**
  - When any Provider settles a payment channel for D (`claimPayment` succeeds):
    - Compute `delta_bytes` from cumulative counters,
    - Increment `DealHeat[D].bytes_served_epoch += delta_bytes`.
- **Failures** (optional in v1)
  - When a synthetic storage challenge for `(D,P)` is not satisfied in time,
    or when a fraud proof for `(D,P)` is accepted:
    - Increment `DealHeat[D].failed_challenges_epoch += 1`.

No new evidence is introduced; we just count events that already exist.

### 4.3 Heat computation (simple, linear v1)

At the end of epoch `e`, for each deal with non‑zero activity
(`bytes_served_epoch > 0` or `failed_challenges_epoch > 0`):

1. Utilization:

   ```text
   u_e(D)   = bytes_served_epoch / file_size(D)
   U_e(D)   = (1 - α_U) * U_{e-1}(D) + α_U * u_e(D)
   ewma_util = U_e(D)
   ```

2. Failures (optional; can set α_F = 0 in early tests):

   ```text
   f_e(D)   = min(1.0, failed_challenges_epoch / k_storage_base)
   F_e(D)   = (1 - α_F) * F_{e-1}(D) + α_F * f_e(D)
   ewma_fail = F_e(D)
   ```

3. Heat (v1: saturating linear, no log to keep math cheap):

   ```text
   H_raw(D)   = U_e(D) * (1 + β_F * F_e(D))
   H_capped   = min(H_raw(D), H_max)
   H_new      = clamp(H_capped,
                      H_prev * (1 - δ_H),
                      H_prev * (1 + δ_H))
   H          = H_new
   ```

4. Reset per‑epoch counters and set `epoch_last_updated = e`.

Recommended starting parameters (for experiments, not yet normative):

- `α_U ≈ 0.1` (heat reacts over ~10 epochs),
- `α_F = 0` (ignore failures in H(D) initially),
- `β_F = 0` (no failure amplification until we’re comfortable),
- `H_max` small (e.g. 10),
- `δ_H ≈ 0.2` to limit per‑epoch swings.

---

## 5. Optional Economic Hooks (Tilted Storage Rewards)

This section describes a **candidate** way to use `H(D)` to slightly tilt storage rewards. It is deliberately conservative and should be considered **Phase C** in a longer rollout.

### 5.1 Storage multiplier m_storage(D)

Define a squashing function:

```text
g(D) = H(D) / (H(D) + H0)      // H0 > 0
```

Then the raw storage multiplier:

```text
m_raw(D) = 1 + s_max * g(D)
```

To avoid jitter:

```text
m_new(D) = clamp(m_raw(D),
                 m_prev(D) * (1 - δ_m),
                 m_prev(D) * (1 + δ_m))

m_new(D) = clamp(m_new(D), m_min_global, m_max_global)
```

And we store:

```text
DealHeat[D].m_storage = m_new(D)
```

Suggested bounds for experiments:

- `s_max` ≈ 0.25–0.5 (max +25–50% uplift),
- `δ_m` ≈ 0.1 (max ±10% change per epoch),
- `m_min_global` ≈ 0.75, `m_max_global` ≈ 1.25.

### 5.2 Plugging into existing storage rewards

Let:

- `R_base(D,P,e,T)` = storage reward for `(D,P)` in epoch `e` with tier `T` **under current Mode 1 logic**, before any heat tilt.

Candidate new reward:

```text
R_new(P,e) = Σ_D ( R_base(D,P,e,T(D,P,e)) * m_storage(D,e) )
```

Notes:

- We do **not** change:
  - global inflation schedule,
  - latency tier multipliers,
  - proof mechanics.
- We accept that total minted storage reward may deviate slightly from the current target, bounded by `m_min_global`/`m_max_global`.
- A future refinement could add a global re‑normalization factor to keep total inflation exactly constant, but that is **out of scope** for this RFC.

### 5.3 Bandwidth pricing (deliberately unchanged)

For this RFC:

- Bandwidth price per byte remains `PricePerByte(D)` from the deal.
- Escrow debits when settling retrieval receipts remain:

  ```text
  escrow_debit = delta_bytes * PricePerByte(D)
  ```

- `m_bw(D)` is kept equal to 1 and is not applied to real payments in v1.

Dynamic bandwidth pricing is a separate research track.

---

## 6. Advisory Target Replication & Audit Bias (Optional)

### 6.1 Advisory target replication r_target(D)

We can derive an **advisory** target replication:

```text
g_r(D)       = H(D) / (H(D) + H0_r)
r_target(D)  = r_min(D) + floor((r_max(D) - r_min(D)) * g_r(D))
```

Where:

- `r_min(D)` is the deal’s minimum redundancy (already in spec),
- `r_max(D)` is a protocol‑bounded maximum (e.g. `r_min + ΔR_LOCAL_MAX`).

In this RFC:

- `r_target(D)` is **informational**:
  - Dashboards,
  - Off‑chain placement heuristics,
  - SP operator tooling.
- Consensus logic **does not**:
  - block exits based on r_target (only on r_min),
  - auto‑adjust rewards beyond `m_storage(D)`.

### 6.2 Audit sampling bias

SP audit debt today:

- For each SP P:
  - `audit_debt(P) = α_base * stored_bytes(P)` per epoch (fixed).

We can change **only** how we select deals/assignments to satisfy that debt:

- Sample deals D for audits with probability proportional to:

  ```text
  weight(D) ∝ max(ε_H, H(D)) * file_size(D)
  ```

Where:

- `ε_H` is a small baseline so cold deals still get some attention.

This bias:

- Does not change total audit volume,
- Keeps audit mechanics unchanged,
- Focuses more cross‑SP audits on hot deals where impact of cheating is highest.

---

## 7. Phased Adoption Plan (Non‑binding)

This RFC recommends a three‑phase path, all explicitly opt‑in and reversible.

### Phase A – Measurement only (devnet/testnet)

Implement:

- `DealHeatState` with:
  - `ewma_util`, `ewma_fail`, `H`,
  - per‑epoch accumulators.
- Metric collection and H(D) update at epoch boundaries.
- Queries that expose:
  - `H(D)`, `U(D)`, maybe `r_target(D)` (computed but advisory).

No economic behavior changes:

- `m_storage = 1`, `m_bw = 1`,
- existing reward and bandwidth logic untouched.

### Phase B – Soft influence (testnet)

Add:

- Advisory `r_target(D)` computation (if not already computed).
- Audit sampling bias:
  - SP audit‑debt scheduler chooses deals with probability proportional to `max(ε_H, H(D)) * file_size(D)`.
- Off‑chain use:
  - Dashboards visualize heat,
  - SPs optionally incorporate H(D) into local decision heuristics.

Still no direct economic changes:

- `m_storage = 1`, `m_bw = 1`.

### Phase C – Economic tilting (candidate mainnet feature)

Only after Phase A/B have run long enough to validate:

- Stability of H(D),
- No obvious gaming or pathologies,

we consider turning on:

- `m_storage(D)` as defined in § 5.1, with conservative bounds.
- Storage rewards multiplied per deal:

  ```text
  R_new(P,e) = Σ_D R_base(D,P,e,T) * m_storage(D,e)
  ```

Bandwidth and retrievability logic remain unchanged.

If any issues arise:

- We can set `s_max = 0` or `m_storage = 1` network‑wide, effectively disabling the tilt while keeping metric collection for analysis.

---

## 8. Risks & Open Questions

This RFC is **not** a final decision to ship dynamic heat; it’s a framework for experiments. Key questions to answer before promoting any part of it to the main spec:

1. **Economic calibration**
   - Do small tilts (±20–25%) meaningfully improve SP incentives or deal distribution?
   - How sensitive are results to `α_U`, `H0`, `s_max`, and bounds on `m_storage`?
2. **Gaming**
   - In practice, can SPs or clients cheaply farm H(D) enough to materially distort rewards?
   - Does the protocol tax on bandwidth + bounds on `m_storage` make self‑dealing clearly negative‑EV?
3. **State and performance**
   - For realistic numbers of deals (10k–100k+), what is the impact on:
     - state size,
     - per‑epoch update time,
     - block gas?
4. **UX and predictability**
   - Are small, slow storage tilts acceptable for users who think in terms of “static” storage pricing?
   - Does this complicate mental models or pricing too much for early mainnet?
5. **Value vs complexity**
   - Does a measurement‑only heat layer (Phase A/B) already provide enough insight and audit targeting benefits?
   - Is turning on `m_storage` worth the added complexity, or should it remain a lab feature until after mainnet?

Until these are answered via simulation and real testnet data, this RFC should be treated as an **experimental design**, not a commit to change the live protocol.


• Added rfcs/rfc-heat-and-dynamic-placement.md (+409 -0)
      1 +# RFC: Heat & Dynamic Placement for Mode 1
      2 +
      3 +**Status:** Draft / Non‑normative
      4 +**Target:** NilStore Mode 1 (FullReplica)
      5 +**Scope:** Research / experimental design, _not_ part of the core retrievability spec yet
      6 +
      7 +---
      8 +
      9 +## 1. Summary
     10 +
     11 +This RFC proposes a small, additive “heat layer” on top of the existing Mode 1 retrievability and sel
         f‑healing design.
     12 +
     13 +The aim is to:
     14 +
     15 +- Measure **per‑deal demand** (`heat H(D)`) from already‑available on‑chain signals (bytes served, fa
         ilures),
     16 +- Expose that as a simple, cheap per‑deal state (`DealHeatState`),
     17 +- Eventually (optionally) allow small, bounded **tilts in storage rewards per deal** to make hot deal
         s slightly more lucrative for Storage Providers (SPs),
     18 +- Bias SP audit‑debt sampling toward hot deals.
     19 +
     20 +The core Mode 1 invariants and mechanics are **not changed**:
     21 +
     22 +- Synthetic KZG challenges and retrieval receipts remain the source of storage proofs.
     23 +- Fraud proofs and explicit challenges remain the only basis for slashing.
     24 +- HealthState and eviction remain the primary self‑healing mechanism.
     25 +- Bandwidth pricing and escrow accounting remain as currently specified.
     26 +
     27 +This document is explicitly **non‑normative**. It is a research and implementation guide for experime
         nts on devnet/testnet. No behavior described here should be treated as part of the mainline spec unti
         l we explicitly promote a subset.
     28 +
     29 +---
     30 +
     31 +## 2. Background & Constraints
     32 +
     33 +The existing Mode 1 spec (and `retrievability-memo.md`) already defines:
     34 +
     35 +- **Retrievability / accountability:** For each `(Deal, Provider)`, either the data is retrievable un
         der protocol rules, or there is verifiable evidence of failure leading to punishment.
     36 +- **Self‑healing placement:** Persistently bad SPs are evicted and replaced.
     37 +- **Mechanics:**
     38 +  - Deals with on‑chain commitments (root CID, MDU/KZG roots),
     39 +  - Retrieval protocol with deterministic KZG checkpoints via `DeriveCheckPoint`,
     40 +  - Synthetic storage challenges `S_e(D,P)`,
     41 +  - `RetrievalReceipt`–based proofs,
     42 +  - Fraud proofs and panic‑mode challenges,
     43 +  - SP audit debt, HealthState per `(Deal, Provider)`.
     44 +
     45 +This RFC must satisfy:
     46 +
     47 +- **No change** to the correctness layer:
     48 +  - What counts as a valid retrieval challenge,
     49 +  - What counts as valid evidence,
     50 +  - How slashing and eviction work.
     51 +- **No change** to bandwidth semantics for the first iteration:
     52 +  - `PricePerByte(D)` and escrow debits remain fixed as in Mode 1.
     53 +- **Minimal on‑chain complexity:**
     54 +  - No per‑MDU state in consensus,
     55 +  - Per‑deal metrics only,
     56 +  - Simple arithmetic and bounded state updates.
     57 +
     58 +---
     59 +
     60 +## 3. Design Overview
     61 +
     62 +### 3.1 Data Unit and Heat
     63 +
     64 +- For this RFC, a **Data Unit (DU)** is a single **Deal**:
     65 +
     66 +  ```text
     67 +  DU(D) := DealId D
     68 +  ```
     69 +
     70 +- For each deal `D` we maintain a small `DealHeatState` with:
     71 +  - A smoothed notion of **utilization**: “file‑equivalents served per epoch,”
     72 +  - Optional **failure rate** (synthetic challenge failures),
     73 +  - A scalar **heat score** `H(D)`,
     74 +  - Optional **storage multiplier** `m_storage(D)` (bounded tilt around 1.0),
     75 +  - Advisory **target replication** `r_target(D)`.
     76 +
     77 +Heat is **derived** from already‑existing events:
     78 +
     79 +- Bytes served per deal (observed at bandwidth settlement),
     80 +- Synthetic challenge failures and fraud proofs (already recorded for slashing).
     81 +
     82 +### 3.2 Strict non‑goals for this RFC
     83 +
     84 +The following are explicitly out of scope for the initial heat design:
     85 +
     86 +- Per‑MDU heat, stripe‑level overlays, or CDN‑style per‑segment placement.
     87 +- Any change to:
     88 +  - Retrieval semantics,
     89 +  - Evidence formats,
     90 +  - Synthetic challenge schedules,
     91 +  - Bandwidth pricing (no `m_bw(D) ≠ 1`).
     92 +- Diversity constraints / anti‑concentration enforced in consensus.
     93 +- Using heat as a **direct** slashing or eviction signal.
     94 +
     95 +All of those remain separate research tracks and must be evaluated independently.
     96 +
     97 +---
     98 +
     99 +## 4. DealHeatState and Metrics (Measurement Layer)
    100 +
    101 +### 4.1 On‑chain state (measurement only)
    102 +
    103 +For each deal `D`, we introduce a non‑normative state struct:
    104 +
    105 +```text
    106 +struct DealHeatState {
    107 +    // Smoothed metrics
    108 +    ewma_util;      // fixed-point EWMA of utilization U(D)
    109 +    ewma_fail;      // fixed-point EWMA of failure rate F(D) (optional)
    110 +
    111 +    // Derived heat score
    112 +    H;              // fixed-point heat in [0, H_max]
    113 +
    114 +    // Optional economic hints (may remain =1 in early phases)
    115 +    m_storage;      // storage reward tilt multiplier, ≈1.0
    116 +    m_bw;           // bandwidth multiplier, kept at 1.0 in v1
    117 +
    118 +    // Redundancy advisory (not enforced in consensus)
    119 +    r_min;          // copy of deal's minimum redundancy
    120 +    r_max;          // protocol-bound maximum redundancy
    121 +    r_target;       // advisory target redundancy from H(D)
    122 +
    123 +    // Per-epoch accumulators
    124 +    bytes_served_epoch;
    125 +    failed_challenges_epoch;
    126 +    epoch_last_updated;
    127 +}
    128 +```
    129 +
    130 +Notes:
    131 +
    132 +- `DealHeatState` is **additive**: no existing state or logic needs to change to add it.
    133 +- For a v1 experiment we can:
    134 +  - Set `ewma_fail = 0`, `m_bw = 1`,
    135 +  - Use `m_storage = 1` initially (no economic effect).
    136 +
    137 +### 4.2 Metric collection
    138 +
    139 +Per epoch `e`, for each `deal_id = D`:
    140 +
    141 +- **Bytes served**
    142 +  - When any Provider settles a payment channel for D (`claimPayment` succeeds):
    143 +    - Compute `delta_bytes` from cumulative counters,
    144 +    - Increment `DealHeat[D].bytes_served_epoch += delta_bytes`.
    145 +- **Failures** (optional in v1)
    146 +  - When a synthetic storage challenge for `(D,P)` is not satisfied in time,
    147 +    or when a fraud proof for `(D,P)` is accepted:
    148 +    - Increment `DealHeat[D].failed_challenges_epoch += 1`.
    149 +
    150 +No new evidence is introduced; we just count events that already exist.
    151 +
    152 +### 4.3 Heat computation (simple, linear v1)
    153 +
    154 +At the end of epoch `e`, for each deal with non‑zero activity
    155 +(`bytes_served_epoch > 0` or `failed_challenges_epoch > 0`):
    156 +
    157 +1. Utilization:
    158 +
    159 +   ```text
    160 +   u_e(D)   = bytes_served_epoch / file_size(D)
    161 +   U_e(D)   = (1 - α_U) * U_{e-1}(D) + α_U * u_e(D)
    162 +   ewma_util = U_e(D)
    163 +   ```
    164 +
    165 +2. Failures (optional; can set α_F = 0 in early tests):
    166 +
    167 +   ```text
    168 +   f_e(D)   = min(1.0, failed_challenges_epoch / k_storage_base)
    169 +   F_e(D)   = (1 - α_F) * F_{e-1}(D) + α_F * f_e(D)
    170 +   ewma_fail = F_e(D)
    171 +   ```
    172 +
    173 +3. Heat (v1: saturating linear, no log to keep math cheap):
    174 +
    175 +   ```text
    176 +   H_raw(D)   = U_e(D) * (1 + β_F * F_e(D))
    177 +   H_capped   = min(H_raw(D), H_max)
    178 +   H_new      = clamp(H_capped,
    179 +                      H_prev * (1 - δ_H),
    180 +                      H_prev * (1 + δ_H))
    181 +   H          = H_new
    182 +   ```
    183 +
    184 +4. Reset per‑epoch counters and set `epoch_last_updated = e`.
    185 +
    186 +Recommended starting parameters (for experiments, not yet normative):
    187 +
    188 +- `α_U ≈ 0.1` (heat reacts over ~10 epochs),
    189 +- `α_F = 0` (ignore failures in H(D) initially),
    190 +- `β_F = 0` (no failure amplification until we’re comfortable),
    191 +- `H_max` small (e.g. 10),
    192 +- `δ_H ≈ 0.2` to limit per‑epoch swings.
    193 +
    194 +---
    195 +
    196 +## 5. Optional Economic Hooks (Tilted Storage Rewards)
    197 +
    198 +This section describes a **candidate** way to use `H(D)` to slightly tilt storage rewards. It is deli
         berately conservative and should be considered **Phase C** in a longer rollout.
    199 +
    200 +### 5.1 Storage multiplier m_storage(D)
    201 +
    202 +Define a squashing function:
    203 +
    204 +```text
    205 +g(D) = H(D) / (H(D) + H0)      // H0 > 0
    206 +```
    207 +
    208 +Then the raw storage multiplier:
    209 +
    210 +```text
    211 +m_raw(D) = 1 + s_max * g(D)
    212 +```
    213 +
    214 +To avoid jitter:
    215 +
    216 +```text
    217 +m_new(D) = clamp(m_raw(D),
    218 +                 m_prev(D) * (1 - δ_m),
    219 +                 m_prev(D) * (1 + δ_m))
    220 +
    221 +m_new(D) = clamp(m_new(D), m_min_global, m_max_global)
    222 +```
    223 +
    224 +And we store:
    225 +
    226 +```text
    227 +DealHeat[D].m_storage = m_new(D)
    228 +```
    229 +
    230 +Suggested bounds for experiments:
    231 +
    232 +- `s_max` ≈ 0.25–0.5 (max +25–50% uplift),
    233 +- `δ_m` ≈ 0.1 (max ±10% change per epoch),
    234 +- `m_min_global` ≈ 0.75, `m_max_global` ≈ 1.25.
    235 +
    236 +### 5.2 Plugging into existing storage rewards
    237 +
    238 +Let:
    239 +
    240 +- `R_base(D,P,e,T)` = storage reward for `(D,P)` in epoch `e` with tier `T` **under current Mode 1 lo
         gic**, before any heat tilt.
    241 +
    242 +Candidate new reward:
    243 +
    244 +```text
    245 +R_new(P,e) = Σ_D ( R_base(D,P,e,T(D,P,e)) * m_storage(D,e) )
    246 +```
    247 +
    248 +Notes:
    249 +
    250 +- We do **not** change:
    251 +  - global inflation schedule,
    252 +  - latency tier multipliers,
    253 +  - proof mechanics.
    254 +- We accept that total minted storage reward may deviate slightly from the current target, bounded by
          `m_min_global`/`m_max_global`.
    255 +- A future refinement could add a global re‑normalization factor to keep total inflation exactly cons
         tant, but that is **out of scope** for this RFC.
    256 +
    257 +### 5.3 Bandwidth pricing (deliberately unchanged)
    258 +
    259 +For this RFC:
    260 +
    261 +- Bandwidth price per byte remains `PricePerByte(D)` from the deal.
    262 +- Escrow debits when settling retrieval receipts remain:
    263 +
    264 +  ```text
    265 +  escrow_debit = delta_bytes * PricePerByte(D)
    266 +  ```
    267 +
    268 +- `m_bw(D)` is kept equal to 1 and is not applied to real payments in v1.
    269 +
    270 +Dynamic bandwidth pricing is a separate research track.
    271 +
    272 +---
    273 +
    274 +## 6. Advisory Target Replication & Audit Bias (Optional)
    275 +
    276 +### 6.1 Advisory target replication r_target(D)
    277 +
    278 +We can derive an **advisory** target replication:
    279 +
    280 +```text
    281 +g_r(D)       = H(D) / (H(D) + H0_r)
    282 +r_target(D)  = r_min(D) + floor((r_max(D) - r_min(D)) * g_r(D))
    283 +```
    284 +
    285 +Where:
    286 +
    287 +- `r_min(D)` is the deal’s minimum redundancy (already in spec),
    288 +- `r_max(D)` is a protocol‑bounded maximum (e.g. `r_min + ΔR_LOCAL_MAX`).
    289 +
    290 +In this RFC:
    291 +
    292 +- `r_target(D)` is **informational**:
    293 +  - Dashboards,
    294 +  - Off‑chain placement heuristics,
    295 +  - SP operator tooling.
    296 +- Consensus logic **does not**:
    297 +  - block exits based on r_target (only on r_min),
    298 +  - auto‑adjust rewards beyond `m_storage(D)`.
    299 +
    300 +### 6.2 Audit sampling bias
    301 +
    302 +SP audit debt today:
    303 +
    304 +- For each SP P:
    305 +  - `audit_debt(P) = α_base * stored_bytes(P)` per epoch (fixed).
    306 +
    307 +We can change **only** how we select deals/assignments to satisfy that debt:
    308 +
    309 +- Sample deals D for audits with probability proportional to:
    310 +
    311 +  ```text
    312 +  weight(D) ∝ max(ε_H, H(D)) * file_size(D)
    313 +  ```
    314 +
    315 +Where:
    316 +
    317 +- `ε_H` is a small baseline so cold deals still get some attention.
    318 +
    319 +This bias:
    320 +
    321 +- Does not change total audit volume,
    322 +- Keeps audit mechanics unchanged,
    323 +- Focuses more cross‑SP audits on hot deals where impact of cheating is highest.
    324 +
    325 +---
    326 +
    327 +## 7. Phased Adoption Plan (Non‑binding)
    328 +
    329 +This RFC recommends a three‑phase path, all explicitly opt‑in and reversible.
    330 +
    331 +### Phase A – Measurement only (devnet/testnet)
    332 +
    333 +Implement:
    334 +
    335 +- `DealHeatState` with:
    336 +  - `ewma_util`, `ewma_fail`, `H`,
    337 +  - per‑epoch accumulators.
    338 +- Metric collection and H(D) update at epoch boundaries.
    339 +- Queries that expose:
    340 +  - `H(D)`, `U(D)`, maybe `r_target(D)` (computed but advisory).
    341 +
    342 +No economic behavior changes:
    343 +
    344 +- `m_storage = 1`, `m_bw = 1`,
    345 +- existing reward and bandwidth logic untouched.
    346 +
    347 +### Phase B – Soft influence (testnet)
    348 +
    349 +Add:
    350 +
    351 +- Advisory `r_target(D)` computation (if not already computed).
    352 +- Audit sampling bias:
    353 +  - SP audit‑debt scheduler chooses deals with probability proportional to `max(ε_H, H(D)) * file_siz
         e(D)`.
    354 +- Off‑chain use:
    355 +  - Dashboards visualize heat,
    356 +  - SPs optionally incorporate H(D) into local decision heuristics.
    357 +
    358 +Still no direct economic changes:
    359 +
    360 +- `m_storage = 1`, `m_bw = 1`.
    361 +
    362 +### Phase C – Economic tilting (candidate mainnet feature)
    363 +
    364 +Only after Phase A/B have run long enough to validate:
    365 +
    366 +- Stability of H(D),
    367 +- No obvious gaming or pathologies,
    368 +
    369 +we consider turning on:
    370 +
    371 +- `m_storage(D)` as defined in § 5.1, with conservative bounds.
    372 +- Storage rewards multiplied per deal:
    373 +
    374 +  ```text
    375 +  R_new(P,e) = Σ_D R_base(D,P,e,T) * m_storage(D,e)
    376 +  ```
    377 +
    378 +Bandwidth and retrievability logic remain unchanged.
    379 +
    380 +If any issues arise:
    381 +
    382 +- We can set `s_max = 0` or `m_storage = 1` network‑wide, effectively disabling the tilt while keepin
         g metric collection for analysis.
    383 +
    384 +---
    385 +
    386 +## 8. Risks & Open Questions
    387 +
    388 +This RFC is **not** a final decision to ship dynamic heat; it’s a framework for experiments. Key ques
         tions to answer before promoting any part of it to the main spec:
    389 +
    390 +1. **Economic calibration**
    391 +   - Do small tilts (±20–25%) meaningfully improve SP incentives or deal distribution?
    392 +   - How sensitive are results to `α_U`, `H0`, `s_max`, and bounds on `m_storage`?
    393 +2. **Gaming**
    394 +   - In practice, can SPs or clients cheaply farm H(D) enough to materially distort rewards?
    395 +   - Does the protocol tax on bandwidth + bounds on `m_storage` make self‑dealing clearly negative‑EV
         ?
    396 +3. **State and performance**
    397 +   - For realistic numbers of deals (10k–100k+), what is the impact on:
    398 +     - state size,
    399 +     - per‑epoch update time,
    400 +     - block gas?
    401 +4. **UX and predictability**
    402 +   - Are small, slow storage tilts acceptable for users who think in terms of “static” storage pricin
         g?
    403 +   - Does this complicate mental models or pricing too much for early mainnet?
    404 +5. **Value vs complexity**
    405 +   - Does a measurement‑only heat layer (Phase A/B) already provide enough insight and audit targetin
         g benefits?
    406 +   - Is turning on `m_storage` worth the added complexity, or should it remain a lab feature until af
         ter mainnet?
    407 +
    408 +Until these are answered via simulation and real testnet data, this RFC should be treated as an **exp
         erimental design**, not a commit to change the live protocol.
    409 +

─ Worked for 1m 24s ──────────────────────────────────────────────────────────────────────────────────────────

• I’ve added a non‑normative RFC capturing the heat/placement design so we can experiment without touching the
  core spec:

  - New file: rfcs/rfc-heat-and-dynamic-placement.md
      - Summarizes the idea as an additive “heat layer” on top of Mode 1:
          - Deal‑level DealHeatState,
          - Heat H(D) from bytes served (and optionally failures),
          - Optional storage reward tilt m_storage(D) and advisory r_target(D),
          - Audit sampling bias based on heat.
      - Explicitly states constraints:
          - No change to retrieval semantics, evidence, slashing, or bandwidth pricing,
          - No per‑MDU state on‑chain,
          - No diversity/anti‑concentration or latency‑in‑heat in v1.
      - Details the measurement layer:
          - How to track bytes_served_epoch, failed_challenges_epoch,
          - EWMA updates for ewma_util, optional ewma_fail,
          - Simple linear heat update with bounded per‑epoch changes.
      - Describes a candidate economic hook:
          - Small, bounded m_storage(D) multiplier (e.g. within 0.75–1.25),
          - How to multiply existing per‑deal storage rewards, leaving inflation and bandwidth untouched.
      - Gives advisory r_target(D) and audit‑bias formulas, but stresses they’re informational only.
      - Lays out a three‑phase plan:
          - Phase A: measurement only (no economics),
          - Phase B: audit bias + dashboards,
          - Phase C: optional storage tilting with conservative bounds.
      - Ends with a risks & open questions section to gate any promotion into the main spec.

  Nothing in spec.md was changed; this RFC is a sandboxed design you can iterate on or ignore
  without impacting the current Mode 1 retrievability story.

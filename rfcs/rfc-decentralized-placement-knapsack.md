# RFC: Decentralized Placement & Knapsack Solver

**Status:** Draft / Non‑normative  
**Scope:** Off‑chain / committee‑driven placement optimization on top of Mode 1 and the Heat RFC  
**Depends on:** `spec.md` (Mode 1), `metaspec.md` §7, `rfcs/rfc-heat-and-dynamic-placement.md`

---

## 1. Motivation & Problem Statement

NilStore Mode 1 already defines:

- System‑defined placement at deal creation (the chain assigns `providers(D)`).
- Cryptographic retrievability guarantees via KZG proofs and retrieval receipts.
- Per‑deal heat `H(D)` and optional reward tilting (Heat RFC).

However, two strong requirements remain:

1. **SPs must not cherry‑pick specific files.**  
   Storage Providers (SPs) should choose *capacity* and *capabilities*, not individual deals. The protocol must assign deals to SPs.

2. **Placement optimization must be decentralized and auditable.**  
   The “who stores what” optimization (a knapsack‑like problem) must be driven by:
   - Data derived from cryptographic evidence (receipts, proofs),
   - A decentralized set of optimizer/committee actors,
   - On‑chain rules that validate their proposals and enforce assignments.

3. **Retrievability and self‑healing must remain the hard invariants.**  
   The knapsack/placement layer is allowed to change *who* stores *which* deals and *how often*, but is **not** allowed to:
   - weaken “either data is retrievable or the SP is provably slashable” for any `(Deal, SP)` in `providers(D)`,
   - bypass or replace the evidence model (KZG/Merkle, RetrievalReceipts, SyntheticStorageProofs, fraud proofs),
   - introduce a new opaque source of truth that overrides Mode 1 semantics.

This RFC sketches a design where:

- The chain and a set of DRB‑selected committees jointly act as a **global knapsack solver**.
- SPs declare capacity + capabilities; the system determines which deals they store.
- Optimization work (and its economics) is distributed, not centralized or opaque.

It is intentionally non‑normative; its purpose is to guide research, simulation, and later normative specs.

---

## 2. Constraints & Assumptions

### 2.0 Retrievability & self‑healing invariants (from Mode 1)

From the retrievability memo and metaspec:

- **Retrievability:** For every `(Deal D, Provider P)` such that `P ∈ providers(D)`:
  - There exists a family of *valid retrieval challenges* defined by Mode 1 (using `R_e`, `DeriveCheckPoint`, and the retrieval protocol), and
  - With high probability over epochs:
    - Either P returns correct data for those challenges, or
    - There exists on‑chain, verifiable evidence of failure (invalid KZG/Merkle against `root_cid(D)`, missed proof window, panic‑mode non‑response) that justifies slashing and/or eviction.
- **Self‑healing:** If P behaves badly on D over time:
  - HealthState(D,P) degrades (synthetic failures, fraud proofs, QoS signals),
  - The placement/health layer eventually removes P from `providers(D)` for D,
  - Replacement SPs are recruited so that redundancy and retrievability are restored.

Any decentralized placement / knapsack design that does not preserve these invariants is considered invalid, regardless of economic optimality.

### 2.1 Cryptographic & consensus layer

We assume the Mode 1 and Heat layers are in place:

- Deals `D` with:
  - `file_size(D)`, `r_min(D)`, `r_max(D)`,
  - commitments (root CID / MDU roots),
  - assigned provider set `providers(D)`.
- Retrieval & liveness:
  - Deterministic challenges via `DeriveCheckPoint(R_e, …)`,
  - Synthetic storage challenges `S_e(D,P)`,
  - `RetrievalReceipt` and `SyntheticStorageProof` messages,
  - Fraud proofs, panic‑mode challenges, and slashing.
- Heat metrics:
  - `H(D)`, `U(D)`, `m_storage(D)`, `m_bw(D)` (even if `m_bw = 1` initially).

This RFC **must not** change:

- Validity conditions for KZG proofs and receipts,
- Slashing conditions,
- Baseline redundancy guarantees (`r_min(D)`),
- The on‑chain evidence model.

### 2.2 SP role

SPs:

- Register:
  - Storage capacity `C_storage(P)` and bandwidth commitment `C_bw(P)` (or coarse classes),
  - Capabilities (e.g., `Archive/General/Edge`) and optional locality hints.
- Are assigned deals by the protocol.
- Are slashed / evicted if they fail:
  - Synthetic challenges,
  - Retrieval challenges,
  - Proof windows.

They **do not** decide per‑deal which files to host; they decide how much capacity to offer and whether to participate.

### 2.3 Threat model

- Committees and “placement oracles” may be rational or adversarial.
- Any metric they publish that affects placement or rewards must:
  - Be derivable from underlying cryptographic evidence, or
  - Be challengeable / slashable.
- We accept that committees may propose suboptimal but valid placements; the protocol only requires correctness (constraints satisfied), not exact global optimality.

---

## 3. Roles

We introduce two new logical roles (they may overlap in implementations):

1. **Measurement Oracles / Bandwidth Observers**
   - Aggregate per‑deal/per‑provider metrics:
     - Bytes served (from settlement),
     - Success / failure rates,
     - Optional latency statistics (off‑chain).
   - Commit summarized metrics to chain or make them available to placement committees, with optional fraud‑detection hooks.

2. **Placement Committees (Knapsack Solvers)**
   - A DRB‑selected subset of validators / specialized actors for each **placement epoch**.
   - Observe:
     - Deal metrics (`H(D)`, `file_size(D)`, `r_min`, `r_max`, etc.),
     - SP metrics (capacity, load, capabilities),
     - Current assignments.
   - Propose:
     - A set of assignment changes (add/remove `(D,P)` edges) that respect constraints.
   - Compete in a **proposal + challenge** game; the chain accepts only valid, non‑trivially bad proposals.

The base consensus (nilchaind) remains the final arbiter:

- It verifies proposals,
- Applies accepted placement updates,
- Enforces assignments via existing retrievability & slashing logic.

---

## 4. Metrics & Measurement Layer

### 4.1 What we can see cryptographically

From Mode 1 and Heat:

- Per deal:
  - `file_size(D)`, `H(D)`, `U(D)`, `r_min(D)`, `r_max(D)`, `r_actual(D)`.
- Per `(D,P)`:
  - Successful proofs (synthetic + retrieval‑based),
  - Failed proofs / fraud proofs,
  - Missed proof windows (via downtime slashing).

These are already derivable or stored on‑chain.

### 4.2 What measurement oracles add

Measurement oracles are **not trusted**; they are a convenience for aggregating:

- Derived metrics:
  - Per‑deal/per‑provider load estimates,
  - Soft latency distributions (based on timestamps in receipts),
  - QoS classifications by region.
- Summaries:
  - e.g. “In the last N blocks, SP P served X bytes for deals in bucket B.”

Design constraints:

- Any on‑chain consumption of oracle data must be:
  - Either treated as **soft** (only for ranking, tie‑breaking, or off‑chain UX), or
  - Backed by cryptographic evidence (e.g., claims include commitments to receipts/proofs that anyone can independently verify).
- Misreporting must be cheap to detect and, if used in rewards or placement, subject to slashing via concrete fraud‑proofs.

In early versions, we can:

- Use only on‑chain metrics (bytes served, failures) to drive placement,
- Treat richer QoS data as off‑chain hints.

### 4.3 Evidence‑anchored measurement (sketch)

Long‑term, we want a measurement layer where “bandwidth/latency metrics” are not a new root of trust but a thin veneer over the existing evidence model. One plausible (non‑normative) pattern:

1. **Receipt bundles and Merkle commitments**
   - Oracles (or even SPs themselves) periodically build a Merkle tree over:
     - RetrievalReceipts they have observed,
     - SyntheticStorageProofs,
     - Fraud proofs and slashing events.
   - They publish:
     - The Merkle root,
     - A small per‑Deal/per‑SP summary (e.g., total bytes, success/failure counts),
     - Optional witness data for sampling.
   - Anyone can challenge a misreported summary by providing:
     - A Merkle proof for an included receipt contradicting the summary, or
     - A “missing receipt” proof showing an expected receipt absent from the tree.
2. **On‑chain consumption**
   - When a placement committee relies on oracle summaries in a `PlacementProposal`, it references:
     - The oracle root(s),
     - A hash of the summary table it used.
   - If that summary is later proven inconsistent with the receipts, the oracle can be slashed and the proposal invalidated or discounted.
3. **SP audit‑debt as ground truth**
   - SP audit‑debt (SPs acting as mystery shoppers) and protocol/client‑driven audits already generate a stream of *valid retrievals* with RetrievalReceipts.
   - These form a baseline, cryptographically‑anchored sample of each `(Deal, SP)`’s behavior that no oracle can safely ignore; ignoring them exposes the oracle to simple fraud‑proofs from other participants who hold the receipts.

This RFC does not pick a specific oracle scheme; it encodes the requirement that anything the placement layer uses on‑chain must either:

- Be directly reconstructible from chain state and existing proofs, or
- Be commit‑and‑challenge‑based with clear, cheap fraud‑proofs.

---

## 5. Placement Epochs & Committees

### 5.1 Placement epochs

We define a slower cadence “placement epoch” (e.g., every K blocks) at which placement changes are considered.

At epoch `E`:

- The chain derives a randomness value `R_E` from the DRB.
- It uses `R_E` to:
  - Select one or more placement committees,
  - Partition the space of deals/SPs if needed.

### 5.2 Committee selection

For simplicity:

- Use a DRB‑based, stake‑weighted lottery over validator set or a dedicated operator set:
  - `Committee_E = sample_k(Validators, R_E, stake-weighted)`.
- Optionally, shard by deal ID:
  - Each committee handles a disjoint subset of deals (e.g., by ID range or hash bucket).

The design must resist:

- Committees that try to systematically favor colluding SPs,
- Concentration of placement power in a few identities.

Mitigations:

- Frequent re‑sampling,
- Overlapping committees,
- Challenge games (Section 7).

---

## 6. Placement Proposal Format & Objective

### 6.1 State space

The placement decision space is the bipartite graph between Deals and SPs:

- Vertices:
  - Deals D with attributes: `file_size(D)`, `H(D)`, `r_min`, `r_max`, `r_actual`, etc.
  - SPs P with attributes: capacities, capabilities, current load.
- Edges:
  - `(D,P)` in `providers(D)` indicates P is assigned to store D.

### 6.2 Constraints

Any proposal must satisfy:

- Per deal:
  - `r_min(D) ≤ r_actual_new(D) ≤ r_max(D)`.
  - For each new provider P added to D:
    - P has enough free storage capacity to hold `file_size(D)`.
- Per SP:
  - `Σ_D size(D) ≤ C_storage(P)` (or declared capacity),
  - `Σ_D expected_bw(D,P) ≤ C_bw(P)` (soft; can be approximate).
- Diversity rules (optional):
  - e.g., avoid all replicas in same ASN / region.

These are hard constraints; failing them makes a proposal invalid.

### 6.3 Objective function (illustrative)

We do not require exact optimality, but we want a consistent, measurable objective, e.g.:

```text
Objective(placement) = Σ_D [ H(D) * f(r_actual(D), r_min(D), r_max(D)) ] - λ * Σ_P LoadImbalance(P)
```

Where:

- `f` rewards having `r_actual(D)` near `r_target(D)`:
  - Minimal below `r_min`, saturated at `r_max`.
- `LoadImbalance(P)` penalizes overloading some SPs relative to others.
- λ tunes fairness vs pure heat coverage.

Committees propose placements that:

- Improve this objective relative to the current placement,
- Do not violate constraints.

The exact `Objective` can be simple at first (e.g., sum of `H(D)` for adequately replicated deals) and evolve later.

### 6.4 Proposal encoding

A placement proposal might be a message:

```text
PlacementProposal {
    epoch_id     E;
    committee_id C;
    deals_shard  S;        // subset of deals covered
    added_edges  [(D,P)...];
    removed_edges[(D,P)...];
    objective_before  O_old;
    objective_after   O_new;
    // Optional: commitments to the underlying metrics used
}
```

The chain verifies:

- All constraints,
- That `O_new ≥ O_old + ε` for some minimal improvement ε,
- Integrity of the encoded sets.

The objective values `O_old` and `O_new` MUST be computable from:

- On‑chain state alone (e.g., `H(D)`, `file_size(D)`, capacities, current `r_actual(D)`), and/or
- Oracle‑supplied summaries that are themselves tied to evidence as outlined in §4.3.

No hidden off‑chain information may be required to recompute or verify the objective for a given proposal.

### 6.5 Knapsack analogy & dynamic assignment (illustrative)

It is often helpful to have a concrete mental model of how this “knapsack” behaves and what UX it implies for data users.

Consider three deals:

- Deal A: 1 TB, archive‑like (almost no reads), `H(A) ≈ 0`.
- Deal B: 10 GB, moderately used, `H(B)` mid‑range.
- Deal C: 10 GB, suddenly viral, `H(C)` high.

And two SPs:

- SP₁: “Archive‑optimized”: cheap storage, constrained bandwidth.
- SP₂: “Edge‑optimized”: expensive storage, abundant bandwidth.

Users creating A, B, C only specify:

- redundancy bounds `r_min/r_max`,
- base price settings (storage + bandwidth),
- and maybe loose preferences (“archive‑friendly” vs “performance‑friendly” profile).

They **never** pick specific SPs; they just submit deals into the system.

The system flow, in the steady state, looks like:

1. **Initial placement.**
   - Committees assign:
     - Deal A primarily to SP₁ (archive), satisfying `r_min(A)`,
     - Deals B and C across both SPs according to capacity and diversity rules.
   - At this point, placement may be close to “uniform but redundancy‑respecting”.

2. **Heat reacts to demand.**
   - Over several epochs, Mode 1’s Heat layer sees:
     - A: almost no bytes served ⇒ `H(A)` stays near 0.
     - B: steady moderate traffic ⇒ `H(B)` stabilizes at a moderate value.
     - C: large spikes in retrievals ⇒ `H(C)` climbs toward the top of its band.

3. **Objective / knapsack view.**
   - In the objective `Objective(placement)`, high `H(C)` makes C “valuable to cover well”; low `H(A)` makes A less sensitive, as long as `r_min(A)` is met.
   - SP₁’s archive‑oriented cost curve means additional replicas of C are expensive in terms of bandwidth commitment; SP₂’s edge profile makes additional replicas of C relatively cheap.

4. **Committee proposals.**
   - A placement committee for this epoch, looking at:
     - current `H(·)`,
     - capacities `C_storage`, `C_bw`,
     - current `r_actual(·)`,
   - proposes to:
     - keep A on SP₁ (and maybe one backup SP), since it’s cheap and cold,
     - add more C replicas on SP₂ (up to `r_max(C)`),
     - potentially move one B replica from SP₁ to SP₂ if SP₁ is bandwidth‑constrained.
   - Provided constraints are respected, `Objective(new)` > `Objective(old)`, and no better counter‑proposal arrives, the chain accepts this update.

5. **UX and resource use.**
   - From the **user’s perspective**:
     - They never had to think about SP identities; they just see that:
       - A is stored redundantly and cheaply,
       - C remains retrievable with good performance during its hot period.
   - From the **network’s perspective**:
     - Archive SPs are mostly filled with cold deals (A‑like),
     - Edge SPs are heavily allocated to hot deals (C‑like),
     - Capacity is used near‑optimally given declared profiles and Heat.

Crucially, all of this happens **dynamically and automatically**:

- Users specify *what* they want (size, redundancy, rough performance profile, willingness to pay).
- SPs specify *what they can offer* (capacity, bandwidth, capabilities).
- The system (via committees and the knapsack objective) continuously re‑solves the “who stores what” mapping inside the constraints of Mode 1’s retrievability and self‑healing invariants.

The goal is not to guarantee a perfect global optimum, but to:

- Stay within a *good* region of the knapsack solution space (no obvious waste),
- Offer a **simple UX** for data users (“upload file → choose redundancy & price → system handles placement”),
- Preserve the core safety guarantees of the underlying cryptosystem (commitments, proofs, slashing).

Multiple proposals can be submitted; the chain must decide which to accept (Section 7).

---

## 7. Challenge Game & Validation

Given potentially adversarial committees, we need a lightweight challenge game that enforces:

- **Validity:** Constraints are respected.
- **Non‑triviality:** Proposals that are “obviously worse” can be challenged.

### 7.1 Validity checks (deterministic)

For each proposal, the chain can deterministically check:

- All `r_min/r_max`, capacity, and diversity constraints.
- That `added_edges` and `removed_edges` are consistent with the current placement.
- That `O_new` and `O_old` are computed from the on‑chain view of:
  - `H(D)`, `file_size(D)`, capacities, current `r_actual(D)`.

If any deterministic validity check fails, the proposal is immediately rejected and the proposer can be penalized.

### 7.2 Optimality / “better placement” challenges

We do **not** aim for global optimality on‑chain, but we can allow:

- A challenger to submit a **counter‑proposal** for the same epoch/shard with:
  - A strictly better objective,
  - Valid constraints,
  - Overlapping scope.

Resolution strategy:

- Among all valid proposals received in a window:
  - Choose the one with best `Objective`,
  - Reward that proposer; drop the rest.
- Optionally slashing:
  - Only for proposals that fail validity, not for being non‑optimal.

This makes “bad” proposals wasted effort but only slashes outright invalid ones.

---

## 8. Enforcement & SP Experience

Once a placement proposal is accepted:

- The chain updates `providers(D)` accordingly:
  - Adds/removes `(D,P)` edges per `added_edges` / `removed_edges`.
- SPs are expected to:
  - Begin storing data for newly assigned D (with some grace period / bootstrap window),
  - Continue serving retrieval and synthetic challenges for all assigned deals, as required by Mode 1.
- Enforcement:
  - **Retrievability**:
    - Synthetic challenges and retrieval‑based checks ensure SPs actually hold data.
  - **Downtime**:
    - `CheckMissedProofs` / proof windows slash SPs that stop proving liveness.
  - **Slashing & eviction**:
    - Repeated failure → HealthState → eviction from deals, lower priority in future placements.

SPs can reduce their role only by:

- Reducing their advertised capacity (and thus receiving fewer assignments),
- Eventually leaving the active provider set via on‑chain operations (with notice / cooldown).

They cannot selectively drop an individual hot deal without being exposed by retrievability checks.

From an SP’s point of view, the intended UX is:

- “I commit to:
  - a certain amount of storage capacity,
  - a bandwidth / QoS profile,
  - and (optionally) some coarse capability flags (archive‑friendly / edge‑friendly, regions I can serve).
- The protocol (via placement committees) assigns me a portfolio of deals consistent with that profile.
- If I under‑perform on that portfolio, I lose assignments and stake; if I over‑perform, I am more likely to be chosen again for similar roles.”

There is deliberately **no first‑class notion** of “I will only store *these specific* deals.” Cherry‑picking should be economically unattractive and/or technically incompatible with participating as a full SP.

---

## 9. Interaction with Mode 1 & Heat RFC

This RFC presumes:

- The **Heat RFC** defines `H(D)`, `m_storage(D)`, optional `m_bw(D)`, and advisory `r_target(D)`.
- Mode 1 spec defines:
  - Deals, commitments,
  - Retrieval semantics, evidence types,
  - Synthetic challenge schedules,
  - HealthState & eviction mechanics,
  - SP audit‑debt and mystery‑shopper retrieval responsibilities.

This knapsack solver:

- Treats `H(D)`, `r_target(D)`, observed retrieval volumes, audit activity, and redundancy gaps as *inputs* to its objective.
- Does **not** change:
  - How `H(D)` is computed in the Heat RFC (though it may motivate refinements there),
  - How `DeriveCheckPoint`, KZG/Merkle proofs, or RetrievalReceipts work,
  - What constitutes valid evidence for slashing or eviction in Mode 1.

In early deployments:

- The Heat layer may be measurement‑only (no reward tilts).
- Placement optimization may start with:
  - Simple policies (e.g., keep `r_actual(D) = r_min(D)` everywhere),
  - A single committee plus a purely validity‑based proposal acceptance.

Later:

- As we gain confidence in Heat and measurement oracles, we can:
  - Use `H(D)` more aggressively in the objective,
  - Let committees recommend scaling `r_actual(D)` toward `r_target(D)` for hot deals.

---

## 10. Open Research Questions

This RFC is intentionally high‑level; many details need modeling or prototyping:

1. **Committee design and incentives**
   - How many committees per placement epoch?
   - How large should they be (to balance security vs cost)?
   - What is the right incentive structure for proposers/challengers?
   - Should committee members stake specifically for placement work, with slashing for invalid proposals or provably bad use of oracle data?

2. **Objective function choices**
   - What simple objective yields good behavior (e.g., high heat coverage, acceptable fairness) without being easily gameable?
   - How sensitive is the system to parameter choices?
   - How do we incorporate SP audit‑debt fulfillment, diversity goals, and “fair share” of hot vs cold deals into the objective without making it intractable to compute or validate?

3. **Interaction with geography / diversity**
   - How to fold in:
     - ASN / region diversity,
     - Latency / QoS classes,
   - Without over‑complicating the on‑chain validation logic?

4. **Measurement oracle security**
   - To what extent do we need explicit oracle commitments for metrics vs relying solely on on‑chain receipts?
   - How to slash blatant misreports without over‑slashing for noisy latency estimates?

5. **Scalability**
   - How many deals / SPs can a committee realistically handle per placement epoch?
   - Do we need:
     - Hierarchical placement (per shard or per region),
     - Multi‑stage optimization (coarse global, then local refinements)?

6. **User experience & guarantees**
   - How to expose placement decisions to users (e.g., “Your data is currently on SPs X,Y,Z with these heat & health scores”)?
   - When a deal becomes under‑replicated, how quickly should the system react?
   - How do deal creators express preferences like “archive‑like” vs “low‑latency” in a way that feeds into the decentralized knapsack (via Heat, redundancy, or fees) rather than manual SP selection?

Answering these will determine which parts, if any, of this RFC eventually move into the normative spec, and which remain guidance for off‑chain tooling and committees.

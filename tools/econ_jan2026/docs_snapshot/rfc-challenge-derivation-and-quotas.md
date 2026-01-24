# RFC: Challenge Derivation & Proof Quota Policy (Unified Liveness v1)

**Status:** Sprint‑0 Frozen (Ready for implementation)
**Scope:** Chain protocol policy (`nilchain/`)
**Motivation:** `spec.md` §7.6; Appendix B #3 (challenge derivation), #4 (quota + penalty curve)
**Depends on:** `spec.md`, `rfcs/rfc-mode2-onchain-state.md`, `rfcs/rfc-blob-alignment-and-striping.md`

---

## 0. Executive Summary

NilStore’s “Unified Liveness” requires the chain to deterministically answer:
1. **What** positions a provider must prove for a given epoch (synthetic challenges)
2. **How many** proofs are required (quota)
3. **How organic retrieval** reduces synthetic demand (credits)
4. **What happens** when a provider is invalid vs merely non-compliant (penalty curve)

This RFC freezes:
- a deterministic, anti-grind challenge derivation function
- a quota computation function with explicit parameters
- an accounting model for credits and synthetic fills
- enforcement + penalty outcomes (invalid proof slashing vs quota failure health decay)

---

## 1. Definitions

### 1.1 Epoch
NilStore defines a **liveness epoch** with fixed length:
- `EPOCH_LEN_BLOCKS` (param; e.g. 100 blocks)
- `epoch_id = floor(block_height / EPOCH_LEN_BLOCKS)`

### 1.2 Assignment
An **assignment** is:
- Mode 1: `(deal_id, provider)` where `provider ∈ Deal.providers[]`
- Mode 2: `(deal_id, slot)` where `slot ∈ [0..K+M-1]` and `slot.provider` is the accountable provider

### 1.3 Challenge position
A synthetic challenge position is a pair:
- `(mdu_index, blob_index)`
  - Mode 1: `blob_index ∈ [0..63]` (Blob within MDU)
  - Mode 2: `blob_index` MUST be interpreted as `leaf_index` per slot-major ordering (§8.1.3); `blob_index ∈ [0..leafCount-1]`

### 1.4 Credit
A **credit** is a unit of evidence earned via organic retrieval that reduces synthetic demand.
This RFC accounts credits in **blob-proofs** (not bytes) to avoid ambiguity across Mode 1 vs Mode 2.

---

## 2. Required Chain Inputs (Frozen)

Challenge derivation and quota computation MUST be computable from:
- current block height (for epoch)
- `Deal`: `redundancy_mode`, `service_hint` (legacy), `providers[]`
- **Frozen additions:** `Deal.total_mdus`, `Deal.witness_mdus`, and for Mode 2 the explicit `(K,M)` and slot order (see `rfcs/rfc-mode2-onchain-state.md`)
- epoch randomness `R_e` (see §3.1)
- per-epoch counters for credits + satisfied synthetic challenges (new state; see §5)

---

## 3. Deterministic Challenge Derivation (Anti-grind)

### 3.0 Canonical encoding (must be deterministic)
Unless otherwise stated, hashes are computed over byte concatenation using:
- `U64BE(x)`: 8-byte big-endian unsigned integer
- `U32BE(x)`: 4-byte big-endian unsigned integer
- `ADDR20(provider)`: 20-byte account address obtained by bech32-decoding the provider string (reject invalid)

`SHA256(tag || …)` means SHA-256 over the concatenated byte slices, where `tag` is ASCII bytes.

### 3.1 Epoch randomness
Define the epoch seed as:

```
epoch_start_height = epoch_id * EPOCH_LEN_BLOCKS
R_e = SHA256("nilstore/epoch/v1" || chain_id || epoch_id || block_hash(epoch_start_height))
```

Rationale:
- deterministic and locally computable by all nodes
- unpredictable prior to the epoch boundary (assuming honest majority of validators)
- does not rely on any off-chain RNG or trusted beacon

### 3.2 Challenge set size
For each assignment, the chain derives a target challenge count:

```
quota_blobs = required_blobs(deal, assignment, epoch_id)        // §4
credits_blobs = credits_applied(deal, assignment, epoch_id)      // §5
synthetic_needed = max(0, quota_blobs - credits_blobs)
```

The synthetic challenge set for the assignment is:
- `S_e(deal, assignment) = { C_i | i ∈ [0..synthetic_needed-1] }`

### 3.3 Mode 2: slot-major derivation

Let:
- `K,M` be the deal’s Mode 2 profile
- `N = K+M`
- `rows = 64 / K`
- `leafCount = N * rows`
- `meta_mdus = 1 + witness_mdus`
- `user_mdus = total_mdus - meta_mdus` (must be > 0 for challenges)

For slot `s ∈ [0..N-1]` and challenge ordinal `i`:

```
seed = SHA256("nilstore/chal/v1" || R_e || U64BE(deal_id) || U64BE(current_gen) || U64BE(slot) || U64BE(i))
mdu_ordinal = U64BE(seed[0..8]) % user_mdus
row        = U64BE(seed[8..16]) % rows

mdu_index  = meta_mdus + mdu_ordinal
leaf_index = slot*rows + row
```

The challenge position is `(mdu_index, blob_index=leaf_index)`.

**Exclusions (frozen):**
- Synthetic challenges MUST NOT target metadata MDUs (`mdu_index < meta_mdus`).
- Synthetic challenges MUST NOT target Mode 2 slots with `status != ACTIVE` (repairing slots are excluded).

### 3.4 Mode 1: replica derivation

Let:
- `meta_mdus = 1 + witness_mdus`
- `user_mdus = total_mdus - meta_mdus`

For provider `P` and challenge ordinal `i`:

```
seed = SHA256("nilstore/chal/v1" || R_e || U64BE(deal_id) || U64BE(current_gen) || ADDR20(provider) || U64BE(i))
mdu_ordinal = U64BE(seed[0..8]) % user_mdus
blob_index  = U64BE(seed[8..16]) % 64
mdu_index   = meta_mdus + mdu_ordinal
```

The challenge position is `(mdu_index, blob_index)`.

---

## 4. Required Proof Quota (Policy Freeze)

### 4.1 Parameters
All of the following are chain params:
- `quota_bps_per_epoch_hot` (basis points of stored bytes proved per epoch)
- `quota_bps_per_epoch_cold`
- `quota_min_blobs` (floor)
- `quota_max_blobs` (cap)
- `credit_cap_bps` (max fraction of quota satisfiable via credits)

### 4.2 Normalized “slot bytes”
Quota targets are computed over **slot-responsible bytes** (not entire deal bytes):
- Mode 2: each slot stores `rows * BLOB_SIZE` per user MDU.
  - `slot_bytes = user_mdus * rows * BLOB_SIZE`
- Mode 1: each provider stores full MDUs.
  - `slot_bytes = user_mdus * MDU_SIZE`

### 4.3 Required blobs function

```
quota_bps = (service_hint_base == Hot) ? quota_bps_per_epoch_hot : quota_bps_per_epoch_cold
target_bytes = ceil(slot_bytes * quota_bps / 10_000)
target_blobs = ceil(target_bytes / BLOB_SIZE)
quota_blobs  = clamp(quota_min_blobs, target_blobs, quota_max_blobs)
```

Notes:
- using `BLOB_SIZE` as the unit makes Mode 1 and Mode 2 comparable
- caps ensure quotas remain operationally feasible on low-end nodes

---

## 5. Credit Accounting (Organic Retrieval → Quota Reduction)

### 5.1 What counts as credit
Credits accrue from **completed user retrieval** evidence paths that include valid blob proofs:
- `MsgSubmitRetrievalSessionProof` (preferred)
- `MsgProveLiveness` receipt paths (`user_receipt`, `user_receipt_batch`) while in transition

### 5.2 Credit unit
Each *unique proved blob* counts as **1 credit blob**.
- A session proof covering `blob_count` blobs yields `blob_count` credits, subject to caps.

### 5.3 Credit caps (anti-wash + determinism)
To prevent a single large download from satisfying all synthetic demand indefinitely:
- credits applied per `(deal, assignment, epoch)` are capped:

```
credit_cap = ceil(quota_blobs * credit_cap_bps / 10_000)
credits_blobs = min(credit_cap, unique_proved_blobs_in_epoch)
```

Uniqueness is enforced by storing a per-epoch set keyed by:
`credit_id = SHA256("nilstore/credit/v1" || epoch_id || deal_id || assignment || mdu_index || blob_index)`.

---

## 6. Enforcement & Penalty Curve (Freeze)

### 6.0 Proof acceptance rules (must-fail)
- `system_proof` MUST match one derived synthetic challenge for that assignment and epoch.
  - The chain checks membership by recomputing `C_i` for `i ∈ [0..synthetic_needed-1]` and comparing `(mdu_index, blob_index)`.
  - Duplicate synthetic proofs for the same `(epoch, assignment, mdu_index, blob_index)` MUST NOT be double-counted.
- `session_proof` and receipt paths MAY be outside the synthetic challenge set; they still accrue credits (§5).

### 6.1 Invalid proofs (hard failures)
- A proof that fails verification MUST be slashable immediately (existing devnet behavior).
- Invalid proofs also increment an assignment health failure counter (see `CHAIN-103`).

### 6.2 Quota shortfall (soft failures)
- If, at epoch end, `credits_blobs + satisfied_synthetic_blobs < quota_blobs`, the assignment is **non-compliant**.
- Non-compliance is NOT immediately slashable by default; it:
  - decays the assignment’s `HealthState`
  - reduces placement priority
  - increments a rolling `missed_epochs` counter

### 6.3 Eviction trigger (policy hook)
When `missed_epochs` exceeds `evict_after_missed_epochs` (param), the chain SHOULD:
- mark the slot as `REPAIRING`
- select and attach a `pending_provider` candidate (see `rfcs/rfc-mode2-onchain-state.md`)

---

## 7. Required State Additions (for implementation sprints)

To implement the above without storing per-proof raw history, add collections:

- `QuotaState(deal_id, assignment, epoch_id)`:
  - `quota_blobs`
  - `credits_blobs`
  - `synthetic_satisfied_blobs`
  - `missed_epochs` (rolling)

- `CreditSeen(credit_id)` with TTL to prevent replay/double-counting.
- `SyntheticSeen(challenge_id)` to prevent counting the same synthetic proof twice.

All keys are deterministic hashes to keep store keys bounded.

---

## 8. Test Gates (for later sprints)

- Determinism tests: same chain state + epoch → identical challenge set across nodes.
- Anti-grind tests: challenge set changes with epoch; cannot be precomputed far in advance.
- E2E: no organic traffic → synthetic proofs required; with organic traffic → synthetic needed drops.

# RFC: Mode 2 On-Chain State (Slots, Generations, Repairs)

**Status:** Sprint‑0 Frozen (Ready for implementation)
**Scope:** Chain protocol state (`nilchain/`)
**Depends on:** `spec.md` §6.2, §8.3–§8.4; `rfcs/rfc-blob-alignment-and-striping.md`
**Motivation:** Appendix B #2 (Mode 2 encoding), #6 (write semantics beyond append-only; near-term constraints)

---

## 0. Executive Summary

Devnet Mode 2 currently relies on **implicit encoding**:
- `(K,M)` is derived by parsing `Deal.service_hint` (`rs=K+M`)
- `Deal.providers[]` is treated as the slot order (by convention)

Mainnet requires **explicit typed state** so the chain can:
- enforce invariants (slot ordering, RS profile consistency)
- coordinate **repairs and make‑before‑break replacement**
- derive deterministic per-slot policy (synthetic challenges, quotas, health)

This RFC freezes a **concrete on-chain representation** for Mode 2 and a minimal lifecycle state machine that is forward-compatible with “pending generation” writes later.

---

## 1. Definitions / Invariants

### 1.1 Slot / Profile
- **Profile:** RS(`K`, `K+M`) with `N = K+M`
- **Slot:** integer `slot ∈ [0..N-1]`
- **Base slots:** the canonical `N` providers currently responsible for the deal’s stripe shards
- **Overlay slots:** additional providers per slot (elasticity or replacement candidates); not required for Sprint 3/4, but state is reserved here

### 1.2 Generations
- **Generation:** a monotonically increasing counter `current_gen`
- Every on-chain content commit that changes `Deal.manifest_root` MUST increment `current_gen`.
- Reads are always defined against the **current generation**.

### 1.3 Slab accounting fields (naming freeze)
For chain policy and bounds checks we freeze:
- `size_bytes`: total logical bytes of file contents in NilFS (sum of non-tombstone file lengths)
- `total_mdus`: total number of committed MDU roots in the Manifest commitment (includes metadata + witness + user MDUs)
- `witness_mdus`: number of witness MDUs committed after MDU #0 (metadata region size)
- `user_mdus = total_mdus - 1 - witness_mdus` (derived; must be non-negative)

Notes:
- This RFC intentionally avoids `allocated_length` in protocol state. Gateway/UI MAY keep `allocated_length` as a legacy alias for `total_mdus` (count), per `nil_gateway/nil-gateway-spec.md`.

---

## 2. Proposed On-Chain Schema (Protobuf Freeze)

### 2.1 New messages

```proto
// StripeReplica profile parameters for Mode 2.
message StripeReplicaProfile {
  uint32 k = 1; // data slots
  uint32 m = 2; // parity slots
}

enum SlotStatus {
  SLOT_STATUS_UNSPECIFIED = 0;
  SLOT_STATUS_ACTIVE = 1;
  SLOT_STATUS_REPAIRING = 2; // slot is being replaced/catching up; excluded from quota + rewards
}

// Slot state for Mode 2 (base slot + optional replacement candidate).
message DealSlot {
  uint32 slot = 1; // 0..N-1
  string provider = 2; // current accountable provider (bech32)
  SlotStatus status = 3;

  // Make-before-break: replacement candidate for this slot (optional).
  // While set, the old provider remains accountable; the candidate proves readiness, then is promoted.
  string pending_provider = 4; // bech32 or empty

  int64 status_since_height = 5;
  uint64 repair_target_gen = 6; // == Deal.current_gen when repair starts
}
```

### 2.2 Deal additions (non-breaking)

We keep existing fields for devnet compatibility (notably `providers[]` and `service_hint`), but freeze the new canonical fields:

```proto
message Deal {
  // existing fields...

  // --- Mode 2 explicit encoding (new canonical state) ---
  StripeReplicaProfile mode2_profile = 15; // set iff redundancy_mode == 2
  repeated DealSlot mode2_slots = 16;      // length N, slot-ordered

  // --- Generation / write coordination ---
  uint64 current_gen = 17; // increments on every manifest_root change

  // --- Slab accounting (bounds + policy) ---
  uint64 total_mdus = 14;     // already exists; MUST be set on first content commit
  uint64 witness_mdus = 18;   // NEW; set on first content commit
}
```

**Canonical source of truth:**
- If `redundancy_mode != 2`, `mode2_profile` and `mode2_slots` MUST be unset/empty.
- If `redundancy_mode == 2`, `mode2_profile.k+m == len(mode2_slots)` MUST hold and `mode2_slots[i].slot == i`.

**Legacy fields during migration window:**
- `providers[]` remains populated for LCD/UI convenience and backwards compatibility.
- For Mode 2, `providers[]` MUST equal `[slot.provider for slot in mode2_slots]` until `providers[]` can be deprecated.
- `service_hint` may still include `rs=K+M`, but once `mode2_profile` exists, it is treated as **intent only**, not canonical state.

---

## 3. Lifecycle State Machine (Freeze)

### 3.1 CreateDeal (Mode 2)
At `MsgCreateDeal*` time:
- `mode2_profile` and `mode2_slots` are derived from the request (legacy: parsed from `service_hint`)
- `current_gen = 0`
- `manifest_root = empty`, `size_bytes = 0`, `total_mdus = 0`, `witness_mdus = 0`

### 3.2 UpdateDealContent (commit new manifest)
At `MsgUpdateDealContent*` time:
- Validate `manifest_root` format (already implemented)
- Require `size_bytes > 0`
- Require `total_mdus > 0` and `witness_mdus >= 0` (new fields in message; see §4)
- Set:
  - `Deal.manifest_root = new`
  - `Deal.size_bytes = new`
  - `Deal.total_mdus = new_total_mdus`
  - `Deal.witness_mdus = new_witness_mdus`
  - `Deal.current_gen += 1`

### 3.3 Repair / replacement (make-before-break)

**Start repair:** mark a slot as repairing and set a candidate.
- `slot.status = REPAIRING`
- `slot.pending_provider = candidate`
- `slot.repair_target_gen = Deal.current_gen`

**Candidate catch-up:** performed off-chain (gateway/SP tooling) by reconstructing and storing the required shards up to `repair_target_gen` (or `current_gen` if it advanced).

**Complete repair:** promote candidate and return slot to active.
- `slot.provider = slot.pending_provider`
- `slot.pending_provider = ""`
- `slot.status = ACTIVE`
- `slot.repair_target_gen = 0`

**Policy note:** While a slot is `REPAIRING`:
- clients SHOULD route around that slot for Mode 2 reads (fetch any `K` ACTIVE slots per MDU)
- synthetic challenges and quota accounting MUST ignore repairing slots
- repairing slots MUST NOT earn rewards for liveness proofs (they may still submit a “readiness proof” message; not defined here)

---

## 4. Required Message / Interface Changes (Freeze for Sprint 3+)

### 4.1 UpdateDealContent must carry slab accounting

To make `Deal.total_mdus` and `Deal.witness_mdus` enforceable, the update intent must include them:

```proto
message MsgUpdateDealContent {
  // existing fields...
  uint64 size = 4;         // logical bytes
  uint64 total_mdus = 5;   // NEW: manifest root count
  uint64 witness_mdus = 6; // NEW: metadata witness count
}

message EvmUpdateContentIntent {
  // existing fields...
  uint64 size_bytes = 4;
  uint64 total_mdus = 7;   // NEW
  uint64 witness_mdus = 8; // NEW
}
```

**Gateway/UI contract:** the upload/ingest pipeline already knows these values by inspecting `mdu_0.bin` / slab layout. The gateway response SHOULD include `total_mdus` and `witness_mdus` explicitly; `allocated_length` MAY remain as a legacy alias for `total_mdus`.

---

## 5. Upgrade / Migration Strategy (Devnet → Typed State)

### 5.1 Store migration
Add a one-time migration that:
- For each Deal with `redundancy_mode == 2`:
  - parse `(K,M)` from `service_hint` (legacy)
  - set `mode2_profile`
  - set `mode2_slots` from existing `providers[]` (slot order = list order)
  - initialize `slot.status = ACTIVE`, `pending_provider = ""`, `current_gen = 0` if unset
- Ensure `providers[]` and `mode2_slots[].provider` remain identical.

### 5.2 Post-migration behavior
- New deals write both legacy (`service_hint`, `providers[]`) and canonical (`mode2_*`) fields.
- Chain logic MUST prefer canonical typed fields when present.

---

## 6. Test Gates (for later sprints)

- **Migration test:** legacy Mode 2 deals survive upgrade with identical slot ordering and `(K,M)` values.
- **Invariants tests:** reject inconsistent `(K,M)` vs slot length; reject invalid slot indices.
- **Repair e2e:** multi-SP: mark slot repairing → candidate catch-up → promote → reads stay available (fetch any `K`).

---

## 7. Implementation Checklist (Sprint 3/4)

1. Protobuf + codegen:
   - `nilchain/proto/nilchain/nilchain/v1/types.proto`: add `StripeReplicaProfile`, `DealSlot`, `SlotStatus`, `Deal.current_gen`, `Deal.witness_mdus`, `Deal.mode2_*`.
   - `nilchain/proto/nilchain/nilchain/v1/tx.proto`: extend `MsgUpdateDealContent` + `EvmUpdateContentIntent`.
2. Keeper logic:
   - Populate typed fields at `CreateDeal`.
   - Persist `total_mdus/witness_mdus/current_gen` at `UpdateDealContent*`.
3. Read path constraints:
   - Update `stripeParamsForDeal()` and `providerSlotIndex()` to use typed fields when present.
4. Gateway/UI:
   - Ensure `/gateway/upload` returns `total_mdus` and `witness_mdus` (keep legacy alias fields for transition).
5. Store migration:
   - Add an upgrade handler to backfill typed Mode 2 state for existing deals.


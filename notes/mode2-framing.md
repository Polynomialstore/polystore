# Mode 2 Framing (NilFS + RS Striping)

This note memorializes the current shared framing for Mode 2 (StripeReplica) so we can converge on a coherent spec + implementation.

## 1) Two Layers: Logical vs Physical

### Logical layer: NilFS “volume semantics” (what the deal *means*)
- A Deal represents a logical byte-addressed volume (NilFS) containing files keyed by `file_path`.
- NilFS is responsible for the namespace and offset mapping (MDU #0 file table), not for deciding replication vs striping.

### Physical/service unit: 8 MiB **SP‑MDUs**
- The protocol’s fundamental service unit is an 8 MiB chunk (an “MDU”).
- To avoid confusion with earlier wording, we’ll call these **SP‑MDUs**: they are the canonical 8 MiB units that providers are accountable for *in some form*.
- Metadata MDUs exist alongside SP‑MDUs:
  - **MDU #0** (NilFS super-manifest: file table + root table)
  - **Witness MDUs** (commitment cache / acceleration structure)

### Physical distribution policy: Mode 1 vs Mode 2
- **Mode 1 (FullReplica):** each assigned provider stores the full set of SP‑MDUs + metadata.
- **Mode 2 (StripeReplica / RS):** each SP‑MDU is encoded under RS(K, K+M) and providers store *their share* (shards) of each SP‑MDU, while metadata is fully replicated.

Key point: NilFS defines the *logical bytes*; Mode 2 defines how each 8 MiB SP‑MDU is encoded and distributed.

## 2) What the chain commits to (client perspective)

The chain does not commit to “file hash = X” directly. It commits to a structure that implies all file bytes are fixed:

- `Deal.manifest_root` (48B KZG) commits to a vector of per‑MDU roots.
- For each MDU index, there is an `mdu_root` (Merkle root over blob commitments).
- Each blob commitment (48B KZG) commits to 128 KiB blob bytes.

A proof (Triple Proof / `ChainedProof`) establishes:
1) the per‑MDU root is part of `Deal.manifest_root`
2) the blob commitment is included in the per‑MDU Merkle tree
3) the served blob bytes match the blob commitment

So “what proofs commit to” means: what byte-objects are bound into these roots such that a provider can be held accountable (reward/slash) for them.

## 3) Mode 2 requirements for self-heal / replacement

Desired behavior:
- A Mode 2 deal has `N = K+M` providers responsible.
- If a provider becomes non-compliant, the system can replace them with a new provider.
- The replacement can reconstruct the missing provider’s share using RS decoding from remaining providers.

RS provides *recoverability*. To make repair robust against adversarial peers, the repairer also needs *verifiable expectations* for the blobs it fetches.

## 4) Replicated metadata (“the map”) and how big it is

Mode 2 relies on fully replicated metadata so any repairer can know “what the correct commitments should be”, without requiring the original deal creator to be online.

### 4.1 Required replicated metadata

- **MDU #0 (NilFS super-manifest):** file table + root table (points to the other MDUs)
- **Witness MDUs:** packed array of expected 48-byte blob commitments for each *data-bearing* SP‑MDU (see §6 and §5 Design A)
- **Manifest openings material:** enough information to produce Hop‑1 openings against on-chain `Deal.manifest_root`.
  - In devnet today this is commonly stored as `manifest.bin` (the 128 KiB manifest blob).
  - Protocol requirement: provers/repairers must be able to obtain Hop‑1 openings deterministically from replicated metadata, not by contacting the user.

### 4.2 Witness sizing

Witness size formula:
- Let `S = number of data-bearing SP‑MDUs` (8 MiB units containing logical volume payload)
- Let `L = commitments per data-bearing SP‑MDU` (Mode 1: `64`; Mode 2 Design A: `N*rows`)
- Witness bytes = `S * L * 48`
- Witness MDUs `W = ceil(witness_bytes / 8 MiB)`

Root table capacity constraint (NilFS V1):
- RootTable in MDU #0 is 2 MiB of 32-byte roots → max `65,536` roots.
- Therefore the slab must satisfy: `1 + W + S <= 65,536`.
- This is why “512 GiB logical minus a few MDUs” happens (metadata consumes some root slots).

## 5) How parity is bound into the committed state

We can keep the 8 MiB MDU size unchanged, but we must decide how parity becomes part of the committed/provable state.

### Design A (target): Inline parity commitments per SP‑MDU

This matches the desired serve-first flow:
- each data-bearing SP‑MDU expands into `N*rows` committed blobs (data + parity)
- each provider slot stores only its `rows` blobs
- any slot (data or parity) is challengeable with the same Triple Proof shape

In Design A:
- RS produces parity blobs in addition to the 64 data blobs.
- The per‑SP‑MDU Merkle tree (Hop 2) includes **data + parity blob commitments**.
- Outcome:
  - Parity providers are first-class accountable: they can be challenged/slashed with the same Triple Proof shape.
  - Repair is trustless: fetched parity blobs can be verified against expected commitments.

### Design B (alternative): Parity stored as NilFS-internal content
- Keep Hop 2 exactly as Mode 1: each physical 8 MiB MDU has a 64-leaf tree.
- Store parity bytes in extra “parity MDUs/files” inside the slab (reserved/hidden paths).
- Outcome:
  - Parity is accountable because it is literal slab content.
  - No change to 64-leaf meaning for an MDU.
- Cost:
  - Slab indexing gets more complex (extra MDUs; mapping parity ↔ data-bearing SP‑MDUs).
  - Deal sizing must account for parity MDUs competing for RootTable slots.
  - Efficient packing is needed to avoid wasting space (e.g., 4 MiB parity per 8 MiB data in the default `K=8, M=4` profile).

## 6) Locked decision: Slot-major leaf ordering (prioritize serving)

We prioritize the hot path (serving/proving) and lock the canonical Mode 2 leaf ordering to be **slot-major**.

Definitions:
- `K` = data shards
- `M` = parity shards
- `N = K+M` = total slots/providers
- Constraint: `K | 64` (so rows are integral)
- `rows = 64 / K` (blobs per slot per data-bearing SP‑MDU)
- Total leaf count per data-bearing SP‑MDU in Design A is `L = N * rows`.

Canonical mapping (Design A):
- `blob_index = slot * rows + row`
- `slot = blob_index / rows`
- `row  = blob_index % rows`

Operational implications:
- For a fixed `(data_ordinal, slot)`, the provider’s leaf indices are contiguous: `[slot*rows .. slot*rows + rows-1]`.
- Witness lookup for a provider’s own blobs is contiguous (serve-first).
- RS repair is still straightforward but becomes “strided” in this ordering: to assemble a row, fetch one blob from each slot block.

## 7) Locked: Indexing & on-chain enforcement model

This section defines the missing glue so “non-compliance by slot” is enforceable.

### 7.1 Two index spaces

- `slab_mdu_index`: the index used by `ChainedProof.mdu_index` and Hop 1.
  - This is in **slab order**: `mdu_0` (NilFS), then witness region, then data-bearing SP‑MDUs.
- `W`: witness MDUs count for this deal (derivable from policy + sizing, and/or inferable from on-disk slab layout in devnet).
- `data_ordinal`: the 0-based index of a data-bearing SP‑MDU within the deal.
  - Defined only when `slab_mdu_index > W`:
    - `data_ordinal = slab_mdu_index - (1 + W)`

### 7.2 Provider slot

Mode 2 needs an ordered mapping `slot -> provider`:
- Base case (single stripe): `slot` is the index into an ordered provider list `providers_by_slot` of length `N`.
- Future (elastic overlays): each overlay/stripe would define its own `providers_by_slot` for the same `slot` space.

### 7.3 Enforcement rule (Design A)

For a **data-bearing** SP‑MDU (`slab_mdu_index > W`):
- leaf count `L = N*rows`, `rows = 64/K`
- the prover’s slot is `slot_of(msg.creator)` (lookup in `providers_by_slot`)
- require `blob_index < L`
- require `slot == (blob_index / rows)` (equivalently: `blob_index` is in the prover’s contiguous slot range)

For **metadata** MDUs (`slab_mdu_index <= W`):
- they are fully replicated; slot enforcement is typically not applied.

## 8) Remaining open decisions (what we must still lock)

1) **Parity accountability:** Design A is the current target, but must be explicitly adopted for Mode 2.

2) **Hop‑1 openings source-of-truth:** specify how provers obtain manifest openings (and what is replicated).

3) **Parameter flexibility beyond `K | 64`:** if arbitrary `K` is desired (not dividing 64), the system needs an explicit padding/packing rule (out of scope for this note).

4) **Sizing semantics:** clarify caps:
   - per-SP cap (e.g. 512 GiB) vs client-visible logical cap
   - RS overhead factor `N/K` and metadata overhead (Witness + MDU #0 + manifest openings material)
   - RootTable ceiling `1 + W + S <= 65,536` for NilFS V1

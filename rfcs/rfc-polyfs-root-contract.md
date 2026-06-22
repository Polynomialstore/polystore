# RFC: PolyFS Root Contract (MDU #0 Trust Root)

**Status:** Accepted for issue #213; implementation pending.
**Scope:** Deal root semantics, MDU #0 root-table proof shape, legacy alpha behavior, and devnet migration policy.
**Depends on:** `notes/triple-proof.md`, `rfcs/rfc-blob-alignment-and-striping.md`, `rfcs/rfc-mode2-onchain-state.md`

## 1. Summary

New PolyStore content commits MUST use MDU #0 as the deal trust root.

The previous alpha path committed a separate 128 KiB `manifest.bin` blob whose
cells contained per-MDU roots. That path is capped at 4096 MDU roots and is no
longer the canonical protocol for new deals.

The canonical committed root is now:

```text
polyfs_root = MerkleRoot(
  KZG(MDU0.DU[0]),
  KZG(MDU0.DU[1]),
  ...,
  KZG(MDU0.DU[63])
)
```

Where each `DU` is a 128 KiB KZG blob and MDU #0 is the 8 MiB PolyFS
super-manifest containing the root table and file table.

The Merkle construction is part of the consensus contract:

- Leaf `i` is `BLAKE2s-256(kzg_commitment_i)`, where `kzg_commitment_i` is the
  48-byte compressed KZG commitment for the corresponding DU/shard blob.
- Internal nodes with both children are `BLAKE2s-256(left_child || right_child)`.
- Leaf ordering is profile-specific and internal-node concatenation preserves
  that left-to-right order.
- No padding, duplicated-last-leaf rule, or empty-root value is used for
  committed MDU roots. Every supported root profile has a fixed leaf count.
- For non-power-of-two fixed leaf counts, if a level has an unpaired final node,
  carry that node unchanged into the next level. Proof generation omits a
  sibling for that level, and verification must use the profile's fixed leaf
  count to reconstruct the same carry-forward path.

The supported root profiles are:

| MDU kind | Leaf count | Leaf ordering |
| --- | ---: | --- |
| MDU #0 super-manifest | 64 | increasing DU index `0..63` |
| Replicated metadata MDU, including Witness MDUs | 64 | increasing DU index `0..63` |
| Mode 1 replicated user MDU | 64 | increasing DU index `0..63` |
| Mode 2 striped user SP-MDU | `L = (K+M) * (64/K)` | slot-major `leaf_index` from `rfcs/rfc-blob-alignment-and-striping.md` |

The default Mode 2 profile `K=8`, `M=4` therefore has `L=96` target-MDU
leaves. Verifiers MUST select the target MDU root profile from the committed
deal mode/profile and reject `blob_index` / `leaf_index` values outside that
profile's fixed leaf count.

This construction authenticates:

- `polyfs_root`, the root over MDU #0's 64 DU commitments.
- Target MDU roots, whose leaf count and ordering are determined by their MDU
  kind and the committed deal profile.

## 2. Root Field Semantics

The canonical chain field for new deals is `polyfs_root`.

- `polyfs_root` is the 32-byte Merkle root of the 64 KZG commitments for MDU #0.
- Empty thin-provisioned deals use an empty root (`len(polyfs_root) == 0`) until
  the first content commit.
- A committed deal MUST have `len(polyfs_root) == 32`.
- The old `manifest_root` name is a legacy alpha alias for the retired flat
  manifest KZG commitment and MUST NOT be used as the consensus meaning for new
  deals.

Downstream implementation may reuse the existing protobuf field number during
the devnet clean break, but the schema, JSON, docs, CLI, gateway responses, and
EIP-712/session hashing must treat the field as `polyfs_root` after migration.

REST and local storage encodings:

- Canonical string form: `0x` plus 64 lowercase hex characters.
- Directory key form: 64 lowercase hex characters without `0x`.
- Legacy 96-hex roots are invalid for new committed deals unless a deliberately
  versioned legacy inspection path is being used.

## 3. Legacy Alpha Behavior

For the proof-format migration tracked by issue #212, PolyStore will use a clean
devnet break:

- New deals MUST NOT commit the old 48-byte flat `manifest.bin` KZG root.
- New liveness and retrieval proofs MUST NOT use direct flat-manifest openings.
- Old alpha deals with 48-byte roots are unsupported after the migration unless
  a later PR explicitly adds a versioned legacy verifier.
- `manifest.bin` MAY remain as a debug/cache artifact during transition, but it
  is not canonical and must not be required to fetch or prove new deals.

Devnet rollout MUST either reset state at the proof-format boundary or document
an explicit migration. It must not silently keep old committed deals under new
root semantics.

## 4. MDU #0 Root Table

MDU #0 is partitioned as:

| DU range | Bytes | Purpose |
| --- | ---: | --- |
| 0..15 | 2 MiB | Root table |
| 16..63 | 6 MiB | File table |

The root table has 65,536 scalar cells. It stores roots for MDUs after MDU #0.
Apply this mapping only after rejecting `mdu_index == 0`:

```text
root_table_index = mdu_index - 1
root_table_du    = root_table_index / 4096
root_table_cell  = root_table_index % 4096
```

Therefore:

- `mdu_index == 1` maps to `root_table_du == 0`, `root_table_cell == 0`.
- `mdu_index == 4096` maps to `root_table_du == 0`, `root_table_cell == 4095`.
- `mdu_index == 4097` maps to `root_table_du == 1`, `root_table_cell == 0`.

The root table covers `mdu_index` values `1..65536` inclusive. MDU #0 is
authenticated directly by `polyfs_root`, not by a root-table entry.

Root-table KZG openings use the same 4096-cell blob evaluation domain as normal
data blobs. For `root_table_cell = c`, the opening point is:

```text
z = omega^c mod FrModulus
omega = 7^((FrModulus - 1) / 4096) mod FrModulus
FrModulus = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001
```

`z` is encoded as a canonical 32-byte big-endian BLS12-381 scalar. Verifiers
MUST NOT interpret `root_table_cell` as a raw integer field element or byte
offset.

## 5. Root-Table Entry Encoding

KZG openings return field elements, while MDU roots are 32-byte Merkle roots.
The protocol therefore stores a deterministic field binding for each MDU root,
not the raw root bytes interpreted ambiguously.

For each target MDU root:

```text
mdu_root       = 32-byte Merkle root over the target MDU's profile-selected KZG commitments
mdu_root_fr    = ReduceMduRootToFr(mdu_root)
root_table_cell_bytes = FrToBytesBE(mdu_root_fr)
```

`ReduceMduRootToFr` is the BLS12-381 scalar reduction currently used by
`polystore_core`: construct a 64-byte little-endian wide input whose low 32
bytes are `mdu_root` reversed from big-endian order and whose high 32 bytes are
zero, then call the BLS12-381 `Scalar::from_bytes_wide` reduction. `FrToBytesBE`
is the canonical 32-byte big-endian scalar representation.

Verifiers MUST derive `mdu_root_fr` from the supplied 32-byte `mdu_root` and
compare that derived value to the root-table KZG opening result. Implementations
MUST NOT silently reduce arbitrary bytes in different ways.

## 6. Chained Proof V2 Shape

The V2 proof path is:

```text
Deal.polyfs_root
  -> Merkle inclusion of root-table DU commitment in MDU #0
  -> KZG opening of root-table DU at root_table_cell
  -> target MDU root
  -> Merkle inclusion of target blob commitment in target MDU
  -> KZG opening of target blob data
```

The proof must carry, or allow the verifier to derive:

- `mdu_index`
- `root_table_du`
- `root_table_cell`
- root-table DU KZG commitment
- Merkle path from root-table DU commitment to `polyfs_root`
- target `mdu_root`
- root-table KZG opening proving `RootTable[root_table_index]`
- target blob commitment
- Merkle path from target blob commitment to `mdu_root`
- `blob_index` / Mode 2 `leaf_index`
- target MDU root profile, derived from the committed deal mode/profile and MDU
  kind, so the verifier can validate the Hop 2 Merkle path against the correct
  fixed leaf count
- blob KZG opening point and value

Synthetic liveness challenges target user data MDUs, not MDU #0 or Witness MDUs.
If a future protocol path needs to prove bytes inside MDU #0 itself, it should
use the direct `polyfs_root -> MDU0.DU commitment -> KZG opening` path and must
be specified separately.

## 7. Capacity Semantics

MDU #0 authenticates itself through `polyfs_root`. Its root table authenticates
up to 65,536 additional MDUs.

Let:

```text
W = witness_mdus
S = user_mdus
total_mdus = 1 + W + S
```

The PolyFS V1 root-table cap is:

```text
W + S <= 65,536
total_mdus <= 65,537
```

The public "512 GiB-class" capacity refers to logical user MDU slots before
metadata overhead. Actual user capacity is:

```text
S * 8 MiB
```

Because Witness MDUs consume root-table slots, the maximum user bytes are below
512 GiB whenever `W > 0`.

## 8. Witness MDUs

Witness MDUs are replicated proof-generation metadata. They cache target blob
commitments so providers can build Hop 2 proofs without contacting the original
client.

Witness sizing MUST budget the target root profile's leaf count, not a
hard-coded 64 commitments per user MDU. For a uniform user-data profile:

```text
commitments_per_user_mdu = target_mdu_leaf_count(profile)
witness_commitment_bytes = user_mdu_count * commitments_per_user_mdu * 48
W = ceil(witness_commitment_bytes / 8 MiB)
```

For the default Mode 2 profile `K=8`, `M=4`,
`commitments_per_user_mdu == 96`. A gateway/client that reserves only
`user_mdu_count * 64` commitments for those slabs underallocates Witness MDUs
and cannot generate proofs for parity-slot leaves `64..95`.

Witness MDUs are not an independent trust root. The trust chain remains:

```text
polyfs_root -> MDU #0 root table -> target MDU root -> target blob commitment
```

## 9. Challenge And Session Semantics

Challenge positions remain blob-oriented:

```text
(mdu_index, blob_index)
```

For Mode 2, `blob_index` is interpreted as the slot-major `leaf_index` defined
in `rfcs/rfc-blob-alignment-and-striping.md`.

Verifiers MUST reject challenges whose `blob_index` is outside the target MDU
root profile's leaf count. For the default Mode 2 profile, this means
`blob_index < 96`; for replicated 64-DU roots, this means `blob_index < 64`.

Retrieval sessions continue to pin the current deal root. After migration, that
pin is `polyfs_root`, not the old 48-byte flat `manifest_root`.

This RFC does not introduce arbitrary byte-range proofs. Gateways and clients
still resolve file paths and byte ranges into blob-aligned proof work.

## 10. Implementation Stack

The issue #212 stack must land in this order:

1. Spec contract (`#213`)
2. Core verifier (`#214`)
3. Proto/chain verifier (`#215`)
4. Gateway ingest/proofs (`#216`)
5. Devnet rollout automation (`#217`, can start after this spec)
6. E2E/devnet validation (`#218`)

The sprint is complete only after the updated local devnet accepts a
chain-verified proof for `mdu_index >= 4096` using the V2 proof path.

# `mode2-artifacts-v1` (Canonical Artifact Contract)

This document defines the **canonical on-disk / OPFS artifact layout** for **Mode 2 (RS stripe)** deals.

The goal is that the **gateway** and the **browser/WASM** implementation can produce **byte-identical artifacts** (when feasible) for the same input, so repairs and verification have a single, stable contract.

## Directory Roots

- **Gateway (disk):** `nil_gateway/uploads/deals/<deal_id>/<manifest_root_key>/`
- **Browser (OPFS):** `OPFS:/deal-<deal_id>/`

`manifest_root_key` is a filesystem-safe key derived from the 48-byte manifest root:
- canonical form `0x<96 hex chars>`
- key form: lowercased hex **without** the `0x` prefix

## Required Files (within the directory)

### Metadata MDUs

- `mdu_0.bin`
  - 8 MiB NilFS MDU #0 (super-manifest / root table + file table)
- `mdu_1.bin .. mdu_W.bin`
  - 8 MiB Witness MDUs (packed commitment witnesses)
  - `W` is determined by the NilFS builder given:
    - user MDU count
    - commitments-per-user-MDU (`leaf_count`)

### User Data Shards (RS stripes)

User data is stored as **shards**, not as raw user MDUs.

For each user MDU ordinal `u` (0-based), compute:
- `slab_index = 1 + W + u`

For each provider slot `slot` (0..N-1), where `N = K + M`, store:
- `mdu_<slab_index>_slot_<slot>.bin`
  - length = `rows * BLOB_SIZE`
  - where `rows = 64 / K` and `BLOB_SIZE = 128 KiB`

### Manifest Blob

- `manifest.bin`
  - 128 KiB manifest blob produced alongside the 48-byte manifest commitment (the on-chain `manifest_root`)

## Determinism Rules

### Raw payload → encoded user MDU bytes

Raw payload bytes are encoded into an 8 MiB user MDU using the NilFS scalar packing rule:
- payload is chunked into 31-byte groups
- each group is placed into a 32-byte scalar, **left-padded with zeros** so the payload lands at the end of the scalar
- scalars are written sequentially until the payload is exhausted

This must match:
- `nil_gateway/ingest_mode2.go:encodePayloadToMdu`
- `nil_core` scalar packing implementation used by WASM/FFI

### RS shard ordering (slot-major)

For `K` data shards and `M` parity shards:
- `N = K + M`
- `rows = 64 / K`

Shards are emitted **slot-major**:
- `slot 0` shard bytes (`rows * BLOB_SIZE`)
- `slot 1` shard bytes
- ...
- `slot N-1` shard bytes

### Witness (commitment) ordering (slot-major)

The flattened witness (`witness_flat`) is a concatenation of 48-byte KZG commitments, ordered slot-major:
- for `slot = 0..N-1`
  - for `row = 0..rows-1`

This matches the leaf index mapping used for proofs:
- `leaf_index = slot * rows + row`

## Golden Vectors

Golden vectors live in `testdata/mode2-artifacts-v1/` and define expected SHA-256 hashes for:
- `mdu_0.bin`, witness MDUs
- all shard files
- `manifest.bin`

These vectors are used by Rust, Go, and web unit tests to enforce deterministic outputs and cross-implementation parity.


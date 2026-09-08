# Native verifier allocation baseline

From `polystore_core`, run:

```sh
cargo run --release --locked --offline -j 2 --example verifier_allocations
```

This standalone example counts Rust `System` allocator requests around the exact
`polystore_verify_mdu0_root_table_proof` and `polystore_verify_mdu_proof` FFI
functions called by Go's `VerifyMdu0RootTableProof` and `VerifyMduProof`.
It adds no dependency and does not change the library's allocator.

Fixtures use the existing Go retrieval benchmark's nonconstant canonical scalar
pattern, real RS expansion, Merkle paths and KZG openings. Both root-table and
blob commitments/openings must be nonidentity subgroup points. Every proof must
verify, and changing a blob's claimed value must fail with its Merkle path intact.
The root-table entry is MDU index 2; each list uses successive rows of slot 0.
K8/M4 and K2/M1 both have 96 user-MDU leaves. Root-table paths have six siblings
and these user-MDU paths have seven.

Setup loading, proof generation, input buffers, validity controls and output are
outside measurement. Both reported passes are warm: the full fixture has already
been verified. The example checks that they agree and retain zero measured bytes.
Separate allocator controls test allocation, deallocation and reallocation,
including nonzero retention until a returned buffer is dropped.

Observed baseline on source `d2ef1c86853619dc6c448ea4227e36cb19b8ba6f` plus this
example, using rustc 1.90.0 (`1159e78c4`, LLVM 20.1.8), Cargo 1.90.0 (`840b83a10`),
`aarch64-apple-darwin`, release profile and the checked-in lockfile:

| Profile | Stage | Proofs | Peak live requested bytes | Total requested bytes | Allocation calls | Realloc calls | Retained bytes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Both | Root table | 1 | 2,232 | 48,320 | 967 | 11 | 0 |
| Both | Blob | 1 | 2,456 | 5,944 | 87 | 9 | 0 |
| K8/M4, K2/M1 | Sequential pair list | 1 | 2,456 | 54,264 | 1,054 | 20 | 0 |
| K8/M4 | Sequential pair list | 2 | 2,456 | 108,528 | 2,108 | 40 | 0 |
| K8/M4, K2/M1 | Sequential pair list | 8 | 2,456 | 434,112 | 8,432 | 160 | 0 |
| K2/M1 | Sequential pair list | 32 | 2,456 | 1,736,448 | 33,728 | 640 | 0 |

Each pair invokes root-table verification then blob verification, exactly once
each. The list peak is the maximum live scratch allocation, not the sum of
per-proof peaks. Cumulative bytes and calls scale with proof count.
Allocation calls include successful `alloc`, `alloc_zeroed` and `realloc` calls;
the realloc column is a subset. A successful realloc adds its full new requested
size to cumulative bytes and replaces the old live size. Internal allocator
copies during realloc are not observable.

Source interpretation: `src/kzg.rs::verify_mdu_merkle_proof` and `rs_merkle`
allocate path/tree work buffers. Root-table verification also calls
`src/utils.rs::z_for_cell`, which reconstructs fixed-width `BigUint` values and
computes modular powers on every call. `src/kzg.rs::verify_proof` uses two direct
`bls12_381::pairing` calls, without prover FFT/MSM buffers or copying the setup.
The larger cumulative root-table allocation count therefore must not be read as
live pairing scratch memory. This trace explains the observed sequential peak;
it does not establish a universal worst-case byte bound.

These are requested Rust heap bytes above the pre-call baseline. They exclude
stack, RSS, allocator metadata/rounding/caches, direct C allocations, Go/cgo
allocations, setup/input storage, cold initialization and concurrency. The probe
does not measure chain execution gas or authenticate session-derived challenge
coordinates. Results cover these valid fixtures and paths, not every admissible
Merkle shape, root-table index or malformed input. This is baseline evidence for
#255; it implements no #256 acceleration.

## PSB1 native scratch measurement

The same executable and allocator also measure the new batch boundary:

```sh
cargo run --release --locked --offline -j 2 --example verifier_allocations -- --session-batch
```

This mode derives fresh C2 z values for successive rows, validates the corrected
independent pair checks and the PSB1 call, and verifies that a changed y fails.
The input buffer and proof generation remain outside measurement. It reports a
normal K1/M1 statement (128 leaves, MDU 2) and a separate maximum-path statement
(16,384 leaves, MDU 65536, root path 6 and blob path 14). The latter pads the Merkle
tree with identity commitments solely to exercise the admitted verifier shape;
it is not an RS allocation, deployment profile or capacity qualification.

Observed on source `7144c8d8` plus this probe extension, with the same Rust/Cargo
versions, target, release settings and lockfile as above, default MSM window
selection and approved setup digest
`d39b9f2d047cc9dca2de58f264b6a09448ccd34db967881a6713eacacf0f26b7`:

| Statement | Proofs | Peak requested bytes | Total requested bytes | Allocation calls | Realloc calls |
| --- | ---: | ---: | ---: | ---: | ---: |
| Normal PSB1 | 1 | 4,040 | 60,166 | 1,077 | 21 |
| Normal PSB1 | 2 | 5,320 | 117,630 | 2,142 | 42 |
| Normal PSB1 | 8 | 15,744 | 463,518 | 8,558 | 170 |
| Normal PSB1 | 32 | 62,976 | 1,851,272 | 34,187 | 676 |
| Normal PSB1 | 64 | 125,952 | 3,702,150 | 68,341 | 1,349 |
| Maximum-path PSB1 | 1 | 5,944 | 65,296 | 1,151 | 29 |
| Maximum-path PSB1 | 2 | 7,224 | 127,862 | 2,288 | 58 |
| Maximum-path PSB1 | 8 | 15,744 | 504,026 | 9,112 | 234 |
| Maximum-path PSB1 | 32 | 62,976 | 2,013,612 | 36,425 | 932 |
| Maximum-path PSB1 | 64 | 125,952 | 4,027,712 | 72,880 | 1,861 |

Both warm passes matched exactly and retained zero Rust heap bytes. Independent
verification of the same normal fresh fixtures peaked at 2,504 bytes at each
count; its cumulative requested bytes were 54,952 times the proof count. PSB1
holds the bounded opening list, complete transcript, coefficients and MSM
points/scalars concurrently, accounting for its O(proofs) native scratch.
Merkle path work is bounded and reused sequentially. No new native pool or cache
is retained. Existing WASM MSM scratch retention is outside this native probe.

These measurements characterize the native API only. They do not replace the
required public K8/K2 keeper benchmarks, include the Go transport buffer, or
measure stack, RSS, allocator internals or direct C allocations. The maximum
shape is a tested bound case, not a proof that every malformed input reaches
that same peak. The probe reports memory; it makes no throughput claim.

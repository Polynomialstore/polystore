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

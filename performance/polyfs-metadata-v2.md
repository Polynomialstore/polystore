# Canonical metadata format: local cost

The FAT v2 format adds whole-buffer validation before accepting metadata.
This is the first #257 implementation slice; these measurements do not qualify
authenticated retrieval, delivery, sustained capacity, or activation.

Three interleaved baseline/candidate runs on an Apple M3, macOS, with
`GOMAXPROCS=2`, compare the same logical 8 MiB metadata containing 1,000 records.
No other test, build, or node process ran during the measurements; normal
desktop processes remained. This is a local characterization, not a dedicated
performance runner. Raw timings, source heads and native library SHA-256 values
are in [the artifact](polyfs-metadata-v2-2026-09-08.json).

`INFRASTRUCTURE_UNAVAILABLE: dedicated runner`; the fallback is the local
desktop, with its native build cache and repository-tracked artifacts.

| Operation | Previous raw FAT median | Validated FAT v2 median | Go heap, both versions |
| --- | ---: | ---: | ---: |
| Load and free 8 MiB / 1,000 records | 0.198 ms | 2.011 ms | 8 bytes / 1 allocation |
| Read all 1,000 records | 0.085 ms | 0.137 ms | 256,000 bytes / 1,000 allocations |
| Export 8 MiB | 0.557 ms | 0.530 ms | 8,388,608 bytes / 1 allocation |

The load increase is an explicit security cost: the old loader did not validate
all roots, records, padding and unused bytes. The coordinator accepts this
bounded cost for the format slice. Scalar decoding was removed from public
root range checks, and unused padding uses one contiguous scan. Record reads
copy only the requested fixed-size record. No cache or separate parser is
introduced to avoid validation.

Go allocation counters exclude Rust allocations. The maintained
`fat_v2_allocations_test.rs` check measures native allocator requests: borrowed
validation, append, 1,000 record/root/range reads and borrowed byte export each
allocate zero bytes; owned loading allocates exactly one 8,388,608-byte slab.
Rejecting nonzero final padding allocates only its 24-byte error string, with no
slab allocation. These are allocator requests, not peak process RSS. The C-to-Go
export copy shown above is separate from the borrowed Rust export.

From `polystorechain`, reproduce the maintained benchmark with:

```sh
GOMAXPROCS=2 ../scripts/chain_go.sh test -p 2 -run '^$' \
  -bench '^BenchmarkMdu0Metadata$' -benchtime=200ms -count=3 ./x/crypto_ffi
```

For the recorded comparison, the identical `BenchmarkMdu0Metadata` function
was temporarily copied into the pre-v2 baseline test package, linked against
its recorded native library, run in alternating pairs, then removed. Each
version constructs its own format outside the timed loops. Rebuild the native
library for the source under test before measuring. The allocation guard runs
from `polystore_core` with:

```sh
cargo test --release --offline -j 2 --test fat_v2_allocations_test
```

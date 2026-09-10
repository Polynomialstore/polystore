# Native V3 browser qualification

Status: small, multi-MDU and realistic 1 GiB production-browser qualification passed.

The production browser retrieves one logical range through one paid native V3 session. Complete encoded bytes are authenticated before decode, durable write and acknowledgment. KZG challenges remain sampled: 1 for the aligned 1 KiB case and 132 for both the 16 MiB + 1 and 1 GiB cases.

The small and multi-MDU correctness runs used a Linux browser with four validators and twelve provider-daemons on one host. The 1 GiB pilot used a separate Mac browser over LAN SSH forwards to the same server topology: Apple M3, 16 GiB RAM, macOS 26.2 and Chrome 152.0.7977.83, with an AMD Ryzen 7 9700X Linux server. The fixed EVM test wallet signs automatically; human MetaMask interaction is outside these timings. The synthetic payload repeats a deterministic 4 KiB nonconstant pattern; SSH compression is disabled and the gateway streaming route has no response-compression middleware. This is a controlled LAN deployment measurement, not an entropy or WAN comparison. Public activation remains disabled by default.

## Correctness evidence

- 1 KiB: one paid session, verified output, cached download without additional MDU requests or payment, estimation rejection and wallet cancellation before payment, and strict post-deadline refund without a second open or provider access.
- 16 MiB + 1: one paid session spanning three user MDUs; rejected corruption of its sole unsampled coordinate, wrong multipart order and truncation; reconciled an unknown open; reloaded from flushed output without refetching the completed target chunk; completed all eight obligations and reused the authenticated cache.
- 1 GiB: one paid session, 1,064 bounded transport chunks, 132 accepted samples across eight provider proof transactions, nine browser control transactions, all bytes verified/flushed, and the same SHA-256 for paid and cached output. The cache made no additional MDU requests or payments. Normal independent storage audits accepted all 72 required samples. Both pre-payment rejection cases also passed.
- Each completed paid retrieval joins canonical committed receipts on all four validators and checks every sampled ordinal exactly once. Completed and expiry cases reconcile payer, provider, burn, escrow, refund and concurrent mint accounting.

The live pre-payment cases cover estimation rejection and wallet cancellation. Unsupported authority, provider, transform, legacy, replay and rollback cases are covered by the public unit/integration tests in the landed implementation PRs. State evidence is structural: one session, bounded obligations and bitmap, one cumulative browser checkpoint, and terminal journal cleanup; it is not a serialized database-size measurement.

The 1 KiB run uses source `36692ac6`; the later test-only change accepts zero-sample obligations without requiring a provider proof transaction. Its one-positive-sample assertion and expiry flow are unchanged. A unit regression still requires all assigned data to be verified and flushed before a zero-sample obligation is acknowledged.

## Measured 1 GiB result and target

The [retained large summary](large-summary.json) records one completed pilot at browser/harness source `3e15b238` and native runtime `071b2a9f`. Its **paid retrieval qualification took 654.052 seconds (10m54s)**, including verification, durable output, sampled proof settlement and final assertions. Effective logical payload throughput for that entire interval was 13.13 Mbit/s. The cache qualification took **5.076 seconds**, including hashing the saved output. Fixture construction, generation admission, storage audits and the additional rejection tests bring the entire harness to 1,268.177 seconds; that is not download time.

| Browser phase | Calls | Summed work | Occupied elapsed time |
| --- | ---: | ---: | ---: |
| Frozen metadata authentication | 1 | 5.697 s | 5.697 s |
| Chunk fetch and parsing | 1,064 | 1,196.517 s | 601.477 s |
| Encoded-byte integrity verification | 1,064 | 4.997 s | 4.993 s |
| Decode and output write | 1,064 | 9.114 s | 9.114 s |
| Durable flush | 1,064 | 2.709 s | 2.709 s |
| Open transaction, including inclusion | 1 | 0.933 s | 0.933 s |
| ACK inclusion | 8 | 10.957 s | 10.957 s |
| Provider settlement request | 8 | 21.537 s | 21.537 s |

Two chunks can be fetched concurrently. Occupied time is the union of intervals in that category; categories themselves overlap and must not be summed into a wall-time breakdown. The first verified output write occurred 11.492 seconds after the paid interval began; this includes fetching, parsing, verifying and decoding the complete first chunk, so it is not HTTP time to first byte.

Provider timing across the eight successful proof submissions totals 8.372 seconds for proof preparation, 0.701 seconds before broadcast, 0.011 seconds for broadcast and 11.045 seconds observing commitment. The provider total is 20.784 seconds, including 0.009 seconds of authority checks and 0.645 seconds of other local work. Proof preparation includes metadata/root work, commitment/opening generation and self-verification; it is not an isolated KZG-operation benchmark. Browser and provider clocks describe overlapping work.

The dominant measured category is chunk fetch and parsing. It wraps endpoint resolution, gateway/provider authority and preparation, response transfer, complete-body buffering and multipart parsing. These measurements do not separate LAN time from server reads/queries or browser parsing. The data route authenticates bytes with SHA/Merkle proofs; sampled KZG generation runs separately during settlement. Further optimization should profile that composite fetch path before attributing its time to the network, storage or proof system.

The chain accepted 68,027,328 gas and 102,457 serialized bytes across eight proof transactions, versus 68,019,728 gas and 102,450 bytes in the 16 MiB + 1 run. Both cover 132 samples. The 1 GiB browser's nine control transactions used 2,825,440 gas and 4,446 bytes. Accounting charged 8,458 stake, paid providers 8,033 stake and burned 425 stake, with no locked fee remaining; gas is accounted separately in aatom. One bounded session and eight obligations cover the complete range. Sampled Mac browser-tree peak RSS was 1,596,964,864 bytes; see the memory scope below. These are retrieval measurements; [#290](https://github.com/Polynomialstore/polystore/issues/290) owns the separate chain-capacity result.

**Provisional practical target: complete the 1 GiB paid retrieval qualification within 14 minutes on this topology.** This is the measured 654.052 seconds plus an explicit 25% operating margin, rounded up to a whole minute (`ceil(654.052 × 1.25 / 60) × 60 = 840 seconds`). It is a regression target derived from one completed deployment pilot, not a p95, WAN or public-service SLA. Use the same phase boundary and correctness checks when comparing future runs; recalibrate from retained measurements when hardware, topology or concurrency changes. The 30-minute retrieval allowance and outer timeout remain test-cost limits.

An earlier large pilot stopped during pre-payment file-index synchronization, before any retrieval opened. Replays with both its original browser profile and a fresh profile succeeded; the cause was not established. The final harness adds immediate synchronization-error reporting and bounded browser failure diagnostics. The passing run does not establish a failure-rate estimate.

## Measurement boundaries

The total harness duration includes fixture construction, generation admission and independent storage audits. Browser elapsed time also includes page setup; the paid retrieval qualification interval starts before opening the download controls and ends after file hashing plus settlement, accounting and receipt assertions; it excludes the subsequent cache retrieval. Phase categories overlap, and provider and browser monotonic clocks cannot be combined. Wire-byte totals are unmeasured; authenticated payload bytes and request counts are retained. The multi-MDU fault run deliberately retries and reloads, so it is a correctness test rather than a throughput baseline.

Foreground provider proof requests do not queue for a signer: busy admission returns HTTP 429. The artifacts retain the expected successful proof outcomes and CLI sequence retries; failed HTTP admission attempts are not counted. Provider timing starts after signer admission; pre-broadcast timing includes CLI account lookup, simulation, transaction construction and signing. Mutex scheduling and isolated cryptographic signing latency are not measured.

Linux memory is cgroup charged memory for Playwright and its owned Chromium processes, including file cache; it excludes validators, provider-daemons and the user-gateway. The small main peak spans paid/cache and both pre-payment cases; expiry has a separate cgroup. The multi-MDU peak spans its fault/reload/recovery/cache case. The Mac reports a sampled sum of process-tree RSS, which can double-count shared pages and miss short peaks. These figures are not JavaScript heap measurements.

## Reproduction

Use the ordered small, multi-MDU and Mac LAN commands in [the production-browser runbook](../../../docs/retrieval-v3-large-session-profile.md#isolated-production-browser-qualification). Source and runtime identities and hashes are recorded in the safe summaries. Browser raw inputs and outputs are retained privately because they include wallet and session state; manifest hashes identify those artifacts.

## Allocation and proof-cost profile

Native V3 keeps proof and control work bounded as retrieval size grows. For K=8, `U` is the number of systematic encoded blobs touched by the requested range, `Q = min(U, 132)` is the sampled-proof count, and `O` is the number of nonempty residue-slot obligations (`O <= 8`). The browser sends one session-open transaction and one ACK per obligation. Provider proof transactions are counted separately from the retained sample ordinals: a zero-sample obligation needs no proof transaction, while a slot with more than 64 samples is split across transactions by the message cap.

| Case | Range | U | Q | O | Browser control tx (`1 + O`) |
|---|---|---:|---:|---:|---:|
| 1 KiB | blob 0 | 1 | 1 | 1 | 2 |
| Three-blob control | blobs 63–65 | 3 | 3 | 3 | 4 |
| 16 MiB + 1 fault fixture | blobs 0–132 | 133 | 132 | 8 | 9 |
| 1 GiB | blobs 0–8,456 | 8,457 | 132 | 8 | 9 |

The three-blob control crosses an MDU boundary. It is distinct from the 16 MiB + 1 boundary-spanning, tail-unaligned browser fault fixture, whose 133-blob population guarantees one unsampled data coordinate.

### Measured control-plane allocations

Ten Linux/amd64 Go 1.25.5 runs used `-cpu=1`, `-benchtime=1s`; fixture and context construction were outside the timed challenge benchmark.

| Case | Plan median | Plan heap | Challenge median | Challenge heap |
|---|---:|---:|---:|---:|
| 1 KiB | 37.080 ns/op | 448 B/op, 1 alloc/op | 2,808.0 ns/op | 2,248 B/op, 24 allocs/op |
| Three-blob control | 45.935 ns/op | 448 B/op, 1 alloc/op | 6,654.5 ns/op | 4,560 B/op, 55 allocs/op |
| 1 GiB | 65.925 ns/op | 448 B/op, 1 alloc/op | 264,966.5 ns/op | 169,984 B/op, 2,289 allocs/op |

A counting allocator around synchronous K=8/M=4 Rust calls measured requested Rust heap bytes and allocation calls. It excludes fixture creation, stack and RSS, allocator usable-size overhead, direct C allocations, Go/cgo, keeper-message handling, WASM/browser state, and end-to-end process memory.

| Native component | Peak requested | Total requested | Allocations / reallocations | Retained |
|---|---:|---:|---:|---:|
| Root-table proof verification | 2,232 B | 48,320 B | 967 / 11 | 0 B |
| Blob proof verification | 2,456 B | 5,944 B | 87 / 9 | 0 B |
| Sequential root-table + blob verification, one proof | 2,456 B | 54,264 B | 1,054 / 20 | 0 B |
| Sequential root-table + blob verification, eight proofs | 2,456 B | 434,112 B | 8,432 / 160 | 0 B |
| Fresh opening generation | 622,592 B | 665,336 B | 888 / 3 | 0 B |

All 12 `warm_first`/`warm_repeat` pairs matched exactly, and every measured call retained zero Rust heap bytes. These are warm component measurements after fixture validation; they do not measure cold initialization. Opening generation covers `compute_proof`, excluding commitment generation and verification.

### Source-derived cryptographic work

These operation counts come from the reviewed call structure, rather than hardware performance counters:

- Chain final execution verifies one root-table opening and one blob opening per accepted sample. Each verification makes two pairing calls, so the chain performs `4Q` pairing calls: 4 for 1 KiB and 528 for the 16 MiB + 1 and 1 GiB cases. This is per-validator final execution; simulation, CheckTx, or replay can execute verification again.
- The provider sampled-blob loop commits the received blob, computes its opening, and verifies that opening. For ordinary nonzero, nonconstant blobs, this is nominally `2Q` MSMs and exactly `2Q` sampled-loop pairing calls. Each `userMDUFor` root-cache miss (`R`) also generates a manifest opening and self-verifies the root, adding `2R` pairing calls. Metadata/root cache state, MDU access order, eviction, and zero/identity shortcuts make total provider MSM work cache-dependent, so `2Q` is not a total-provider invariant. Metadata authentication may also compute up to 64 MDU0 blob commitments per cache miss.
- The browser authenticates frozen metadata and every delivered payload blob at its exact coordinate using SHA/Merkle integrity before decode and durable write. Sampled KZG proof generation runs at the provider and sampled KZG verification runs on chain; the browser does not perform a KZG proof check for every payload blob.

The measurements were taken on an AMD Ryzen 7 9700X with Rust/Cargo 1.98.1 from qualification candidate `36692ac6fbfcf6505920467e000909b3172bcc02` (tree `5383d3b0c267f0b4e54ad964d889c51d5a746916`). The measured native component came from runtime `071b2a9fa7f482dcd188c44c85c0d678ac5f3d96`; its relevant `polystore_core` sources and lockfile were byte-identical to the candidate components. Raw outputs, hashes, commands, and the parsed summary are retained with the qualification evidence.

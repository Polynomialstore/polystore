# Native retrieval v3 chain capacity

Run `native-v3-chain-capacity-4e7860ff-005` passed the proof-only qualification on a four-validator local chain at source commit `4e7860ffc99fc1bc188a64a4187443bc29cf018d`.

| Logical range | Samples/session | Proof tx/session | Proof tx/s | Openings/s | Complete sessions/day | Logical GiB/day |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 KiB | 1 | 1 | 49.77 | 49.77 | 4,300,203 | 4.10 |
| 992 KiB | 8 | 8 | 48.84 | 48.84 | 498,402 | 471.51 |
| 16 MiB sample cap | 132 | 8 | 3.01 | 49.64 | 32,494 | 507.71 |

These are different units. A proof transaction can contain one or many sampled KZG openings. A complete session requires every provider proof obligation for that range. The daily values are the measured short saturated rate multiplied by 86,400; they are neither a sustained 24-hour result nor file-delivery throughput.

All 2,640 offered proof transactions committed. The measured set contained 3,880 sampled openings, with no invalid, unknown, duplicate, dropped, or retried transaction. The 1 KiB workload rotates its range across all eight provider slots. The 992 KiB workload exercises eight providers with one opening in each proof transaction. The 16 MiB workload reaches the 132-opening protocol sample cap and packs those openings into eight provider transactions.

The rate denominator is the longest continuously observed monotonic interval in which all four validator mempools remain positive. The numerator counts committed workload transactions in block heights `(observed_start_height, observed_end_height]` at that interval's height observations. Post-drain reconciliation confirms transaction identity and completion; it does not extend the rate denominator. The measurement excludes session opening, transfer, provider reads, proof generation, local verification, gas simulation, signing, acknowledgment, expiry, and refunds. Consensus header timestamps are retained only as diagnostics because a block header time is the weighted median of the previous commit and does not bound the broadcast interval.

The chain used a 64,000,000 maximum block gas and 2 MiB maximum block bytes. The 16 MiB profile committed exactly four proof transactions per block and averaged 54.1M gas wanted per block, showing that sampled-opening verification cost, expressed through the block gas limit, constrains that profile.

## Host utilization

The benchmark host has 16 logical CPUs and 32.1 GB RAM. Twelve-second samples taken while every validator had a positive mempool backlog found 89.34%, 90.10%, and 91.90% aggregate CPU idle across the three profiles. I/O wait stayed at or below 1.10%. Each validator averaged 26% to 38% of one CPU and about 326 to 360 MiB RSS.

The host was therefore underutilized at the measured normal chain configuration. This run establishes the resulting chain capacity; it does not isolate how capacity changes under different consensus timing or block-gas parameters.

## Reproduce

The checked-in reproducer is `scripts/retrieval_four_validator_workload.py --mode native-v3-chain`. Build the proof exporter as the gateway package's opt-in Go test executable, linked to the same native library used by the run:

```sh
export POLYSTORE_CORE_RELEASE=/path/to/polystore_core/target/release
export POLYSTORE_PROOF_EXPORTER=/path/to/retrieval-inventory-exporter.test
(cd polystore_gateway && \
  CGO_LDFLAGS="-L$POLYSTORE_CORE_RELEASE -lpolystore_core" \
  go test -c -o "$POLYSTORE_PROOF_EXPORTER" .)
```

Then supply the product chain, native library, gateway, CLI, source checkout, exporter, and a fresh output directory:

```sh
python3 scripts/retrieval_four_validator_workload.py \
  --mode native-v3-chain \
  --binary /path/to/polystorechaind \
  --library /path/to/libpolystore_core.so \
  --gateway-binary /path/to/polystore_gateway \
  --cli-binary /path/to/polystore_cli \
  --product-source "$PWD" \
  --proof-exporter "$POLYSTORE_PROOF_EXPORTER" \
  --home /path/to/new-run-directory \
  --timeout 3600
```

[`results.json`](results.json) contains the exact rates, accounting, block and transaction gas, transaction sizes, conservative inclusion-latency bounds, failures, resource samples, artifact hashes, and provenance. The supplied binary and library hashes are recorded, but correspondence between those artifacts and the source checkout was not independently attested.

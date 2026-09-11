# Retrieval-v3 block-gas capacity sweep

Four exact-head runs at `fe47df84d724465018b6f725a7ed12ea108ad3ea` measured one-opening, 1 KiB retrieval-v3 provider-proof confirmation on the same four-validator local chain and 16-CPU host.

| Max block gas | Proof sessions/s | Sessions/day | Gain from prior point | Mean commit interval | Validator CPU (one core) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 64M | 49.62 | 4,286,787 | - | 1.36s | 29-30% |
| 128M | 95.98 | 8,292,697 | 93% | 1.46s | 51-52% |
| 256M | 141.08 | 12,189,621 | 47% | 1.98s | 77-79% |
| 448M | 155.15 | 13,405,099 | 10% | 3.19s | 84-89% |

Every run maintained a positive all-validator mempool backlog, committed every offered transaction exactly once, and recorded no invalid, unknown, duplicate, dropped, or retried transaction. The 2 MiB block-byte limit did not constrain the sweep: the 448M point averaged 535,247 proof-transaction bytes per saturated block.

Increasing block gas therefore moves proof confirmation close to this implementation's current execution ceiling, but it does not make one validator use the host's remaining cores. At 448M, each validator approached one busy core while the four validator processes together used about 21% of the 16-CPU host. The limiting application path is largely serial per validator. Running four validators on one host is only the benchmark topology; production capacity is bounded by each validator, not by adding their CPU use together.

The recommended next activation candidate is **128M**. It provides 93% more capacity than 64M while retaining about half a core of measured validator headroom. Issue #326 owns its sustained consensus qualification and coordinated activation. A 256M activation needs a separate sustained consensus and `FinalizeBlock` latency qualification because it raises mean commit cadence to 1.98 seconds and uses about 78% of one core. The 448M point identifies the plateau and should not be activated: it adds only 10% capacity over 256M while stretching mean commit cadence to 3.19 seconds.

The 128M recommendation was superseded by the [failed 128M qualification](../qualification-128m-326/). That separate-transaction result remains historical evidence. The [current 160M post-batch operational profile](../../../scripts/retrieval_consensus_profile.json) depends on the same-provider batching work in [PR #331](https://github.com/Polynomialstore/polystore/pull/331).

The sessions/day values are the short saturated rate multiplied by 86,400. They are chain proof-confirmation capacity, not a sustained 24-hour claim or file-transfer throughput. Session opening, data transfer, proof preparation, local verification, signing, owner ACK, settlement recovery, expiry, and refunds are outside the timed interval. The runs retained normal audit traffic but did not measure the configured 700ms execution budget or validator restart behavior.

## Reproduce

Build the product binaries, native library, and proof exporter, then run each point with a fresh output directory:

```sh
python3 scripts/retrieval_four_validator_workload.py \
  --mode native-v3-chain \
  --binary /path/to/polystorechaind \
  --library /path/to/libpolystore_core.so \
  --gateway-binary /path/to/polystore_gateway \
  --cli-binary /path/to/polystore_cli \
  --product-source "$PWD" \
  --proof-exporter /path/to/retrieval-inventory-exporter \
  --home /path/to/new-run-directory \
  --chain-capacity-profile 1kib \
  --chain-capacity-transactions 1536 \
  --chain-max-gas 128000000 \
  --timeout 3600
```

[`results.json`](results.json) records exact rates, reconciliation counts, interval boundaries, gas, block bytes, validator CPU, artifact hashes, and remote evidence paths. The source evidence remains on the benchmark host because the per-transaction records are several megabytes. Its SHA-256 hash is recorded for each point. The benchmark records binary hashes but does not independently attest that supplied binaries correspond to the source checkout.

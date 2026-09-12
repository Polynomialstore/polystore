# Retrieval V3 batch gas frontier (#326)

## 160M qualification candidate

The earlier frontier below used the old flat per-proof gas schedule. It is
historical evidence and no longer controls activation. The current schedule
charges every independent public proof route 1,200,000 gas per proof and charges
the aggregate V3 route 1,000,000 base gas plus 100,000 for each additional proof.
An exact-handler comparison at source `67b3f3c1` measured 64-entry aggregate
acceptance at 36.439ms (7.3M crypto gas) and independent acceptance at 5.332ms
per proof (now 1.2M crypto gas). The aggregate shape therefore consumes about
4.99ms of measured handler work per million reserved crypto gas versus 4.44ms
for independent proofs. SDK transaction work is metered separately, and the
retained 192M comparator also measured larger bytes and used gas per session for
separate transactions.

Thus an all-aggregate block is the conservative measured public-proof mix under
the new schedule: replacing aggregate gas with independent proofs reduces the
measured proof-handler work admitted by that gas. The final qualification uses
only the aggregate shape and does not require another mixed-chain sweep. The
fixed 160M candidate is 7,680 one-opening sessions in 120 batches of 64,
`GOMAXPROCS=4`, one-second `timeout_commit`, at least ten saturated blocks, and at
least ten seconds of positive backlog. Retained collection follows after this
harness and gas schedule land; the checked-in consensus profile remains 64M.

Qualification also requires a build manifest that binds the clean source commit
to the SHA-256 of `polystorechaind`, `libpolystore_core`, `polystore_gateway`,
`polystore_cli`, and `retrieval_inventory_exporter`. The harness recomputes every
value and fails the exact candidate before starting validators if the manifest is
missing, the product or harness checkout is dirty or moved from that commit, or
an artifact differs.

## Historical frontier

The exact four-validator run at `76d7ce549b422d9991011afbf567225e0454c034`
committed 6,656 one-opening, 1 KiB retrieval sessions in 104 same-provider
batches of 64. At 160M block gas, a 2 MiB byte limit, `GOMAXPROCS=4`, and a
one-second `timeout_commit`, it measured **188.35 sessions/s**, or **16.27
million sessions/day** by short-run extrapolation.

| Profile | Sessions/s | Derived/day | Commit p95 | FinalizeBlock p95 | Consensus |
| --- | ---: | ---: | ---: | ---: | --- |
| 160M gas, 1s | 188.35 | 16.27M | 1.434s | 602-621ms | round 0, no missed signatures |
| 160M gas, 500ms | 246.11 | 21.26M | 1.180s | 608-629ms | round 0, 6 missed signatures |
| 384M gas, 1s | 317.00 | 27.39M | 2.069s | 1.539-1.581s | round 0, 5 missed signatures |

This is a **batch-route diagnostic, not an activation qualification**. The
unbatched V3 proof route remains enabled and synchronously verifies each proof.
A global gas increase would also admit more of that slower workload. Its earlier
128M run missed validator signatures and exceeded the execution gate. Therefore
the checked-in profile remains 64M until either unbatched submissions are
disabled or a worst-case mixed batch/unbatched workload passes the same gates.

The gas step is discrete. Each 64-session batch requested about 37.44M gas.
The 160M profile admitted four batches per full block. The retained 384M
diagnostic admitted ten and reached 317.00 sessions/s, but execution took
1.54-1.58 seconds and five validator signatures were missed. Full blocks were
only 510 KiB, so the 2 MiB byte limit was not involved.

The host was not fully used: validators averaged 6.27 cores together at 160M
and 10.49 of 16 logical CPUs at 384M. The directly comparable four-worker pure
verifier ceiling is 873.75 one-sample sessions/s. Reaching that rate with the
current 37.44M-gas batch would require about fourteen batch transactions, roughly
524M requested block gas. Consensus health failed before that point, so gas
alone cannot safely close the gap. Cross-session native KZG aggregation is the
next measured optimization.

`results.json` retains the compact measurements and hashes of the full evidence
on `mikers@192.168.0.111`.

## Scope

These figures measure proof confirmation only. Frozen signed transactions were
submitted directly after setup, so file transfer, proof generation, session
opening, signing, owner acknowledgement, settlement recovery, expiry, and
refunds are outside the timed interval. Daily values are the short saturated
rate multiplied by 86,400; they are not a 24-hour soak result.

## Reproduce

Build the product binaries, native library, and proof exporter from the recorded
commit, then run from the repository root:

```sh
python3 scripts/retrieval_four_validator_workload.py \
  --mode native-v3-chain \
  --binary /path/to/polystorechaind \
  --library /path/to/libpolystore_core.so \
  --gateway-binary /path/to/polystore_gateway \
  --cli-binary /path/to/polystore_cli \
  --product-source "$PWD" \
  --proof-exporter /path/to/retrieval-inventory-exporter \
  --build-manifest /path/to/build-manifest.json \
  --home /path/to/new-run-directory \
  --chain-capacity-profile 1kib \
  --chain-capacity-sessions 7680 \
  --chain-proof-submission-mode batch-message \
  --chain-proof-batch-size 64 \
  --chain-proof-gas-adjustment 1.6 \
  --chain-max-gas 160000000 \
  --chain-timeout-commit-ms 1000 \
  --chain-validator-gomaxprocs 4 \
  --timeout 3600
```

The manifest has exactly this schema; hashes are lowercase SHA-256 hex:

```json
{
  "source_commit": "40-character Git commit",
  "artifacts": {
    "polystorechaind": "sha256",
    "libpolystore_core": "sha256",
    "polystore_gateway": "sha256",
    "polystore_cli": "sha256",
    "retrieval_inventory_exporter": "sha256"
  }
}
```

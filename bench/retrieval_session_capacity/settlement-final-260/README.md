# Settlement correctness evidence (#260)

Both runs passed at harness `01baa865c28d839b829aef40bac197d511500463` on
2026-09-08. Four validator processes shared one macOS host. These fixtures
exercise settlement and persistence, not provider transport or capacity.

Each run completed six K8/K2 sessions and 22 fresh openings. Escrows lost
392 stake, providers received 246, and 146 burned. Normal SDK issuance was
independently reconciled across all four validators: 657,503 stake during the
lifecycle workload and 2,331,147 during the adversarial workload. Later restart
intervals are separately retained in the issuance ledger and state snapshots.
The adversarial run committed five expected failures and four idempotent retries;
all preserved retrieval state. Signed transaction hashes, outcome codes and gas
matched on all four validators. Persistent restart preserved fixed-height state.

The JSON files retain public economic snapshots, mint event ledgers and committed
transaction evidence. Private node homes and full command journals stay in the
recorded local evidence locations; their SHA-256 hashes bind these extracts.
Product source matches `0bac7796` with no chain/core diff at the harness revision.
Binary, native library, setup and driver hashes are recorded in each JSON file.

Reproduction uses the existing nonconstant full-row fixtures and runtime binaries:

```sh
python3 scripts/retrieval_four_validator_workload.py --mode settlement-smoke \
  --binary "$RETRIEVAL_CHAIN_BINARY" --library "$RETRIEVAL_NATIVE_LIBRARY" \
  --fixture-k8 "$RETRIEVAL_FIXTURE_K8" --fixture-k2 "$RETRIEVAL_FIXTURE_K2" \
  --home "$RETRIEVAL_NEW_HOME" --timeout 600
```

Run sequentially with a different, nonexistent home and `--proof-only` for the
adversarial mode. Preserve each home on failure. The supplied binary/library must
match the reviewed product source and approved setup; the driver records hashes
but cannot establish build correspondence itself. The retained runs used a
768 MiB external disk floor and a 660-second external deadline. All owned
processes stopped after each run.

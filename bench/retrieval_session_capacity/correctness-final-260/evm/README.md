# Historical EVM boundary regressions

The same safe-behavior test overlay fails against original 50a5cb2 and passes against current 76653383. Both instantiate the real application and EVM; native calls use each revision's separately hashed Rust library. The original uses its own `go.mod` and cached upstream dependency source (`-mod=readonly`, `GOPROXY=off`), while current uses `scripts/chain_go.sh` and its maintained vendor patches. No fixed vendor was substituted into the original execution.

- Caught child REVERT: the parent succeeds and reports child failure. After EVM state commit, original retains the child's PendingProviderLink; current removes it.
- Insufficient child crypto gas: a nonconstant three-proof legacy batch receives 2,177,439 child gas, one below static plus the required 1,500,000 cryptographic budget. Original succeeds and fails the safe assertion; current returns child failure and preserves escrow/nonce. With 4,000,000 gas the control succeeds in both revisions and debits exactly three units with one nonce.

`all-red.log` contains the two intended original assertion failures and the passing sufficient-gas control (1.7 s). `current-green.log` contains all passing cases (1.6 s). `historical_test.go` adapts existing owning test helpers into one temporary overlay; both checkouts stay clean. These are actual local app/EVM executions, not a four-validator live transaction submission or a full reconstructed old deployment.

The first build (`rollback-red.log`) exhausted disk before tests and is retained as infrastructure failure, not behavioral evidence. After cached compilation and removing obsolete task artifacts, the bounded retry completed. `all-red-guard.py` records the exact original command and 600 MiB disk floor. Current command: GOMAXPROCS=2 GOFLAGS=-p=2 CGO_LDFLAGS=-L<CURRENT>/polystore_core/target/release DYLD_LIBRARY_PATH=<CURRENT>/polystore_core/target/release scripts/chain_go.sh test -overlay=<EVIDENCE>/current-overlay.json ./app -run 'TestHistorical(CaughtChildRollback|ChildCryptoGas)' -count=1 -timeout=90s -v.

The legacy batch deliberately isolates the cryptographic gas boundary; the current fresh-v2 session admission has separate owning tests. Completed temporary test archives were reclaimed only after retaining hashes, source and logs. `provenance.json` records revision, source, library, setup and evidence identity.

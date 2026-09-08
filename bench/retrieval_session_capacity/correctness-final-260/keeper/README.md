# Executed historical keeper counterexamples

At original commit `50a5cb2f999f5c455b8055a933eda941168e55fe`, all three safe
assertions compiled and failed during real keeper execution (`all-red.log`):

- A valid public proof submitted by an unrelated registered provider returned no error.
- Confirmation after removing the authenticated proof-provider pin returned no error.
- Zero-fee completion left the proof-provider pin present.

The temporary overlays append legacy-compatible assertions to the original owning
test files. They reuse real content/proof generation, native verification, keeper
messages and the existing tracked-bank fixture; product source is unchanged.
`overlay-all.json` pins the exact replacement test files. The first vendor-mode
attempt could not resolve the intentionally partial vendor directory and is not
counted as RED. The successful behavioral run uses cached module dependencies.

```sh
cd /Users/michaelseiler/dev/polynomialstore/polystore/polystorechain
GOMAXPROCS=2 GOFLAGS=-p=2 GOPROXY=off \
CGO_LDFLAGS=-L/Users/michaelseiler/dev/polynomialstore/polystore/polystore_core/target/release \
DYLD_LIBRARY_PATH=/Users/michaelseiler/dev/polynomialstore/polystore/polystore_core/target/release \
go test -mod=readonly -overlay=/tmp/polystore-254-execution/260-historical-keeper-counterexamples/overlay-all.json \
./x/polystorechain/keeper -run '^TestHistorical(RetrievalProofRequiresAuthorizedSigner|ConfirmationRequiresProofPayeePin|ZeroFeeCompletionRemovesPayeePin)$' -count=1 -timeout=120s -v
```

Current `76653383` passes the existing owning tests for copied proof rejection,
terminal missing-pin admission, deputy conservation and legacy/zero-fee quarantine
(`current-green.log`, 1.614 seconds). It was executed through `scripts/chain_go.sh`
with `GOMAXPROCS=2 GOFLAGS=-p=2`, the final native library path, and:

```sh
./scripts/chain_go.sh test ./x/polystorechain/keeper \
  -run 'TestRetrievalV2(TerminalAdmissionAndMissingPinFailClosed|LegacyLiabilityQuarantineAndZeroFeeMissingPin|DeputyConfirmFirstConservesFees|.*Copied.*|.*Signer.*)' \
  -count=1 -timeout=120s -v
```

The secured protocol uses versioned fresh sessions and quarantines unsupported
legacy sessions; this is an API-aware semantic comparison, not the same v2 test
compiled against a pre-v2 schema. This keeper evidence does not reconstruct the
original full EVM deployment. Source, overlay, native library, setup and log hashes
are retained in `provenance.json`. Baseline core source and native hash match the
recorded M1 baseline build; current native hash matches the final candidate.

## Additional migration and zero-fee checks

[`current-green-final.log`](current-green-final.log) records a separate passing
focused run (1.705 seconds) against the same frozen `76653383` runtime, with the
topic branch's `retrieval_migration_test.go` and
`retrieval_challenge_completion_test.go` supplied through a Go overlay. The earlier
`current-green.log` and historical RED identities above are unchanged.
[`migration-provenance.json`](migration-provenance.json) records the exact command,
runtime/dependency tree identities, test-source hashes, native/setup hashes and
copied [`migration-overlay.json`](migration-overlay.json).

The new regression covers 16 legacy liability cases: `OPEN`, `USER_CONFIRMED`, and
`PROOF_SUBMITTED` with or without a pin, each using explicit deal escrow,
unspecified legacy escrow, requester or protocol funding. Real legacy opens at
height 5 precede real `BeginBlock` activation at height 11. Activation and rejected
proof/confirmation calls preserve state and funding; cancellation at the original
expiry height 20 is rejected, and cancellation after expiry refunds only the
locked fee to its original source once, clears any pin, and creates no activity,
failure or evidence credit. Historical `COMPLETED` retries remain terminal.
Zero-fee completion now explicitly asserts pin removal. Existing absent,
malformed and wrong-provider pin checks also pass, including the separate
zero-fee missing-pin case.

Historical proof-submitted and completed records are **synthetic persisted-state
injections**, labeled in the tests. They do not claim historical proof transaction
execution. This is keeper correctness coverage, not delivery or capacity evidence.

The exact run used the original `/tmp/.../overlay.json` path recorded in provenance.
To repeat it on the recorded worktrees using the retained overlay instead:

```sh
cd /Users/michaelseiler/dev/polynomialstore/polystore-260-saturation
GOMAXPROCS=2 GOFLAGS=-p=2 \
CGO_LDFLAGS=-L/Users/michaelseiler/dev/polynomialstore/polystore-260-saturation/polystore_core/target/release \
DYLD_LIBRARY_PATH=/Users/michaelseiler/dev/polynomialstore/polystore-260-saturation/polystore_core/target/release \
./scripts/chain_go.sh test \
  -overlay=/Users/michaelseiler/dev/polynomialstore/polystore-260-final-report/bench/retrieval_session_capacity/correctness-final-260/keeper/migration-overlay.json \
  ./x/polystorechain/keeper \
  -run '^TestRetrievalV2(Migration.*|TerminalAdmissionAndMissingPinFailClosed|LegacyLiabilityQuarantineAndZeroFeeMissingPin|DeputyConfirmFirstConservesFees|RejectsCopiedProofBeforePayeePin)$' \
  -count=1 -timeout=120s -v
```

On another host, substitute both checkout paths in the command and overlay and
verify the test-source hashes first. The run used Go 1.25.5 on darwin/arm64, the
existing reconstructed vendor tree, and the default Go cache. The initial loader
failure is excluded from GREEN: restoring the ignored
`polystore_core/target/release/deps/libpolystore_core.dylib` symlink to
`../libpolystore_core.dylib` made the preserved library load without changing its
bytes.

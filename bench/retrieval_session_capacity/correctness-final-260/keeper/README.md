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

# Executed historical gateway counterexamples

These are behavioral RED/GREEN runs of exact selected production source, not full historical gateway/chain builds and not four-validator qualification. Both RED runs compiled and executed the safe assertion before failing. No daemon, keeper, native verifier or trusted setup was loaded; only the HTTP case used a local httptest server.

| Case | RED source and observed failure | GREEN source and observation | Logs |
|---|---|---|---|
| HTTP200 malformed committed query | 76c8653a225a737bf6e4ef6b1c75272efff05716 exact tx_submit.go: HTTP200 `{}` returned the broadcast hash with nil error | First fix 89aa18debc07544f08df44b6d0db285d1276bb4c, same submitTxAndWait assertion: error `transaction outcome unknown: invalid tx_response: expected JSON object` | http-red.log, http-green.log |
| Corrupt durable legacy proof JSON | 76c8653 exact store/load functions: append succeeded, unreadable data became readable, and `[{"mdu_index":` was overwritten with `[{"mdu_index":1,"blob_index":64}]` | Current 76653383b04fbd8c971cc4839f831ca0bf15ca2c exact store/load/decode functions reject append, reject load, and preserve the original corrupt bytes | durable-red.log, durable-green.log |

Each directory uses the same semantic assertion on its RED and GREEN side. HTTP adapts owning TestSubmitTxRequiresMatchingCommittedResponse to the old submitTxAndWait API and stubs only successful CLI broadcast; JSON parsing and committed query run through the original implementation. This paired GREEN qualifies the first fix, not the entire latest submission state machine. Current owning package validation is separately retained in ../257-submission-strict.log and ../257-submission-full.log.

Durable adapts TestLegacyProofCorruptionAndTupleIdentity with real bbolt temporary storage and real cached chain types. It changes fatal assertions to nonfatal assertions to expose all three unsafe consequences. Only the corrupt-JSON subcase is reproduced, not tuple identity or every malformed record. The ChainedProof declaration hash is identical on original/current revisions, as retained in provenance.json; dependency modules are current cached modules, not a reconstructed historical dependency closure.

Reproduce each directory via: GOMAXPROCS=2 GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off go test -p 2 -count=1 -timeout 30s -v .

prepare.py and prepare_durable.py retain exact extraction/adaptation commands; source-identities.json and durable-source-identities.json retain source commit/blob/SHA identities. provenance.json retains Go executable/version/hash, ChainedProof declaration identities and file SHA256s. Per-phase result JSON retains command, exit status, guard result, duration, and disk readings. All four phases completed in 1.5–6.1 seconds each with no guard stop. Evidence occupies approximately 324 KiB; no full legacy chain build occurred. Shared-host free-space movement is not attributed solely to this task.

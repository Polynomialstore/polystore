# Historical correctness counterexamples

These retained assertions require safe behavior. Original implementations fail them; corrected implementations pass. This evidence is independent of candidate/baseline timing agreement and four validators agreeing with each other. Raw initial build failures are explicitly excluded from behavioral results.

| Boundary | Original observation | Corrected outcome | Scope and raw evidence |
| --- | --- | --- | --- |
| Proof submitter authority | Valid copied proof accepted from unrelated registered provider | Rejected before payee pin | [Keeper](keeper/README.md), original legacy API versus current owning v2 tests |
| Missing proof payee pin | Confirmation accepted without pin | Fail closed | [Keeper](keeper/README.md) |
| Zero-fee completion | Terminal pin retained | Pin removed | [Keeper](keeper/README.md) |
| Exact Merkle membership | Surplus sibling accepted, valid control accepted | Surplus rejected, control accepted | [Native](native/README.md), same C ABI assertion |
| Whole setup identity | Changed unconsumed trailer accepted | Initialization rejected | [Native](native/README.md), separate processes |
| Setup reinitialization | Missing second requested file accepted after initial success | Reinitialization rejected | [Native](native/README.md) |
| Caught EVM child REVERT | Successful parent retains child SDK write | Child write rolled back | [EVM](evm/README.md), real app and original dependencies |
| Child cryptographic gas | Three-proof child succeeds with 2,177,439 gas | Child fails; escrow and nonce unchanged | [EVM](evm/README.md); sufficient 4,000,000-gas control succeeds in both |
| Transaction query | HTTP 200 `{}` accepted as success | Unknown/malformed result rejected | [Gateway](gateway/README.md), selected production query source |
| Durable proof state | Corrupt JSON overwritten on append | Read/append reject and preserve bytes | [Gateway](gateway/README.md), selected source with real Bolt storage |

Each group retains source/commands, logs, fixture and available source/library/setup identities. `retained-files.json` authenticates the copied evidence files. Absolute paths in original commands identify the actual local run; substitute local checkout/evidence paths for reproduction. The native probe reads its adjacent fixture and regenerates the deliberately changed setup file. Original setup/native and current native hashes are distinct and pinned; no current patched EVM vendor was linked into the original run.

The original keeper tests adapt the safe requirement to the original legacy message schema. Current keeper outcomes use the owning v2 tests rather than pretending that v2 existed historically. Gateway comparisons isolate selected production functions and explicitly document their broadcast stub and dependency boundaries. EVM comparisons are local app executions, not live four-validator transaction submissions. None of these tests establishes fresh data delivery, unbiased permissionless randomness, economic scalability or WAN performance.

The first original EVM compilation exhausted local storage before tests. After reclaiming obsolete task artifacts, the guarded retry completed and produced the retained behavioral failures; it is the retry, not the failed compilation, that supports the EVM rows. Completed task build caches were reclaimed after recording their identities; raw logs and source remain.

# Native K8 pilot 002

This is the retained result of one bounded path and gas diagnostic for
[issue #290](https://github.com/Polynomialstore/polystore/issues/290). It is not
a capacity qualification. The five offered-rate steps lasted four seconds each,
and the run used four validator processes plus twelve provider-daemons on one
nonquiet Apple workstation.

The run opened 39 sessions in one atomic preparation transaction. Its 400,000
gas allowance per message produced 15,600,000 gas wanted and 14,924,033 gas
used. Eight warmup and 31 measured `MsgSubmitRetrievalSessionProof`
transactions committed successfully. Each K8 transaction carried eight chained
openings, for 64 warmup and 248 measured openings. Every one of the twelve
assignments received at least two committed-valid bundles, and the final normal
audit observation recorded 12 accepted samples for 12 finalized assignments.

The 31 measured bundles committed over the 20-second offered window plus a
3.714-second drain. That eventual rate and the aggregate result do not establish
that any offered step was sustainable. The approximately 416-second wall time
also includes setup, proof preparation, warmup, audit observation, and cleanup;
it is not a throughput denominator.

Proof transactions declared a 20,000,000 gas ceiling while using
4,131,357–4,134,092 gas. With the retained 64,000,000 block gas limit and the
SDK default proposal selection used by this app, the declaration allows at most
three proof transactions per proposal: a fourth declaration would exceed the
block limit. This declared-gas packing constraint applies even though execution
used much less gas. The pilot therefore does not provide a capacity result. A
sustained run must first select and document a measured K8 safety margin without
changing proof checks, audits, or block limits.

The [summary](summary.json), [execution plan](plan.json), and
[runtime provenance](runtime-provenance.json) are the only published run files.
The [manifest](manifest.json) records their original hashes, published hashes,
path substitutions, and the private files intentionally excluded. The source
run home, keyrings, SQLite journals, raw evidence, provider and validator logs,
payload, proof inventory, and private driver log remain local.

The plan uses `$SOURCE_CHECKOUT`, `$REUSED_CORE_RELEASE`, and `$ARTIFACT_ROOT`
in place of machine-specific absolute paths. Runtime provenance replaces the
local hostname with `<redacted-host>`. These substitutions remove local identity
and layout details while retaining exact commits, Git objects, component hashes,
commands, gas settings, workload geometry, and toolchain versions.

# Delivery and setup qualification evidence

The [qualification report](../../../performance/retrieval-v2-qualification.md) separates proof validity, delivery, authority, sampling and capacity claims.

## Small live delivery

[Run 34271587678](https://github.com/Polynomialstore/polystore/actions/runs/34271587678), commit `1a10ea5cb5287717bcb1681e21bae2360aee34bf`, passed the existing `E2E Mode2 Stripe (Fast 3 SPs)` job. PR #284 merged as `5cffe345` after all 28 checks and clean current-head Codex review. The separate Multi-SP gateway job passed an isolated unchanged-head retry after its first attempt stalled without retained logs; that cause remains unknown. [Run identity](small-run.json) records artifact 10074685795 and its GitHub-reported archive digest. The two JSON files are unchanged copies from that artifact:

- [1 KiB](1kib.json): user-gateway, explicitly authorized deputy, and direct provider; three distinct completed one-blob sessions with matching file hashes.
- [160 KiB](160kib.json): user-gateway and explicit deputy; each retrieval covers two encoded blobs across two slots, for four distinct completed sessions.

All seven sessions record 17 stake locked, 16 paid to the authorized payee and 1 burned. The harness verifies a successful committed transaction, its signer/session, frozen payee/root, terminal state and exact module bank transfer. Balance observations are supporting evidence; normal issuance remains enabled. Both cases retain an HTTP 400 rejection of a requested window that differs from the frozen session.

These successful downloads establish neither sustained delivery throughput nor a network corruption test. Per-window verify/write/flush-before-ACK ordering and failure behavior have separate owning tests. The final whole-file hash here is checked after retrieval. The source-tree and harness hashes match the exact checkout; running executable, native-library and WASM binary hashes were not recorded.

After installing the toolchain, native library and browser dependencies specified in `.github/workflows/ci.yml`, reproduce from a fresh checkout of that exact commit on Linux:

```bash
LD_LIBRARY_PATH="$PWD/polystore_core/target/release:${LD_LIBRARY_PATH:-}" \
E2E_MODE2_FAST=1 PLAYWRIGHT_SKIP_INSTALL=1 PROVIDER_COUNT=3 \
E2E_MODE2_GREP='mode2 deal' scripts/e2e_mode2_stripe_multi_sp.sh
```

Do not reuse operator chain homes or substitute the synthetic keeper workload for these browser downloads.

## Setup startup

[Startup log](setup-startup.log) and [provenance](setup-startup-provenance.json) retain 22 fresh-process checks: 19 admission checks and help/version/query without setup. The approved setup reaches an intentionally invalid pruning option; this establishes setup admission, not validator readiness or proof execution. The separate [native multi-message smoke](../native-multimessage-e259d573/README.md) executes valid proofs against a running node.

The provenance gives the source, chain/native hashes and reproduction command. Original absolute paths identify the actual local environment; substitute paths to the pinned artifacts when reproducing.

## Large live delivery

[Run 34281520872](https://github.com/Polynomialstore/polystore/actions/runs/34281520872), head `9c0110463dc92838a06b7acc88689d636b2efd11`, completed successfully. The [lossless summary](large-persistent-success.json.gz) records 1,073,741,824 bytes with SHA-256 `5806efdf1f91fa2b8ab62f7b5e16541c0f866227cfe977238bd2ec9789664d9e`, 1,064 distinct sessions, 8,457 blobs and 133 user MDUs through the user-gateway. The exact harness asserts canonical COMPLETED state and pinned root/deal for every session. Normal storage audits were enabled; the fresh persistent profile and full OPFS preflight ran before retrieval.

Upload took 546,308 ms; retrieval through final downloaded-byte hash took 9,475,070 ms (2h 37m 55s), approximately 110.67 KiB/s over that interval. Terminal census follows that timer. This is large-file correctness evidence, and exceeds the new 30-minute retrieval execution guardrail by 5.26 times. It does not qualify acceptable delivery performance or the subsequent instrumentation. Earlier interrupted attempts remain separate diagnostics.

[Run/source identity](large-persistent-success-run.json) records verified source/harness hashes, original-summary hash and the independently checked artifact archive digest. Runtime executable/native/WASM hashes were not recorded for this run. Phase measurements and the small-first performance gate remain pending in #260. The large artifact records terminal sessions, not independent per-session payout transfers; exact transfer evidence belongs to the small-route and settlement bundles. Provider logs include signer/capacity contention, so enabled audits are not a claim of zero audit failures.

## Retained-file integrity

From the repository root:

```bash
python3 - <<'PY'
from pathlib import Path
import hashlib, json
root = Path('bench/retrieval_session_capacity/delivery-final-260')
for name, expected in json.loads((root / 'retained-files.json').read_text()).items():
    assert hashlib.sha256((root / name).read_bytes()).hexdigest() == expected, name
print('PASS: retained-file hashes')
PY
```

## Large-file incomplete attempt

[Run34267852521](https://github.com/Polynomialstore/polystore/actions/runs/34267852521) failed with a Chromium no-space output write after 904 proof requests and 905 window requests. [Raw summary](large-incognito-failed.json.gz) preserves the original JSON losslessly; [run/source identity](large-incognito-failed-run.json) records its hash and artifact identity. There is no completed-file hash or terminal-session census, so these counts are not completed delivery.

[PR #288](https://github.com/Polynomialstore/polystore/pull/288) shares the existing disk-backed browser setup with the streamed test and runs a complete 1 GiB OPFS write/flush/hash preflight before funding. The failed run used Playwright's default incognito context; archived evidence does not distinguish which browser storage limit was reached. The replacement run completed successfully as recorded above; its latency remains outside the new execution budget.

## Instrumented 15.5 MiB baseline

[Run 34296651542](https://github.com/Polynomialstore/polystore/actions/runs/34296651542) at merged `5b1d77d1` passed: 16,252,928 logical bytes, matching SHA-256, 16 distinct COMPLETED sessions, 128 blobs, and normal storage audits enabled. The [lossless summary](small-instrumented.json.gz) retains actual executable/served-asset hashes and Node/browser versions; native hashes identify available link candidates, not a loaded-image attestation. [Run identity](small-instrumented-run.json) pins source/harness and the locally verified archive digest. Sanitized [provider timings](small-instrumented-provider-timings.log) exclude authentication headers and raw transaction output.

Retrieval through final hash took 143,874.596 ms (110.32 KiB/s); upload took 14,690.976 ms. Full uniquely verified output was written at 128,493.174 ms after retrieval start. Final hash took 104.175 ms and terminal census 478.741 ms. Heartbeat evidence showed advancing verified bytes before ACK; the final census confirms all 16 sessions.

[Phase analysis](small-instrumented-phases.json): browser verification 61,051.795 ms; window transport including provider response work 18,492.490 ms; challenge readiness 19,658.390 ms; open transaction 8,885.270 ms; ACK plus provider settlement 30,142.815 ms, including owner ACK 11,195.835 ms. Decode/write plus flush totaled 276.085 ms. Nested/overlapping durations must not be added. These are wall times, not CPU samples. Browser verification is the largest measured phase; output-copy optimization cannot materially improve this baseline.

At the observed aggregate rate, 1 GiB projects to about 158.4 minutes, consistent with the earlier 157.9-minute actual run. This projection is not new large-file evidence. Intermediate and large reruns remain blocked while the measured bottleneck is profiled and corrected; the 30-minute guardrail is not waived.

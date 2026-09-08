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

Pending the complete hosted 1 GiB result. Earlier interrupted runs are diagnostic evidence and are not substituted for a completed download.

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

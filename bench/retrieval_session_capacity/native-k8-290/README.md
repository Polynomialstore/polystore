# Native K8 sustained-harness milestone (#290)

This milestone extends the existing four-validator sustained harness to create a
native `General:rs=8+4` deal and eight-opening full-row submission bundles. It
contains no new measurement and makes no K8 capacity claim. The default remains
the retained K2 path.

## Geometry and units

The selectable profiles share the scheduler, transaction lifecycle, proof
exporter, finite 64M gas / 2 MiB block limits, and five offered transaction rates
of 0.25, 0.5, 1, 2, and 4 per second. Their storage and submission geometry is
different:

| Profile | Active storage assignments and provider-daemons | Deputy submitters | Openings in one submission transaction | Normal audit work | C6 audit work |
| --- | ---: | --- | ---: | ---: | ---: |
| K2 | 3 (`provider0`..`provider2`) | `provider3`..`provider10` | 32 | 3 samples/epoch | 96 samples/epoch |
| K8 | 12 (`provider0`..`provider11`) | `provider12`..`provider19` | 8 | 12 samples/epoch | 96 samples/epoch |

Storage providers run normal provider-daemon audit signing, while deputies own no
storage slots. The sets are disjoint to prevent SDK account-sequence collisions.
K8 consequently runs twelve provider-daemons instead of three and competes for
host CPU and memory under a different normal-audit workload. Validator CPU/peak
RSS and Commit metrics remain captured by the existing instrumentation; provider
daemon CPU/RSS is not separately sampled. A K8/K2 comparison must report this
topology difference and cannot be described as an equal-semantics speedup.

One offered or committed **bundle** means one
`MsgSubmitRetrievalSessionProof` transaction for one session. One K2 bundle holds
32 individual chained openings; one K8 bundle holds eight. The evidence profile
records offered bundles/s, derived offered openings/s, bundle/opening counts,
declared gas limit per bundle and per opening, and the observed bundle-size
distribution. Capacity analysis must derive committed bundles/s and openings/s
from committed valid transaction outcomes. CheckTx acceptance, offered work, or
a later state observation are not commit counts. Committed gas used must be reported
separately from the declared gas limit.

Both profiles submit full-row bundles round-robin across every active assignment.
Each operation binds the assigned provider, that provider's artifact directory,
the snapshot slot, and global `start_blob_index = slot * (64 / K)`. The retained
report records offered, submitted, and committed-valid bundle and opening counts
for every assignment. These mechanics allow a later many-provider measurement;
this unmeasured milestone itself establishes no throughput.

## Bounded higher-load profile

The default remains eight deputies and the original 0.25, 0.5, 1, 2, and 4
bundle/s steps. Two bounded controls select the next chain-knee experiment:
`--sustained-deputies` accepts 8 or 32, and `--sustained-rate-scale` accepts 1
or 4. The scale-4 profile therefore offers 1, 2, 4, 8, and 16 bundles/s. It
uses 32 independent deputies with one active transaction per signer while
retaining the 128-entry queue. For K8, assignment signers remain
`provider0`..`provider11`; deputies become `provider12`..`provider43`, and all
44 provider identities are funded and provisioned before node start.

The harness warms up every selected deputy once. A four-second scale-4 pilot
therefore prepares 32 warmups plus 124 measured sessions (156 total); a full
180-second run would prepare 5,612 sessions. The selected rates, signer sets,
session counts, concurrency, and opening denominators are written into the
profile before submission. Start with the bounded four-second path after the
harness is reviewed and landed:

```sh
python3 scripts/retrieval_four_validator_workload.py \
  --mode sustained-providers \
  --sustained-k 8 \
  --sustained-rate-scale 4 \
  --sustained-deputies 32 \
  --step-seconds 4 \
  --proof-gas 5000000 \
  ...
```

The high-load profile retains the explicit 5M K8 proof limit selected after the
bounded pilot. It does not change the 64M gas or 2 MiB block limits, normal
audit load, proof message shape, or one-session-per-transaction semantics.

## Candidate pilot after review

Retained performance collection must wait until this harness/schema has focused
review and lands. After landing, freeze the product runtime and harness to exact
commits and component hashes before collection; any relevant product or harness
change requires another review, freeze, and collection.

Before starting a new home, verify free space, the 600-second total budget, fixed
ports, and exact source/binary hashes. K8 setup starts twelve provider-daemons and
may not fit 600 seconds; a timeout is a failed pilot with retained diagnostics,
not permission to extend the deadline.

The first same-path command adds `--sustained-k 8` to the existing harness. The
20M gas value below is the retained K2 safety ceiling for a path-validation pilot
only. It is not a measured K8 gas requirement and the pilot is not capacity
evidence:

```sh
df -h /tmp
python3 scripts/retrieval_four_validator_workload.py \
  --mode sustained-providers --audit-profile normal --sustained-k 8 \
  --binary "$RETRIEVAL_BIN/polystorechaind" \
  --library "$RETRIEVAL_LIBRARY" \
  --gateway-binary "$RETRIEVAL_BIN/polystore_gateway" \
  --cli-binary "$RETRIEVAL_REPO/polystore_cli/target/release/polystore_cli" \
  --product-source "$RETRIEVAL_REPO" \
  --proof-exporter "$RETRIEVAL_BIN/retrieval-exporter.test" \
  --proof-gas 20000000 --step-seconds 4 --timeout 600 \
  --home /tmp/polystore-k8-290-pilot-001 \
  > /tmp/polystore-k8-290-pilot-001.log 2>&1
```

Inspect actual committed K8 gas used from the pilot, then select and document a
safety margin for a sustained K8 run. Do not reuse the K2 limit as a K8 capacity
denominator, lower proof checks or audits, or raise block limits to obtain a
larger number.

The [retained pilot 002 artifact](pilot-002/README.md) records one successful
four-second-per-step path and gas diagnostic across all twelve assignments. It
is not capacity evidence; its 20M declared proof gas limited proposal packing to
at most three proof transactions under the unchanged 64M block limit even though
each transaction used about 4.13M gas.

The [retained sustained 001 diagnostic](sustained-001/README.md) uses the measured
5M proof-gas ceiling and 60-second steps. All 465 measured K8 bundles eventually
committed with normal audits, and the final 4 bundles/s step reached the configured
offered ceiling without filling the queue or block gas. This is a workload-limited
local lower bound, not a chain-saturation or deployment-capacity result. Issue
#290 remains open for a higher offered workload and realistic deployment evidence.

The existing absolute phase and overall deadlines, bounded queue, signer
quarantine, port reservations, and process-group cleanup remain unchanged. The
scheduler writes a progress record every 60 seconds while active, plus its final
state, using only its in-memory counters. It reports completed and committed-valid
submissions, latest committed height, pending and in-flight work, and time since
progress. A 600-second no-progress watchdog aborts pending scheduler work; the
overall deadline remains the shorter authority. Setup and the single bounded
exporter subprocess remain visible through their existing phase and log artifacts;
they do not yet emit periodic heartbeat records or make extra LCD queries.

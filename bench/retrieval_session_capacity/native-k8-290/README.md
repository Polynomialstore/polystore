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

The [Linux high-load diagnostic 002](linux-highload-30s-002/README.md) reconciles 842 successful K8
proof-submission transactions (6,736 openings) with normal audits. At the final
16/s offered step, 88 offers hit the bounded queue; its consensus-header-time
window recorded 8.8 bundles/s. This is a single-host, 30-second-per-step result,
not a production-capacity or byte-delivery qualification.

## Native v3 production-route pilot

The fixed `native-v3-providers` mode is a finite same-path diagnostic for the
sampled large-session protocol. It uploads exactly 16 MiB through FAT v3,
admits the generation through all twelve provider HTTP routes, opens two native
sessions with U=133 and Q=132, and asks the eight systematic providers to submit
one provider-batched proof transaction for each session. It records the sixteen
committed transaction messages and gas, 264 newly accepted bitmap ordinals,
normal audits, and expiry/refund cleanup. It never sends an owner ACK because it
does not download and verify the file bytes. HTTP duration combines proof
generation, local verification, gas simulation, signing, broadcast, and commit
observation; it is neither pure proof-generation time nor chain capacity.

A bounded pre-merge correctness smoke may run from an exact independently
reviewed head with separately frozen Linux runtime hashes and a new private
home. It is not retained performance evidence. Retained performance collection
requires the harness to be reviewed and landed:

```sh
python3 scripts/retrieval_four_validator_workload.py \
  --mode native-v3-providers --audit-profile normal --timeout 600 \
  --binary "$RETRIEVAL_BIN/polystorechaind" \
  --library "$RETRIEVAL_LIBRARY" \
  --gateway-binary "$RETRIEVAL_BIN/polystore_gateway" \
  --cli-binary "$RETRIEVAL_BIN/polystore_cli" \
  --product-source "$RETRIEVAL_REPO" \
  --home "$RETRIEVAL_RUNS/native-v3-16m-pilot-001"
```

The pilot keeps v3 disabled by default and enables it only in its isolated test
genesis. A retained result can establish production-route correctness and a
bounded offered/committed diagnostic. A longer reviewed profile is required
before quoting stable throughput, and delivered-file performance remains a
separate measurement.

## Native v3 provider-route cross-audit diagnostic

`native-v3-providers-cross-audit` extends the same production provider route
without changing proof, gas, queue, or audit behavior. It opens sixteen fixed
16 MiB sessions. One transaction per systematic provider warms the route
outside the clock, then 120 transactions are offered round-robin across the
eight assigned signers at 2 transactions/s for 60 seconds. Each signer has at
most one request in flight. The HTTP clock includes proof generation, native
verification, gas simulation, signing, broadcast, and commit observation.

The run aligns its measured start 30 blocks before the next normal audit anchor
and requires the profile to cross exactly that one anchor. It retains the actual
offered, queued, completed, and failed request counts, so backlog or a bounded
route failure remains diagnostic evidence rather than being relabeled as a
successful 2 transactions/s result. A successful run additionally verifies all
128 warmup and measured proof transactions, all 2,112 accepted ordinals, the
crossed audit coverage and its unique transactions, provider account sequences,
raw blocks/results on all four validators, Linux validator CPU ticks, and all
sixteen expiry/refund paths. It does not send an ACK or verify delivery.

```sh
python3 scripts/retrieval_four_validator_workload.py \
  --mode native-v3-providers-cross-audit --audit-profile normal --timeout 900 \
  --binary "$RETRIEVAL_BIN/polystorechaind" \
  --library "$RETRIEVAL_LIBRARY" \
  --gateway-binary "$RETRIEVAL_BIN/polystore_gateway" \
  --cli-binary "$RETRIEVAL_BIN/polystore_cli" \
  --product-source "$RETRIEVAL_REPO" \
  --home "$RETRIEVAL_RUNS/native-v3-provider-cross-audit-001"
```

This is a finite local constant-offer diagnostic. It does not establish a
sustained operating point across multiple epochs, WAN behavior, phase RSS peak,
or delivered-byte capacity. A retained performance result requires this harness
to land before collection.

## Native v3 chain-only diagnostic

`native-v3-chain` keeps the same 16 MiB FAT v3 generation and normal audits,
then opens eight sessions. Eight bounded exporter processes prepare and natively
verify the 64 provider messages before measurement. The CLI simulates each exact
message with `--generate-only --gas auto --gas-adjustment 1.6`; the measured
submissions use those explicit gas limits, so proof generation and gas
simulation are outside the clock. One warmup per systematic provider precedes
56 transactions offered for eight seconds each at 1, 2, and 4 tx/s.

The run requires complete current-epoch audit coverage, two blocks of signer
sequence quiescence, and 60-block margins to the next audit anchor and session
expiry. It retains exact blocks/results from all four validators, authoritative
session bitmaps, signer sequences, gas, and Linux validator CPU ticks for the
measured scheduler window. It sends no ACK and checks expiry/refund. The result
is a finite local chain diagnostic; it does not qualify delivery, WAN behavior,
steady-state capacity, or a phase RSS peak. Pre-merge runs are correctness
smokes. Performance evidence is retained only from the reviewed landed harness.

```sh
python3 scripts/retrieval_four_validator_workload.py \
  --mode native-v3-chain --audit-profile normal --timeout 600 \
  --binary "$RETRIEVAL_BIN/polystorechaind" \
  --library "$RETRIEVAL_LIBRARY" \
  --gateway-binary "$RETRIEVAL_BIN/polystore_gateway" \
  --cli-binary "$RETRIEVAL_BIN/polystore_cli" \
  --proof-exporter "$RETRIEVAL_BIN/polystore_gateway.test" \
  --product-source "$RETRIEVAL_REPO" \
  --home "$RETRIEVAL_RUNS/native-v3-chain-001"
```

# PolyFS DA System Fit

Last updated: 2026-06-26

Status: strategy and research note, not a protocol RFC.

## Thesis

PolyStore should not position the current protocol as a finished Celestia-style
consensus DA layer. The current system is a storage and retrieval protocol with
committed PolyFS generations, erasure-coded slot storage, provider
accountability, paid retrieval sessions, and synthetic liveness.

That said, PolyFS is unusually well-positioned as the substrate for a credible
DA research track. The right wedge is not "generic DA, but later." The right
wedge is:

**DA lanes on top of PolyStore: append-only publication streams that produce
availability certificates and then remain paid, repairable, and retrievable.**

The important distinction is publication-time availability. Historical archive
retrieval answers "can I get old DA data later?" A DA system answers "was the
new data made available widely enough before downstream systems accepted the
commitment?" PolyStore already has many pieces of the second answer, but it
needs explicit data-lane, batching, certificate, and sampling semantics.

## Boundary With Historical Archive Retrieval

The companion note
`docs/notes/HISTORICAL_DA_ARCHIVAL_RETRIEVAL_MARKET.md` covers the near-term
market where DA data has already been published elsewhere and PolyStore stores
it for durable retrieval.

This note covers a different product and research question:

- Can PolyStore itself publish data with a DA-like availability guarantee?
- Can a rollup, appchain, indexer, or sequencer rely on a PolyStore certificate
  before accepting a batch?
- What protocol additions are needed for light clients, provers, and external
  systems to verify that data was available, not merely archived?

The answer is "plausibly yes, with modest architecture extensions and a serious
DAS research track." It is not "yes, current storage deals already equal DA."

## Market Context

DA is now a named, funded, and technically sophisticated category. Celestia,
Ethereum PeerDAS, Avail, and EigenDA all converge around the same core idea:
erasure-code data, commit to the coded or source data, let many participants
sample or attest to availability, and allow downstream execution layers to rely
on the result.

The market is not asking only for cheap bytes. It is buying assurances:

- the data behind a batch was actually published;
- withholding is detectable or economically costly;
- light clients or validators do not need to download the whole batch;
- there is an external commitment/certificate that a rollup can reference; and
- the data can be recovered by enough honest participants during the relevant
  window.

This means a PolyStore DA product cannot lead with "we store data." It has to
lead with "we certify availability and keep retrieval accountable after
publication."

The competitor context is useful:

- **Celestia** is the clean mental model for DAS: a DA chain orders blobs, uses
  erasure coding, and lets light nodes sample shares with proofs. Its NMT model
  also matters because applications need namespace-scoped data, not just one
  global blob stream.
- **Ethereum PeerDAS** is the most important industry validation that sampling
  and partial custody are becoming mainstream. PeerDAS is explicitly about
  increasing blob capacity while reducing per-node storage and download
  requirements.
- **EigenDA** validates a different architecture: specialized dispersers,
  validators, retrieval nodes, erasure-coded shards, KZG proofs, aggregated
  attestations, and stake-weighted security. This is closer to the direction
  PolyStore could study if it wants availability certificates without becoming
  a full consensus DA chain.
- **Avail** reinforces the same primitive set: erasure coding, KZG commitments,
  DAS, and consensus attestations.

The product lesson is that DA buyers compare security models, integration
surface, latency, throughput, and economics. PolyStore's differentiated asset is
not that it also has erasure coding. It is that it already treats retrieval,
repair, public reads, and paid service as protocol-native surfaces.

## What PolyStore Already Has

Current PolyStore is not starting from zero. Several existing primitives map
directly onto DA needs.

### PolyFS generations

Every committed state has a pinned root and CAS mutation guard. DA publication
also needs immutable roots, conflict handling, and a way to reject stale writers.
The current generation model is a strong base for append-only batch roots.

### KZG-aligned blob atoms

The protocol uses 128 KiB blobs and 8 MiB MDUs, aligned with the EIP-4844 blob
size. That matters because the industry has already standardized tooling and
hardware attention around KZG blob commitments.

### RS striping and accountable slots

Mode 2 / StripeReplica already stores user data as Reed-Solomon-coded shard
blobs across an ordered provider slot map. This gives us the beginning of a
DA-style custody model: named providers are responsible for named coordinates.

### Replicated metadata and witness MDUs

MDU #0 and witness MDUs are replicated so any assigned provider can resolve
paths and produce proof material without contacting all other providers. This is
a useful base for sampling because a sample request needs self-contained proof
metadata, not a trusted gateway index.

### Chained proofs

PolyStore's proof path links a pinned PolyFS root to an MDU/root-table opening,
a blob commitment, and a KZG byte opening. A DA sampling proof needs essentially
the same kind of coordinate-to-commitment-to-data path.

### Mandatory retrieval sessions

PolyStore already has session objects that pin deal, root, provider/slot, byte
range, payer, nonce, and expiry. This is rare and valuable. Most DA designs
treat retrieval as an operational follow-on. PolyStore can make every sample,
read, repair, and user fetch an accountable service event.

### Public and sponsored retrieval

Public deals and sponsored retrievals are directly relevant. A DA lane should
not require the original publisher to pay for every later verification request.
Anyone should be able to pay for a sample, proof, or full retrieval if the lane
is public.

### Synthetic retrieval and quotas

PolyStore already has the idea that protocol-funded retrievals can substitute
for organic reads when data is cold. DA sampling can reuse this shape: the
protocol can open sample sessions against recent batches and convert success or
failure into provider health, payout, or negative evidence.

### Repair and provider rotation

DA systems usually focus on the publication window. PolyStore can distinguish
itself by keeping certified data repairable and economically retrievable after
that initial window.

## What Full DA Requires That PolyStore Does Not Yet Claim

The gap is not mainly cryptographic atoms. The gap is the semantics around when
a root is accepted and what the network is proving at that moment.

### Publication-time availability

Current PolyStore can prove bytes under a committed root and can later test
provider service. A DA system needs confidence before or during publication:
the data behind a batch root was dispersed widely enough that downstream users
can safely rely on it.

### Sampling security, not one-range service

Current retrieval sessions are range-scoped. A successful read of one range is
not a blanket claim about the entire batch. DAS needs a probability model: if a
publisher withholds too much data, random samples should fail with high
probability.

### External batch ordering

Storage deals are mutable containers. DA lanes need ordered append-only batches
because rollups and appchains reason about sequence. The latest root matters,
but every prior batch root also remains an externally referenced object.

### Multi-writer admission

Current content updates are owner-mediated generation swaps. A public DA lane
needs writer policy: any payer, allowlisted sequencers, threshold signers, or a
lane-specific sequencer/batcher.

### Availability certificates

DA consumers do not want to inspect PolyStore internals every time. They want a
compact object that says: this batch root, this erasure profile, this provider
set, this challenge/attestation policy, this result, at this height.

### Light client proof surface

A DA light client should sample by coordinate and verify a proof against the
published batch commitment. Today PolyStore proofs are good retrieval proofs,
but the lane-level commitment and sample-coordinate grammar need to be explicit.

### Encoding correctness

If a malicious publisher or gateway produces bad erasure-coded data, samples may
not imply recoverability. A full DAS research track must decide how PolyStore
proves or attests encoding correctness: fraud proofs, validity proofs,
deterministic re-encoding by providers, KZG homomorphism checks, or an
EigenDA-like disperser/prover role.

## Recommended Product Shape: PolyStore DA Lanes

The best product abstraction is a **DA lane**, not a generic filesystem deal.

A DA lane is an append-only public or permissioned publication stream backed by
one or more PolyStore deals. It produces a sequence of certified batches:

```text
lane_id
  batch 0 -> batch_data_root, polyfs_root, availability_certificate
  batch 1 -> batch_data_root, polyfs_root, availability_certificate
  batch 2 -> batch_data_root, polyfs_root, availability_certificate
  ...
```

Each batch has:

- a lane-local sequence number;
- publisher identity and admission proof;
- raw data length and namespace/application metadata;
- erasure profile and encoding version;
- batch data root;
- PolyFS root or segment root where the data is stored;
- provider slot set and custody map;
- certificate status;
- retention policy and retrieval funding policy; and
- external metadata for rollups, bridges, or settlement contracts.

This gives PolyStore a clean product:

**Publish batches to a PolyStore DA lane. Receive an availability certificate.
Keep the batch retrievable under paid, provable, repairable semantics.**

## Availability Certificate Lifecycle

A plausible certificate flow:

1. **Reserve lane capacity**
   - The lane has a backing deal, price policy, provider slot set, and
     append-only writer policy.
   - Capacity can be prepaid, pay-per-batch, or sponsored.

2. **Stage batch data**
   - A publisher, user-gateway, or disperser encodes the batch into the
     lane's erasure profile.
   - Shards are pushed to the assigned provider-daemons.
   - MDU #0 / witness data or lane index segments are staged with the data.

3. **Commit data root**
   - The publisher submits `MsgPublishDABatch` with previous lane root, batch
     metadata, size, encoding profile, source commitment, and fee.
   - The transaction creates a pending batch, not yet a final certificate.

4. **Derive challenge seed**
   - A future block hash, VRF, or delayed randomness seed selects sample
     coordinates after the publisher can no longer choose data around known
     challenges.

5. **Provider readiness and sample phase**
   - Providers attest they have their assigned shards.
   - The protocol opens sample/retrieval sessions for selected coordinates.
   - Providers return KZG openings and PolyFS inclusion proofs for those
     coordinates.

6. **Finalize certificate**
   - The chain verifies the sample/proof summary, quorum, or aggregate
     attestation.
   - The batch becomes `CERTIFIED`, `FAILED`, or `EXPIRED`.
   - A compact certificate object becomes queryable and bridgeable.

7. **Serve and maintain**
   - Normal user retrieval, sponsored retrieval, and protocol audit sessions
     continue after certification.
   - Failures feed provider health, repair, penalties, and certificate status
     history.

The final object should be bridge-friendly:

```text
AvailabilityCertificate {
  lane_id
  batch_id
  batch_data_root
  polyfs_root_or_segment_root
  erasure_profile
  provider_set_hash
  sample_policy_id
  sample_seed_height
  sample_result_root
  certified_height
  retention_until
}
```

## Modest Protocol Additions

The additions are real but bounded. This is why the research track is credible.

### 1. DA lane object

Add a lane object that references a backing deal or set of deals.

Core fields:

- `lane_id`
- `owner`
- `writer_policy`
- `retrieval_policy`
- `backing_deal_ids`
- `current_lane_root`
- `next_batch_id`
- `erasure_profile`
- `retention_policy`
- `fee_policy`

This should not replace deals. Deals remain the storage/economic substrate.
Lanes are the publication abstraction.

### 2. Append-only batch transaction

Add `MsgPublishDABatch` or `MsgAppendDABatch`:

- `lane_id`
- `previous_lane_root`
- `batch_id`
- `batch_data_root`
- `polyfs_segment_root` or `new_polyfs_root`
- `namespace_or_app_id`
- `size_bytes`
- `total_mdus`
- `witness_mdus`
- `encoding_profile`
- `publisher`
- `fee`

The chain should enforce lane-level CAS. A stale append fails rather than
silently replacing a later batch.

### 3. Batch root history

DA needs every batch root to remain addressable. We should not model a lane as
only "current filesystem root." Add either:

- an append log object stored on chain for small metadata and in PolyFS for
  large metadata; or
- a lane root tree where each leaf is a certified batch descriptor.

The second option scales better and maps naturally to light clients.

### 4. Public append writes

Current public retrieval is not enough. Public writes need:

- writer policy modes: owner-only, allowlist, paid-public, sequencer key,
  threshold policy;
- anti-spam fees and maximum batch size;
- admission checks before providers accept large staged uploads;
- deterministic batch ordering;
- expired pending batch cleanup; and
- per-lane spend caps.

Paid-public writes are valuable, but they need an explicit batcher or ordering
rule. Otherwise, concurrent append attempts create avoidable churn.

### 5. DA sample sessions

Retrieval sessions can be generalized or specialized into sample sessions.

Sample session fields should include:

- `lane_id`
- `batch_id`
- `sample_coordinate`
- `provider_slot`
- `polyfs_root_or_segment_root`
- `commitment`
- `expiry`
- `purpose = DA_SAMPLE`
- `funding = REQUESTER | PROTOCOL | LANE_ESCROW`

The response should be small and verifiable. It should not require returning a
full MDU when a cell/blob proof is enough.

### 6. Certificate state machine

Batch certification states:

- `PENDING_DISPERSAL`
- `PENDING_RANDOMNESS`
- `SAMPLING`
- `CERTIFIED`
- `FAILED`
- `EXPIRED`
- `REVOKED_OR_DEGRADED` for post-certification service failures, if we choose
  to expose degradation without rewriting history.

The certificate is historical. A later provider failure should not pretend the
batch was never certified. It should create a separate service-health event.

### 7. Encoding correctness evidence

At minimum, a DA lane must define how a verifier knows the encoded shards match
the source data root. Options:

- deterministic client-side encoding plus fraud proofs;
- provider-side re-encoding for small batches;
- KZG homomorphism checks over RS parity commitments;
- a disperser-generated proof verified by providers before attestation; or
- a heavier SNARK/validity proof later.

This is probably the deepest research item.

### 8. Bridge/API surface

DA buyers will need APIs that look like their world, not ours:

- publish batch;
- query certificate by lane and batch id;
- sample coordinate;
- retrieve namespace/range;
- get proof bundle;
- get provider health and retention status;
- export certificate for L1, settlement, or rollup contracts.

## Sampling Model Sketch

The first serious model to evaluate:

- Data is encoded into `N` provider slots with `K`-of-`N` reconstructability.
- A batch is split into sample coordinates that map to `(mdu_index,
  leaf_index, slot, row)`.
- The challenge seed is unknown until after staged upload and pending batch
  publication.
- The protocol samples `s` coordinates across slots and rows.
- A certificate is issued if enough providers return valid proofs before
  expiry and any required quorum/attestation threshold is met.

Open model choices:

- Do samples target all slots uniformly or stake/slot-weighted providers?
- Does a certificate require readiness attestations from all providers, from
  `K` providers per row, or from a threshold by stake/capacity?
- Does failure of a parity slot block certification, or only reduce service
  health?
- Can any third party submit successful samples, or only selected samplers?
- What confidence bound do we advertise for a given batch size and sample
  count?

The minimum viable answer is not "perfect DAS." The minimum viable answer is a
formally specified availability-certificate policy that is honest about its
assumptions.

## Security Model Questions

This is where the full research track should spend time.

### Publisher withholding

Can a publisher get a batch certified while withholding enough source or shard
data that reconstruction later fails?

Required work:

- model withholding under RS(8,12);
- decide whether readiness attestations are enough;
- quantify sample counts against partial withholding;
- define invalid encoding evidence; and
- define who can submit the evidence and for how long.

### Provider collusion

If the assigned providers collude, they may answer samples but fail broad
retrieval later.

Required work:

- connect provider selection to anti-Sybil assumptions;
- quantify failure under slot concentration;
- use operator diversity constraints from existing placement policy;
- decide whether stake/bond weighting is needed for certificate claims; and
- treat post-cert retrieval failures as economic evidence.

### Sampling grinding

If the publisher can predict sample coordinates, it can satisfy those and
withhold elsewhere.

Required work:

- use delayed randomness;
- commit staged artifacts before sample seed;
- prevent provider/gateway rewriting after seed;
- bind samples to batch root and provider set; and
- reject certificates if staged bytes were not fixed before randomness.

### Encoding fraud

If parity is malformed, random samples may verify locally but fail global
reconstruction.

Required work:

- define parity commitment checks;
- define row-level reconstruction fraud proofs;
- decide if providers must verify their shard against a disperser proof;
- decide whether KZG homomorphism is enough for the first lane profile; and
- produce test vectors.

### Data equivocation

A malicious gateway could serve different data to different providers or
publish metadata that does not match stored bytes.

Required work:

- bind provider uploads to batch id, lane id, root, and expected previous root;
- require provider-daemons to verify incoming artifact headers;
- include staged artifact digests in provider readiness attestations; and
- make mismatched roots slashable or at least certificate-failing evidence.

### Certificate semantics

The certificate must not overclaim.

It should say something like:

> Under lane policy X, at height H, against root R and provider set P, the
> protocol observed enough valid sampled custody/serving evidence to certify
> batch B under confidence model M.

It should not say:

> Every byte will always be available forever.

That stronger historical retrieval claim belongs to the ongoing storage and
repair layer, not the momentary DA certificate.

## Where PolyStore Could Be Better Than The Market

The best founder-level position:

**Most DA systems optimize publication. PolyStore can join publication-time
availability with long-lived, paid, provable retrieval.**

This creates a different market claim:

- Celestia-style DA tells you data was available in the DA window.
- Ethereum PeerDAS lowers per-node burden for Ethereum blob availability.
- EigenDA specializes roles and aggregates availability attestations.
- PolyStore DA lanes can make the availability window economically continuous
  with retrieval, repair, and public access.

The "better" claim should be specific:

1. **Retrieval-accountable DA**
   - Samples and later reads are paid service events, not informal P2P favors.
2. **Post-cert repair**
   - Certified data remains under repair and provider-health policy.
3. **Public retrieval funding**
   - Third parties can pay to verify or retrieve public lane data without
     draining the publisher.
4. **Operator accountability**
   - Slot responsibility, session proofs, and health history make failures
     attributable.
5. **Archival continuity**
   - The same lane can move from hot DA window to long-term archive without a
     separate storage migration.

This is not necessarily "best DA throughput." It is potentially "best
availability service over time."

## What Not To Build First

Avoid these traps:

- Do not claim current PolyStore deals are already a complete DA layer.
- Do not build a generic DA chain with no differentiated retrieval story.
- Do not make a lane API that only exposes PolyStore paths; rollups need batch,
  namespace, and certificate APIs.
- Do not rely only on provider readiness acknowledgements; that looks like a
  DAC without enough accountability.
- Do not create append-only public writes without lane-level ordering,
  admission fees, and stale-root handling.
- Do not overpromise light-client security before the sampling math is written.

## Implementation Phases

### Phase 0: Research specification

Produce a formal design note that defines:

- DA lane object model;
- batch descriptor schema;
- certificate state machine;
- sample-coordinate grammar;
- encoding-correctness approach;
- threat model;
- probability/confidence claims; and
- API requirements for rollups and light clients.

Output: one research RFC plus simulation tasks.

### Phase 1: Append-only lane prototype

Implement lanes over existing PolyStore deals:

- owner/allowlist writer policy;
- `MsgAppendDABatch`;
- lane-level CAS;
- batch root history;
- basic public retrieval by `(lane_id, batch_id, range)`;
- gateway path mapping from batch ids to PolyFS paths; and
- no strong DAS claim yet.

Output: "availability-indexed storage lane."

### Phase 2: Certificate MVP

Add certification without claiming full light-client DAS:

- provider readiness attestations;
- delayed-randomness sample selection;
- protocol-funded sample sessions;
- certificate object;
- certificate query API;
- failed/expired batch states; and
- provider health effects from failed samples.

Output: "sampled availability certificate under explicit policy."

### Phase 3: DAS research hardening

Formalize and test:

- sampling confidence model;
- invalid encoding/fraud proof path;
- collusion and provider concentration model;
- sample aggregation;
- lane economics; and
- bridgeable certificate verification.

Output: credible whitepaper section or standalone PolyDA paper.

### Phase 4: Rollup integration

Build one concrete integration:

- an OP Stack alt-DA adapter;
- a generic DA client SDK;
- batch publishing and certificate polling;
- fallback retrieval from PolyStore;
- archive continuity after the hot DA window; and
- explorer/indexer coverage dashboard.

Output: a live design partner demo.

## Product Positioning

Suggested names:

- PolyStore DA Lanes
- PolyDA
- PolyFS Availability Certificates
- PolyStore Availability Service

Suggested one-liner:

**PolyStore DA lanes let applications publish erasure-coded batches, receive an
availability certificate, and keep the same data retrievable through paid,
provable, repairable storage.**

Suggested cautious technical claim:

**PolyStore is not just storing rollup data after the fact. It can evolve into a
publication and retrieval layer where availability samples, user reads, repairs,
and provider accountability all share one economic proof surface.**

Suggested category claim:

**DA should not end at publication. PolyStore turns availability into an
ongoing service with certificates, retrieval sessions, repair, and public
payment.**

## Open Research Questions

1. What is the exact confidence bound for sample counts under the RS(8,12)
   profile and plausible withholding strategies?
2. Should lane certificates be stake-weighted, slot-weighted, or capacity/bond
   weighted?
3. Can KZG homomorphism over the current RS parity construction support compact
   encoding-correctness checks, or do we need a separate proof?
4. How should certificates degrade after post-cert retrieval failures?
5. What is the minimum useful certificate for a rollup settlement contract?
6. Can public paid sampling create griefing pressure, and how should fees rate
   limit it?
7. Should a DA lane use the same 8 MiB MDU size, or should small-batch lanes
   introduce an aggregation layer to avoid poor economics for tiny batches?
8. How does lane batching interact with current PolyFS root history and
   provisional-generation cleanup?
9. Can lane roots be bridged to EVM cheaply enough for OP Stack / Arbitrum-style
   integration?
10. What is the honest marketing line before a formal DAS proof exists?

## Recommendation

Start the DA research track, but make it disciplined:

1. Keep archival/retrieval as the near-term commercial wedge.
2. Define PolyStore DA lanes as the technical bridge from storage deals to DA.
3. Build append-only lane semantics first, because they are useful even before
   full DAS.
4. Add availability certificates with explicit assumptions before claiming
   trust-minimized DAS.
5. Use the full DAS research track to earn the right to say "better DA" later.

The promising direction is not to clone Celestia or PeerDAS. It is to make
PolyStore the protocol where publication-time availability, long-term
retrieval, repair, and economic accountability are one continuous system.

## Source Pointers

Local:

- `whitepaper.md`
- `rfcs/rfc-blob-alignment-and-striping.md`
- `rfcs/rfc-polyfs-generation-cas-and-staged-writes.md`
- `rfcs/rfc-mandatory-retrieval-sessions-and-batching.md`
- `rfcs/rfc-challenge-derivation-and-quotas.md`
- `rfcs/rfc-mode2-onchain-state.md`
- `rfcs/rfc-retrieval-access-control-public-deals-and-vouchers.md`
- `rfcs/rfc-pricing-and-escrow-accounting.md`
- `rfcs/rfc-polyfs-root-contract.md`
- `polystorechain/proto/polystorechain/polystorechain/v1/types.proto`
- `polystorechain/proto/polystorechain/polystorechain/v1/tx.proto`
- `docs/notes/HISTORICAL_DA_ARCHIVAL_RETRIEVAL_MARKET.md`

External:

- Celestia data availability docs:
  https://docs.celestia.org/learn/celestia-101/data-availability/
- Ethereum EIP-7594 PeerDAS:
  https://eips.ethereum.org/EIPS/eip-7594
- Teku PeerDAS docs:
  https://docs.teku.consensys.io/concepts/peer-das
- EigenDA overview:
  https://docs.eigencloud.xyz/eigenda/core-concepts/overview
- Avail DA docs:
  https://docs.availproject.org/docs/da/concepts/how-avail-da-works

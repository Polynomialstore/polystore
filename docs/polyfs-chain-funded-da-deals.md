# PolyFS Chain-Funded DA Deals

**Status:** Founder strategy and technical sizing memo
**Date:** 2026-06-29
**Related RFCs:**
`rfcs/rfc-polyfs-da-lanes.md`,
`rfcs/rfc-chain-funded-da-deals.md`

-----

## Thesis

PolyStore's best DA product is a standing availability contract for chains.

The product line is:

> Launch a chain with a DA Deal: publish batches, get availability
> certificates, and keep the data retrievable for as long as the chain funds it.

A chain-funded DA Deal is a standing service contract between a chain and the
PolyStore availability-provider market. The chain funds publication,
certification, retained retrieval, repair, and provider elasticity through a
policy-governed Deal.

In this model:

* the chain's sequencer or batcher publishes ordered batches;
* a PolyStore user-gateway or disperser encodes and disperses the batch;
* protocol-selected provider-daemons store assigned artifacts and sign
  attestations;
* the PolyStore chain issues tiered Availability Certificates; and
* derivation nodes, challengers, indexers, explorers, and archival clients can
  retrieve the data while the Deal remains funded.

The key product primitive is the **DA Deal**, not a one-off blob upload. DA
Lanes are how batches are appended. Availability Certificates are how external
systems accept them. Deals are how the chain continuously funds storage,
retrieval, repair, and provider elasticity.

-----

## System Shape

```text
Chain
  -> Chain-funded DA Deal
    -> DA Lane
      -> Batch publication
        -> Provider assignment
        -> Artifact dispersal
        -> Provider availability attestations
        -> DA_CERT_FAST
        -> Publication-time retrieval samples
        -> DA_CERT_RETRIEVABLE
        -> Retained-generation audits, repair, and paid retrieval
```

| Term | Meaning |
|---|---|
| **Sequencer** | Orders transactions and produces chain blocks. |
| **Batcher / publisher** | Compresses chain data into ordered DA batches and submits them to the DA lane. |
| **Disperser / user-gateway** | Encodes the batch, derives commitments, disperses assigned artifacts, aggregates attestations, and polls certificates. |
| **Availability provider / provider-daemon** | Receives assigned artifacts, verifies them, persists them under the referenced Deal/generation/slot, signs availability attestations, and serves samples/retrievals. |
| **Availability Certificate** | Compact certificate that a batch satisfied a named policy and tier. |
| **DA verifier / bridge** | External verifier, bridge, or contract that checks the certificate before accepting the batch root. |
| **Derivation node** | Chain node that reconstructs the input stream from DA data. |
| **Challenger / prover** | Independent actor that retrieves data to verify or challenge chain execution. |
| **Indexer / explorer / archival client** | Long-lived reader that needs retained history and backfills. |

The publication path and retrieval path should be modeled separately. A
sequencer and batcher need the full batch. Provider-daemons generally need only
their assigned encoded artifacts. External verifiers need a compact certificate,
not the whole batch. Derivation nodes and indexers need data later, and may
generate more aggregate bandwidth than initial publication.

-----

## Public Chain Targets

These are public examples and should remain in the repo. The purpose is to make
the product thesis concrete against actual chains and data footprints.

### OP Stack and Superchain-style chains

OP Stack is the most direct first integration surface because its Alt-DA mode
already describes a DA server, L1 commitments, and challenge-window semantics.
PolyStore can implement this as:

```text
op-batcher -> PolyStore DA server/user-gateway -> DA Lane
  -> Availability Certificate -> L1 commitment / challenge interface
```

Concrete public examples:

| Chain | Best initial PolyStore role | Why it matters |
|---|---|---|
| **Base** | Retained DA and historical blob retrieval first; primary Alt-DA later only if trust/security posture permits. | Largest measured Ethereum blob rollup in the sample. Strong need for indexer, explorer, and node-bootstrap history. |
| **OP Mainnet** | Retained DA and public historical retrieval. | Canonical OP Stack chain; useful reference target even if not first primary Alt-DA customer. |
| **World Chain** | Chain-funded DA Deal with retained retrieval; later primary Alt-DA candidate. | Consumer-scale chain where user activity can create bursty publication and retrieval demand. |
| **Unichain** | Retained DA and high-availability retrieval for economic data. | Financial activity creates high-value backfill and indexer demand. |
| **Soneium** | Chain-funded retained DA; possible appchain-style primary DA later. | Consumer/application orientation makes retained data service legible. |
| **Ink** | Retained DA and dual-DA. | Financial/application data benefits from durable history and retrieval SLAs. |
| **Mode** | Small-to-mid retained DA and primary Alt-DA pilot candidate. | Current blob footprint is small enough for a controlled pilot. |
| **Zora** | Strong narrative fit for retained DA and public retrieval. | Media/NFT/social history is naturally long-lived and public. |
| **Blast / Katana** | Retained DA and app-specific retrieval guarantees. | Medium DA users where retrieval and history can become differentiated services. |

### Arbitrum Orbit / AnyTrust-style chains

AnyTrust-style systems already make Data Availability Committees and
availability certificates part of the mental model. PolyStore's opportunity is
to replace or augment a static committee with a paid, accountable provider
market and retained retrieval.

| Chain | Best initial PolyStore role | Why it matters |
|---|---|---|
| **Arbitrum One** | Retained DA / blob-history service rather than first primary replacement. | Large conservative target; useful for archive and indexer value. |
| **Arbitrum Nova** | AnyTrust-style retained retrieval and DA Deal proof point. | Existing AnyTrust framing makes PolyStore Availability Certificates easy to explain. |
| **Xai** | Game-chain DA Deal and elastic retained retrieval. | High transaction count and game-state replay needs fit paid public retrieval and event-driven scale-up. |
| **ApeChain** | Game/consumer DA Deal and retained retrieval. | High observed transaction count; strong need for replayable public history. |
| **RARI / Treasure-style Orbit chains** | Retained public history for NFTs, games, and marketplaces. | Data is culturally and economically valuable long after publication. |

### Ethereum blob rollups

For existing Ethereum blob rollups, the first PolyStore product should often be
dual DA:

```text
Ethereum blob DA for primary settlement
+ PolyStore DA Deal for retained retrieval, backfills, and recovery
```

| Chain | Best initial PolyStore role | Why it matters |
|---|---|---|
| **Base** | Largest immediate retained-DA opportunity in the measured set. | About 1.2 GB/day raw blob data in the snapshot. |
| **Arbitrum** | Retained blob archive and indexer recovery. | About 0.45 GB/day raw blob data in the snapshot. |
| **World Chain** | Consumer-scale retained DA. | About 0.32 GB/day raw blob data in the snapshot. |
| **OP Mainnet** | Canonical retained DA reference. | About 0.18 GB/day raw blob data in the snapshot. |
| **Starknet, Linea, Scroll, Zircuit, Mantle** | Retained DA and public retrieval. | Smaller current footprints, useful for pilots and proof bundles. |

### Celestia and modular DA users

For Celestia or other modular DA users, PolyStore should start as the retained
retrieval layer while the source DA system remains the primary publication
security layer.

| Chain / ecosystem | Best initial PolyStore role | Why it matters |
|---|---|---|
| **Manta Pacific** | Retained retrieval and recovery for source-DA data. | Publicly associated with modular DA and a natural archive target. |
| **Eclipse** | Retained recovery and high-throughput historical reads. | SVM-style throughput can create valuable retained data demand. |
| **Initia / Movement-style modular chains** | Dual DA and retained retrieval. | A chain can keep its source DA security while buying PolyStore history and retrieval. |

-----

## Public Data Snapshot

Source snapshot:

* Blobscan `stats/timeseries`, `timeFrame=7d`, `rollups=all`, metrics
  `totalBlobs,totalBlobSize,totalBlobUsageSize,totalTransactions`.
* Latest complete Blobscan UTC day in this snapshot:
  `2026-06-29T00:00:00.000Z`.
* Appchain explorer stats were read from public Blockscout-style APIs on
  2026-06-29 Hawaii time / 2026-06-30 UTC.
* Blob raw capacity uses Blobscan `totalBlobSize`.
* `RS(8,12)` aggregate storage uses `1.5x` raw bytes before metadata,
  indexing, certificates, hot replicas, and operational headroom.

| Chain / rollup | Latest blobs/day | Blob tx/day | Latest raw GB/day | Latest used GB/day | 7d avg raw GB/day | 7d avg used GB/day | RS(8,12) GB/day | RS one-year GB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Base | 9,092 | 1,516 | 1.192 | 1.166 | 1.229 | 1.198 | 1.788 | 652.5 |
| Arbitrum | 3,465 | 1,155 | 0.454 | 0.452 | 0.398 | 0.396 | 0.681 | 248.7 |
| World Chain | 2,470 | 494 | 0.324 | 0.321 | 0.346 | 0.343 | 0.486 | 177.3 |
| OP Mainnet | 1,375 | 275 | 0.180 | 0.179 | 0.208 | 0.207 | 0.270 | 98.7 |
| Unichain | 783 | 261 | 0.103 | 0.102 | 0.109 | 0.108 | 0.154 | 56.2 |
| Soneium | 700 | 140 | 0.092 | 0.092 | 0.176 | 0.175 | 0.138 | 50.2 |
| Katana | 632 | 205 | 0.083 | 0.069 | 0.071 | 0.058 | 0.124 | 45.4 |
| Ink | 612 | 102 | 0.080 | 0.080 | 0.075 | 0.075 | 0.120 | 43.9 |
| Starknet | 228 | 38 | 0.030 | 0.030 | 0.028 | 0.028 | 0.045 | 16.4 |
| Blast | 204 | 68 | 0.027 | 0.027 | 0.027 | 0.027 | 0.040 | 14.6 |
| Mantle | 194 | 193 | 0.025 | 0.006 | 0.025 | 0.006 | 0.038 | 13.9 |
| Mode | 83 | 50 | 0.011 | 0.007 | 0.009 | 0.005 | 0.016 | 6.0 |
| Zircuit | 73 | 73 | 0.010 | 0.003 | 0.009 | 0.002 | 0.014 | 5.2 |
| Linea | 30 | 10 | 0.004 | 0.004 | 0.004 | 0.004 | 0.006 | 2.2 |
| Zora | 24 | 24 | 0.003 | 0.001 | 0.003 | 0.001 | 0.005 | 1.7 |
| Scroll | 21 | 17 | 0.003 | 0.003 | 0.002 | 0.002 | 0.004 | 1.5 |

Blobscan-labeled rollups in aggregate:

| Category | Latest blobs/day | Blob tx/day | Latest raw GB/day | Latest used GB/day | 7d avg raw GB/day | RS(8,12) latest GB/day | RS one-year GB |
|---|---:|---:|---:|---:|---:|---:|---:|
| All labeled rollups | 21,249 | 5,868 | 2.785 | 2.566 | 2.881 | 4.178 | 1,524.8 |

Observed public explorer transaction counts:

| Chain | Public API transactions today | Public API gas used today | Sizing interpretation |
|---|---:|---:|---|
| Xai | 166,948 | 8,970,958,827 | Roughly 50-250 MB/day logical DA before chain-specific compression measurement. |
| ApeChain | 201,976 | 34,828,235,521 | Roughly 60-300 MB/day logical DA before chain-specific compression measurement. |
| Arbitrum Nova | 8,357 | 1,917,608,431 | Roughly 2-15 MB/day logical DA before chain-specific compression measurement. |

At current public blob-rollup scale, storage volume is not the gating problem.
Even all Blobscan-labeled rollups together represent only about 1.5 TB/year of
RS(8,12)-encoded retained data before headroom. The hard requirements are
low-latency certification, provider accountability, retrieval under bursty
reads, historical-generation addressability, and economic automation.

-----

## Bandwidth Model

Let:

```text
B = logical DA batch bytes
K = reconstruction threshold
N = encoded provider slots
r = N / K expansion factor
T = publication certification target in seconds
```

For the default candidate profile:

```text
K = 8
N = 12
r = 1.5
aggregate provider ingress = B * 1.5
per-slot provider ingress = B / 8
disperser egress during certification = B * 1.5 / T
```

| Batch size | Target cert latency | Disperser egress | Per-slot provider ingress |
|---:|---:|---:|---:|
| 8 MiB | 2s | 6.0 MiB/s | 0.5 MiB/s |
| 64 MiB | 10s | 9.6 MiB/s | 0.8 MiB/s |
| 256 MiB | 20s | 19.2 MiB/s | 1.6 MiB/s |
| 1 GiB | 60s | 25.6 MiB/s | 2.1 MiB/s |

Publication bandwidth is manageable. Retrieval bandwidth is the larger
operational swing factor:

```text
retrieval egress ~= logical_DA_bytes * active_derivation_or_backfill_readers
```

A Base-like chain at about 1.2 GB/day is not difficult to publish. If 50
derivation nodes, indexers, or backfill jobs retrieve the same day, the retained
retrieval surface may see about 60 GB/day. If a chain has an incident and many
nodes resync, retrieval demand can dominate publication demand.

-----

## Recommended Sizing Tiers

| Tier | Logical DA/day | RS(8,12) storage/day | One-year RS storage | Intended customers |
|---|---:|---:|---:|---|
| Small appchain | 10-100 MB | 15-150 MB | 5-55 GB | New OP Stack, Orbit, game, NFT, or appchain pilots. |
| Active appchain | 100-500 MB | 150-750 MB | 55-274 GB | Xai/ApeChain-like or active consumer appchains. |
| Major L2 | 0.5-2 GB | 0.75-3 GB | 274 GB-1.1 TB | Base/Arbitrum/World-style retained DA. |
| Multi-chain retained DA market | 3-10 GB | 4.5-15 GB | 1.6-5.5 TB | Portfolio of public rollups and appchains. |
| Future high-throughput chain | 10-100 GB | 15-150 GB | 5.5-55 TB | A chain that outgrows current blob-rollup observed volumes. |

The first production target should support **10-100 GB/day per chain** even
though most public chains in the snapshot are below that. That gives enough
headroom to credibly sell to appchains and mid-size L2s without overbuilding for
hypothetical exabyte demand.

-----

## Provider and Quorum Model

Recommended v0 policy:

```text
K = 8
N = 12
min_attesting_slots = 10
repair_trigger = fewer than 10 healthy slots
hard_reconstructability_floor = 8 slots
```

The reason to require more than `K` attestations is product quality. A
publication certificate should not mean "barely reconstructable at the moment of
signing." It should mean the assigned provider set had meaningful live margin.

Larger profiles should scale `K` and `N` together:

```text
RS(16,24): 1.5x overhead, lower per-provider shard size
RS(32,48): 1.5x overhead, wider provider distribution
```

-----

## DA Deal Policy Surface

A chain-funded DA Deal should expose these knobs:

```text
DADealPolicy {
  chain_id
  lane_id
  settlement_context
  treasury_account
  allowed_publishers
  max_batch_bytes
  target_cert_latency
  erasure_profile
  min_providers
  max_providers
  min_attesting_slots
  sample_policy
  retention_window
  retrieval_payment_policy
  repair_policy
  scale_up_policy
  provider_diversity_policy
}
```

The policy should separate four budgets:

| Budget | Pays for |
|---|---|
| Publication budget | Encode/disperse/certify new batches. |
| Retention budget | Keep historical generations addressable. |
| Retrieval budget | Serve derivation nodes, indexers, challengers, explorers, and public users. |
| Repair budget | Replace degraded providers and restore retained service. |

Autonomous renewal matters. If the chain keeps funding the Deal, data remains
retained. If the chain stops funding it, retained status can degrade according
to policy without rewriting historical certificate facts.

-----

## Integration Priority

1. **Retained DA for existing Ethereum blob rollups.**
   Easiest wedge. Keep the current primary DA system and add retained,
   verifiable, paid retrieval through PolyStore.

2. **OP Stack Alt-DA adapter.**
   Best first primary-DA integration surface because OP Stack already has an
   Alt-DA server/challenge concept.

3. **Orbit / AnyTrust-style DA Deal.**
   Strong conceptual fit because DACerts and committees are already legible.
   PolyStore can provide a provider market, retrieval accountability, and
   retained service around that shape.

4. **Generic verifier SDK and proof bundle export.**
   Needed before serious rollup integrations. External systems should verify
   compact certificates, not replay PolyStore internals.

5. **Dual DA for Celestia/modular chains.**
   Keep the existing DA security model and add retained retrieval, recovery,
   and paid public history.

-----

## Product Positioning

Canonical line:

> Launch a chain with a DA Deal: publish batches, receive availability
> certificates, and keep data retrievable for as long as the chain funds the
> deal.

Technical line:

> PolyStore DA Deals combine attestation-first availability certificates with
> native retained retrieval, repair, and provider elasticity.

Target customer line:

> Your chain funds one DA Deal. PolyStore handles provider assignment,
> publication certificates, retained history, retrieval payments, and repair.

-----

## Required Next Artifacts

This memo should be treated as the market and sizing companion to the formal
RFCs. The implementation program should proceed through:

1. `DADealPolicy` protobuf/types and chain state.
2. A devnet `RS(8,12)` chain-funded DA Deal profile.
3. `DA_CERT_FAST` certificate issuance for a fixed provider set.
4. `DA_CERT_RETRIEVABLE` publication-time sample sessions.
5. OP Stack Alt-DA adapter prototype.
6. Retained DA service and historical-generation retrieval.
7. Policy simulations for provider churn, retrieval demand shocks, and repair
   budget exhaustion.

-----

## Sources

* Blobscan API docs: `https://docs.blobscan.com/docs/api`
* Blobscan time-series API:
  `https://api.blobscan.com/stats/timeseries?timeFrame=7d&rollups=all&metrics=totalBlobs,totalBlobSize,totalBlobUsageSize,totalTransactions`
* Blobscan category time-series API:
  `https://api.blobscan.com/stats/timeseries?timeFrame=7d&categories=all&metrics=totalBlobs,totalBlobSize,totalBlobUsageSize,totalTransactions`
* EIP-4844: `https://eips.ethereum.org/EIPS/eip-4844`
* EigenDA overview:
  `https://docs.eigencloud.xyz/eigenda/core-concepts/overview`
* EigenDA integration overview:
  `https://docs.eigencloud.xyz/eigenda/integrations-guides/rollup-guides/integrations-overview`
* OP Stack Alt-DA docs:
  `https://docs.optimism.io/op-stack/features/experimental/alt-da-mode`
* OP Stack Alt-DA spec:
  `https://specs.optimism.io/experimental/alt-da.html`
* Arbitrum AnyTrust protocol:
  `https://docs.arbitrum.io/how-arbitrum-works/deep-dives/anytrust-protocol`
* Xai explorer stats:
  `https://explorer.xai-chain.net/api/v2/stats`
* ApeChain explorer stats:
  `https://apechain.calderaexplorer.xyz/api/v2/stats`
* Arbitrum Nova explorer stats:
  `https://arbitrum-nova.blockscout.com/api/v2/stats`

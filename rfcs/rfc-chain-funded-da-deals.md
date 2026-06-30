# RFC: Chain-Funded PolyStore DA Deals

**Status:** Proposed
**Scope:** Protocol, chain state, DA lanes, storage deals, funding policy,
provider-daemon assignment, user-gateway/disperser behavior, retrieval
economics
**Depends on:**
`whitepaper.md`,
`rfcs/rfc-polyfs-da-lanes.md`,
`rfcs/rfc-pricing-and-escrow-accounting.md`,
`rfcs/rfc-retrieval-access-control-public-deals-and-vouchers.md`,
`rfcs/rfc-mandatory-retrieval-sessions-and-batching.md`,
`rfcs/rfc-polyfs-generation-cas-and-staged-writes.md`

-----

## 1. Summary

This RFC defines **Chain-Funded DA Deals** as the canonical deployment object
for PolyStore DA.

The product line is:

> Launch a chain with a DA Deal: publish batches, get availability
> certificates, and keep data retrievable for as long as the chain funds it.

A Chain-Funded DA Deal is a standing service contract between a chain and the
PolyStore provider-daemon market. It links one external chain or application
namespace to one or more DA lanes, backing storage deals, funding accounts,
provider policies, retrieval policies, repair budgets, and scale-up rules.

DA lanes remain the append-only publication streams. Availability Certificates
remain the external verification objects. Storage deals remain the durable
storage and economic substrate. A Chain-Funded DA Deal is the product and policy
layer that makes those pieces usable by a chain treasury, sequencer, batcher,
bridge, challenger, indexer, and public retrieval market.

-----

## 2. Motivation

PolyStore has a natural DA wedge that is stronger than "decentralized storage
as archive" and more realistic than claiming a fully sampling-first DA protocol
before the research exists.

The strong near-term shape is:

* attestation-first DA certificates for publication-time acceptance;
* publication-time retrieval samples for the `DA_CERT_RETRIEVABLE` tier;
* retained PolyFS generations for historical access;
* paid public retrieval for derivation nodes, challengers, indexers, explorers,
  and users;
* chain-funded renewal, repair, and provider elasticity; and
* explicit policy objects that let a chain buy a DA service rather than
  manually compose storage uploads.

This is especially important because the measured public-chain data volumes are
not the hard part. Current public blob-rollup volumes are manageable for a
storage market. The hard part is making the service continuously funded,
certifiable, retrievable under load, externally verifiable, and operationally
accountable.

-----

## 3. Goals

1. Define the product/deployment primitive for chains using PolyStore DA.
2. Make chain treasury funding, renewal, and budget boundaries explicit.
3. Link DA lanes, backing storage deals, certificate policies, retrieval
   policies, repair policies, and provider scale-up rules.
4. Support both retained-DA/dual-DA use cases and primary attestation-first DA
   use cases.
5. Provide a policy surface that can be mapped to OP Stack Alt-DA,
   Arbitrum Orbit/AnyTrust-style systems, Ethereum blob-rollup retained DA,
   and modular-chain retained retrieval.
6. Make public chain targeting and sizing concrete enough for founder,
   protocol, and business-development work.
7. Preserve the security boundary from `rfcs/rfc-polyfs-da-lanes.md`: DA claims
   depend on certificates, provider-daemon attestations, sample results, and
   verifier policy, not on storage deals alone.

-----

## 4. Non-Goals

This RFC does not:

* claim current storage deals are already a complete primary DA layer;
* define a Celestia-equivalent or PeerDAS-equivalent light-client sampling
  protocol;
* replace the DA certificate semantics in `rfcs/rfc-polyfs-da-lanes.md`;
* finalize slashing or all fee-market parameters;
* require every chain to use PolyStore as primary DA;
* require every provider-daemon to store every byte; or
* implement the messages proposed here.

-----

## 5. Terminology

| Term | Meaning |
|---|---|
| **Chain-Funded DA Deal** | Standing PolyStore policy and funding object for one chain or application namespace. |
| **DA Deal Policy** | Chain-visible parameters for allowed publishers, batch size, certificate tier, erasure profile, provider count, retrieval payment, repair, retention, and scale-up. |
| **DA Lane** | Append-only publication stream defined in `rfcs/rfc-polyfs-da-lanes.md`. |
| **Backing storage deal** | Existing PolyStore storage/economic object that stores retained generations and pays provider-daemons. |
| **Treasury account** | Chain, bridge, foundation, sequencer, or governance-controlled account that funds publication, retrieval, repair, and retention. |
| **Publisher** | Authorized sequencer, batcher, bridge, user-gateway, or disperser that appends batches. |
| **provider-daemon** | Storage-provider runtime that receives assigned artifacts, verifies them, persists them, signs attestations, serves samples, and participates in repair. |
| **user-gateway / disperser** | Client-side or service-side component that encodes batches, disperses artifacts, aggregates attestations, opens sample sessions, and exports proof bundles. |
| **Availability Certificate** | Compact DA certificate emitted under a named policy and verified by an external chain, bridge, or application. |

-----

## 6. Product Shape

The canonical service flow is:

```text
Chain treasury
  -> funds Chain-Funded DA Deal
    -> authorizes sequencer/batcher publishers
      -> publishers append ordered batches to a DA Lane
        -> user-gateway/disperser encodes and disperses artifacts
          -> protocol-selected provider-daemons attest
            -> PolyStore issues Availability Certificates
              -> derivation nodes, challengers, indexers, explorers, and users
                 retrieve retained data while the Deal remains funded
```

This object lets a new chain start with one explicit DA service contract:

* one funding account;
* one or more DA lanes;
* one default certificate tier;
* one retention target;
* one retrieval payment policy;
* one provider assignment policy; and
* one scale-up policy.

The chain should not need to manually manage individual storage uploads for
every batch. It should fund a policy. The policy should create or link the
necessary lane and backing-deal state.

-----

## 7. Proposed Chain Objects

### 7.1 `DADealPolicy`

```protobuf
message DADealPolicy {
  uint64 da_deal_id = 1;
  string external_chain_id = 2;
  string settlement_context = 3;
  string treasury_account = 4;
  repeated string allowed_publishers = 5;
  repeated uint64 lane_ids = 6;
  repeated uint64 backing_deal_ids = 7;
  uint64 max_batch_bytes = 8;
  uint64 target_cert_latency_ms = 9;
  CertificateTier default_certificate_tier = 10;
  string erasure_profile = 11;
  uint32 min_providers = 12;
  uint32 max_providers = 13;
  uint32 min_attesting_slots = 14;
  uint64 sample_policy_id = 15;
  uint64 retention_window_blocks = 16;
  uint64 retrieval_payment_policy_id = 17;
  uint64 repair_policy_id = 18;
  uint64 scale_up_policy_id = 19;
  uint64 provider_diversity_policy_id = 20;
  DADealStatus status = 21;
}
```

`external_chain_id` is not necessarily a Cosmos chain id. It is the stable
identifier for the chain, rollup, appchain, bridge, or namespace whose batches
are being served.

`settlement_context` describes where certificates are consumed, for example an
Ethereum L1 contract, OP Stack Alt-DA commitment path, Orbit/AnyTrust verifier,
or a generic SDK verifier.

### 7.2 `DADealFundingAccount`

```protobuf
message DADealFundingAccount {
  uint64 da_deal_id = 1;
  string treasury_account = 2;
  string publication_balance = 3;
  string retrieval_balance = 4;
  string retention_balance = 5;
  string repair_balance = 6;
  string low_watermark = 7;
  string pause_watermark = 8;
  uint64 last_funded_height = 9;
  uint64 projected_runway_blocks = 10;
}
```

The four balances SHOULD remain distinguishable:

| Budget | Pays for |
|---|---|
| Publication | Encoding, dispersal, attestations, and certificate finalization. |
| Retrieval | Sample sessions, derivation reads, indexer reads, explorer reads, and public retrieval subsidies. |
| Retention | Ongoing storage of retained generations. |
| Repair | Provider replacement, migration, and repair traffic after degradation. |

Policies MAY allow one shared account internally, but accounting MUST preserve
which service consumed funds.

### 7.3 `DADealUsageWindow`

```protobuf
message DADealUsageWindow {
  uint64 da_deal_id = 1;
  uint64 window_start_height = 2;
  uint64 window_end_height = 3;
  uint64 batches_published = 4;
  uint64 logical_bytes_published = 5;
  uint64 encoded_bytes_stored = 6;
  uint64 certificate_count = 7;
  uint64 sample_count = 8;
  uint64 retrieval_bytes_served = 9;
  uint64 repair_bytes_moved = 10;
  string publication_spend = 11;
  string retrieval_spend = 12;
  string retention_spend = 13;
  string repair_spend = 14;
}
```

Usage windows are needed for pricing, runway, policy tuning, and public
reporting. They also make it possible to compare public chain footprints
without pretending every chain has the same DA shape.

### 7.4 `DADealScaleUpPolicy`

```protobuf
message DADealScaleUpPolicy {
  uint64 scale_up_policy_id = 1;
  uint64 da_deal_id = 2;
  uint64 hot_retrieval_bytes_per_window = 3;
  uint64 max_certificate_latency_ms = 4;
  uint64 provider_error_rate_ppm = 5;
  uint32 min_extra_providers = 6;
  uint32 max_extra_providers = 7;
  uint64 cooldown_blocks = 8;
}
```

Scale-up is part of the product thesis. A chain should be able to fund a Deal
and let PolyStore add provider-daemon capacity as publication bandwidth,
retrieval demand, or repair pressure rises.

-----

## 8. Proposed Messages

### 8.1 `MsgCreateDADealPolicy`

Creates a chain-funded DA service policy.

Required checks:

* caller controls or is authorized by `treasury_account`;
* `default_certificate_tier` is supported;
* erasure profile is recognized;
* provider, sample, retrieval, repair, and scale-up policies exist;
* initial funding meets policy minimums; and
* any linked backing deals or lanes are compatible with the policy.

### 8.2 `MsgFundDADeal`

Adds funds to one or more DA Deal budgets.

Required checks:

* sender owns funds;
* budget class is supported;
* balance accounting updates projected runway; and
* low-watermark alerts clear only when all required budgets are restored.

### 8.3 `MsgLinkDALane`

Links an existing DA lane to a Chain-Funded DA Deal or creates a new lane under
the policy.

Required checks:

* lane owner and DA Deal policy authorize the link;
* lane `writer_policy` is compatible with `allowed_publishers`;
* lane certificate policy is no weaker than the DA Deal target; and
* lane backing deals satisfy retention and retrieval policy.

### 8.4 `MsgUpdateDADealPolicy`

Updates mutable policy fields, such as publisher set, batch cap, target tier,
scale-up triggers, or retrieval sponsorship.

Required checks:

* update is authorized;
* existing certified batches keep their historical policy identity;
* weakening a policy cannot retroactively change certificate meaning; and
* changes take effect at a future height or future batch id.

### 8.5 `MsgRequestDADealScaleUp`

Requests or records provider-daemon capacity expansion for a hot DA Deal.

Required checks:

* trigger satisfies `DADealScaleUpPolicy`, or caller pays an explicit premium;
* candidate providers are eligible and diverse under policy;
* scale-up does not reduce reconstructability for existing retained data; and
* scale-up costs are funded.

-----

## 9. Public Chain Targeting

Public chain names belong in this analysis. They make the service concrete and
force sizing discipline.

### 9.1 OP Stack and Superchain-style chains

OP Stack is the best first primary-DA integration surface because Alt-DA already
has a DA server, commitment path, and challenge-window mental model.

| Chain | Best initial PolyStore role |
|---|---|
| Base | Retained DA and historical blob retrieval first; primary Alt-DA only after verifier/security posture matures. |
| OP Mainnet | Retained DA reference target and canonical OP Stack adapter test case. |
| World Chain | Chain-funded retained DA, then primary Alt-DA candidate for consumer-scale data. |
| Unichain | Retained DA and high-availability retrieval for financial/indexer data. |
| Soneium | Consumer/appchain retained DA and possible primary-DA pilot. |
| Ink | Retained DA and dual-DA for financial/application history. |
| Mode | Small-to-mid primary Alt-DA pilot candidate. |
| Zora | Public retained DA and retrieval for media/NFT/social history. |
| Blast / Katana | Medium DA users where retained retrieval and app-specific SLAs matter. |

### 9.2 Arbitrum Orbit and AnyTrust-style chains

AnyTrust-style systems already make committees and availability certificates
legible. PolyStore's role is to turn that committee-shaped idea into a paid,
accountable provider-daemon market with retained retrieval.

| Chain | Best initial PolyStore role |
|---|---|
| Arbitrum One | Retained blob/archive service before primary replacement. |
| Arbitrum Nova | AnyTrust-style DA Deal proof point. |
| Xai | Game-chain DA Deal with elastic retained retrieval. |
| ApeChain | Game/consumer DA Deal and retained public history. |
| RARI / Treasure-style Orbit chains | Retained public history for NFT, game, and marketplace data. |

### 9.3 Ethereum blob rollups

For existing blob rollups, the first product is often dual DA:

```text
Ethereum blob DA for primary settlement
+ PolyStore DA Deal for retained retrieval, backfills, recovery, and public reads
```

| Chain | Best initial PolyStore role |
|---|---|
| Base | Largest immediate retained-DA opportunity in the measured set. |
| Arbitrum | Retained blob archive and indexer recovery. |
| World Chain | Consumer-scale retained DA. |
| OP Mainnet | Canonical retained DA reference. |
| Starknet, Linea, Scroll, Zircuit, Mantle | Smaller pilots and proof bundles. |

### 9.4 Modular DA users

For Celestia or other modular DA users, PolyStore should initially be retained
retrieval and recovery, not a claim that the source DA security layer has been
replaced.

| Chain / ecosystem | Best initial PolyStore role |
|---|---|
| Manta Pacific | Retained retrieval and recovery for source-DA data. |
| Eclipse | High-throughput historical retrieval and recovery. |
| Initia / Movement-style modular chains | Dual DA and retained retrieval. |

-----

## 10. Sizing Profiles

Recommended v0 profile:

```text
K = 8
N = 12
expansion = 1.5x
min_attesting_slots = 10
hard_reconstructability_floor = 8
repair_trigger = fewer than 10 healthy slots
```

Representative tiers:

| Tier | Logical DA/day | RS(8,12) storage/day | One-year RS storage | Intended customer |
|---|---:|---:|---:|---|
| Small appchain | 10-100 MB | 15-150 MB | 5-55 GB | New OP Stack, Orbit, game, NFT, or appchain pilots. |
| Active appchain | 100-500 MB | 150-750 MB | 55-274 GB | Xai/ApeChain-like or active consumer appchains. |
| Major L2 | 0.5-2 GB | 0.75-3 GB | 274 GB-1.1 TB | Base/Arbitrum/World-style retained DA. |
| Multi-chain retained DA market | 3-10 GB | 4.5-15 GB | 1.6-5.5 TB | Portfolio of public rollups and appchains. |
| Future high-throughput chain | 10-100 GB | 15-150 GB | 5.5-55 TB | Chain that outgrows current observed blob-rollup volumes. |

The first production system should be designed for **10-100 GB/day per chain**
even though current public-chain snapshots are mostly below that range. That
headroom is large enough for credible DA positioning without overfitting the
protocol around speculative exabyte demand.

-----

## 11. Lifecycle

1. **Create policy.** Chain or foundation creates a `DADealPolicy`.
2. **Fund budgets.** Treasury funds publication, retrieval, retention, and
   repair balances.
3. **Create or link lane.** Policy creates or links one or more DA lanes.
4. **Create or link backing deals.** Policy creates or links backing storage
   deals sized for the retention target.
5. **Publish batches.** Authorized sequencer or batcher appends ordered
   batches.
6. **Certify.** Provider-daemons attest and the chain issues the configured
   certificate tier.
7. **Serve reads.** Derivation nodes, challengers, indexers, explorers, and
   users retrieve data under public, sponsored, or requester-funded policy.
8. **Repair and scale.** Provider degradation, retrieval heat, or publication
   latency triggers repair or capacity expansion.
9. **Renew or degrade.** If funding continues, retained service continues. If
   funding stops, retained status degrades under policy without rewriting
   historical certificate facts.

-----

## 12. Security and Failure Semantics

The DA Deal does not make a batch available by itself. Availability still comes
from the DA-lane certificate path.

Rules:

* A DA Deal MUST NOT advertise a certificate tier the linked DA lane cannot
  issue.
* A DA Deal MUST NOT retroactively upgrade historical certificates when policy
  improves.
* A DA Deal MAY downgrade future publishing when funding falls below policy
  watermarks.
* Retained-service degradation MUST NOT rewrite historical certificate facts.
* Publisher authorization MUST be explicit; public append-only writes require a
  separate anti-spam and payment policy.
* Scale-up MUST preserve provider diversity and avoid publisher-selected
  friendly placement.
* Retrieval sponsorship MUST be rate-limited so public verification cannot
  drain treasury funds accidentally.

-----

## 13. Implementation Roadmap

### Phase 0: Docs, fixtures, and tracker alignment

Deliverables:

* this RFC;
* public-chain sizing and positioning memo:
  `docs/polyfs-chain-funded-da-deals.md`;
* policy fixtures:
  `docs/chain-funded-da-deal-policy-fixtures.md`;
* DA-lanes RFC cross-reference; and
* tracker issue update.

### Phase 1: Policy object and funding account

Deliverables:

* `DADealPolicy`;
* `DADealFundingAccount`;
* create/fund/update/query messages;
* budget accounting; and
* policy fixtures in tests.

Exit criteria:

* a DA Deal can be created, funded, queried, paused on insufficient funding,
  and linked to a lane without changing existing storage-deal behavior.

### Phase 2: Lane linkage and publication path

Deliverables:

* link/create DA lane from a DA Deal;
* publisher authorization;
* append path that charges publication budget;
* certificate policy selection from the DA Deal; and
* usage-window accounting.

Exit criteria:

* a local devnet can publish a batch through a DA Deal and issue
  `DA_CERT_FAST`.

### Phase 3: Retrieval, retention, and repair budgets

Deliverables:

* sponsored and requester-funded retrieval policy;
* retained-generation runway;
* repair budget usage;
* degradation/renewal state; and
* scale-up trigger plumbing.

Exit criteria:

* a local devnet can issue `DA_CERT_RETRIEVABLE`, serve retained reads, charge
  the correct budget class, and degrade retained service when funding expires.

### Phase 4: Integration adapters

Deliverables:

* OP Stack Alt-DA adapter prototype;
* Orbit/AnyTrust-style adapter sketch;
* generic verifier SDK; and
* proof-bundle export for external systems.

Exit criteria:

* one public-chain-shaped fixture can publish, certify, verify, retrieve, and
  reconstruct through the DA Deal path.

-----

## 14. Tests and Evidence

Required test categories:

* create/fund/update/query `DADealPolicy`;
* low-watermark and pause-watermark budget transitions;
* lane linkage authorization;
* publisher authorization;
* policy weakening cannot alter historical certificate facts;
* batch append charges publication budget;
* sample retrieval charges retrieval budget;
* retained service consumes retention budget;
* repair consumes repair budget;
* scale-up triggers only under policy; and
* public retrieval sponsorship is rate-limited.

Required evidence before production claims:

* target certificate latency by tier;
* disperser egress for representative batch sizes;
* per-slot provider-daemon ingress;
* retrieval throughput at 1, 10, and 50 concurrent readers;
* repair time after provider loss;
* provider count and diversity;
* projected runway by budget class; and
* bridge/verifier cost for the chosen external integration.

-----

## 15. Product Positioning

Canonical line:

> Launch a chain with a DA Deal: publish batches, receive availability
> certificates, and keep data retrievable for as long as the chain funds the
> Deal.

Technical line:

> Chain-Funded PolyStore DA Deals combine attestation-first Availability
> Certificates with native retained retrieval, repair, and provider elasticity.

Customer line:

> Your chain funds one DA Deal. PolyStore handles provider assignment,
> publication certificates, retained history, retrieval payments, and repair.

This is the right public posture: direct enough to be marketable, specific
enough to be defensible, and concrete enough to map to public chains.

-----

## 16. Open Questions

1. Should `DADealPolicy` embed full lane policy or reference separately
   versioned lane, quorum, sample, retrieval, repair, and scale-up policies?
2. Should each external chain get one lane or separate lanes for batches,
   proofs, state diffs, and metadata?
3. What low-watermark should pause new publication versus only disabling
   sponsored public retrieval?
4. Which external integration should be first: OP Stack Alt-DA, Orbit/AnyTrust,
   or generic verifier SDK?
5. How should public append-only writes be authorized and priced if a chain
   wants third parties to publish under the same DA Deal?
6. What is the minimum policy information an external verifier needs to bind a
   certificate to a specific chain-funded service contract?

-----

## 17. Recommendation

Adopt Chain-Funded DA Deals as the primary product and implementation framing
for PolyStore DA.

The golden path is:

1. sell retained DA and historical retrieval for existing public rollups;
2. implement DA Deal policy and funding;
3. issue `DA_CERT_FAST` through a DA Deal;
4. issue `DA_CERT_RETRIEVABLE` through publication-time samples;
5. prototype OP Stack Alt-DA and Orbit/AnyTrust-style integrations; and
6. keep sampling-first DAS as a separate research track until the formal model
   is strong enough.

This keeps PolyStore differentiated around the thing it can plausibly own:
availability certificates that are connected to durable retrieval, retained
history, repair, and an economically funded provider-daemon market.

-----

## 18. References

Local:

* `docs/polyfs-chain-funded-da-deals.md`
* `docs/chain-funded-da-deal-policy-fixtures.md`
* `rfcs/rfc-polyfs-da-lanes.md`
* `rfcs/rfc-pricing-and-escrow-accounting.md`
* `rfcs/rfc-retrieval-access-control-public-deals-and-vouchers.md`
* `rfcs/rfc-mandatory-retrieval-sessions-and-batching.md`
* `rfcs/rfc-polyfs-generation-cas-and-staged-writes.md`

External:

* OP Stack Alt-DA docs:
  `https://docs.optimism.io/op-stack/features/experimental/alt-da-mode`
* OP Stack Alt-DA spec:
  `https://specs.optimism.io/experimental/alt-da.html`
* Arbitrum AnyTrust protocol:
  `https://docs.arbitrum.io/how-arbitrum-works/deep-dives/anytrust-protocol`
* EigenDA overview:
  `https://docs.eigencloud.xyz/eigenda/core-concepts/overview`
* Blobscan API docs:
  `https://docs.blobscan.com/docs/api`

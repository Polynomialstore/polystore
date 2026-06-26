# Historical DA Archival and Retrieval Market Note

Last updated: 2026-06-25

Status: strategy note, not a protocol RFC.

## Thesis

Historical DA archival and retrieval is an emerging category, but it is not yet
named consistently. The market currently describes the same need through
fragmented labels: blob archives, rollup archive APIs, DA retrievability,
archival nodes, long-term DA, rollup derivation history, indexer storage, and
data-availability analytics.

PolyStore should treat this as a near-term product wedge:

**DA layers prove that data was published in the availability window. PolyStore
can prove that the same data remains retrievable later, under explicit payment,
proof, repair, and accountability rules.**

This is not a claim that PolyStore is already a Celestia-style consensus DA
layer. It is a stronger and cleaner claim for the current system: PolyStore can
be the durable archive and retrieval market for data that DA layers intentionally
do not promise to keep forever.

## Market Status

This is a real market need, but it is still pre-category.

Demand is visible in four places:

1. Rollups need old batch data to derive chain state, bootstrap new full nodes,
   support disaster recovery, and investigate fraud or bridge incidents.
2. Explorers, indexers, auditors, and analytics teams need historical blob or
   namespace data after the base DA window expires.
3. DA layers increasingly separate near-term availability from permanent
   retrievability, which pushes long-term storage responsibility to applications
   and third-party infrastructure.
4. Existing solutions are often centralized archives, volunteer archival nodes,
   internal S3/R2 buckets, snapshots, or specialized archiver APIs.

The category is underdeveloped because the pain is delayed. DA cost is visible
immediately in rollup operations, but archival failure usually appears later:
when a new node cannot sync, an explorer is missing history, a bridge/security
incident needs historical data, or a team migrates infrastructure. This delays
budget ownership and lets teams treat archival as an ops chore instead of a
first-class protocol dependency.

The absence of a clean category is not primarily a feasibility signal. It is a
market-education and packaging gap. The technical need is acknowledged by
Ethereum, Celestia, Blobscan, EthStorage, EigenDA, and rollup operators in
different terms, but the buyer has not yet converged on one product phrase.

## Why The Gap Exists

Modern DA systems are deliberately temporary or windowed.

- Ethereum EIP-4844 introduced blob-carrying transactions whose data can be
  deleted by consensus nodes after a short delay; the EIP parameterizes the
  minimum sidecar request window at 4096 epochs. Ethereum.org describes blob DA
  as non-permanent and distinguishes data availability from data retrievability.
- Celestia documentation explicitly says DA layers do not inherently guarantee
  that historical data will remain permanently stored and retrievable. Celestia
  v6 introduced a seven-day light-node sampling window; older blobs may be
  served by archival nodes, but rollups are told not to rely on free public
  archival service as their only historical access path.
- EthStorage directly markets a rollup archiver path for expired Ethereum blobs,
  which is strong evidence that the problem is legible to rollup teams.
- Blobscan exists because Ethereum blobs need explorer, indexer, and storage
  infrastructure. Its architecture includes a blob storage manager and parallel
  upload to storage services, and its own writing frames indefinite blob archival
  as a growing sustainability problem.
- EigenDA separates dispersal, validator custody, and retrieval-node recovery;
  this confirms that retrieval is a distinct operational surface inside DA
  systems, even when the base product is sold as DA throughput.

The important product lesson: the DA layer's job is to make data available at
publication time. The archive/retrieval layer's job is to make historical data
findable, verifiable, durable, and economically served after the DA layer's
native guarantees end.

## PolyStore Fit

PolyStore already has unusually good primitives for this market:

- **Committed generations:** a Deal generation gives historical data a pinned
  root, so retrieval can target immutable snapshots rather than a floating
  "current archive."
- **PolyFS path and index structure:** archived DA data can be organized by
  chain, namespace, block height, batch ID, blob hash, versioned hash, or rollup
  derivation segment.
- **Triple Proof and byte-level verification:** served bytes can be proven back
  to the committed PolyFS root, which gives archive users a verification story
  beyond "trust this API response."
- **Striped retrieval and reconstructability:** RS-coded slot storage makes
  reads robust to provider failures and lets retrieval fan out across providers.
- **Paid retrieval sessions:** PolyStore can make archival service economically
  explicit instead of depending on altruistic archival nodes or opaque SaaS
  margins.
- **Sponsored public retrieval:** public deals can let third parties pay for
  reads without draining the deal owner's escrow.
- **Synthetic retrieval:** the protocol can act as the user of last resort for
  cold data, turning periodic reads into liveness evidence.
- **Healing and provider rotation:** long-lived archives need repair semantics,
  not just one-time upload semantics.

This is a better fit than generic "decentralized storage" positioning because
DA archival has a natural verification anchor. For Ethereum blobs, the external
anchor is a versioned hash / KZG commitment. For Celestia, it is namespace and
block commitment structure. For EigenDA-style systems, it is a blob commitment
or certificate path. PolyStore can store the bytes and expose the mapping back
to those native anchors.

## Product Shape

A credible first product should be called something like:

- PolyStore DA Archive
- PolyStore Blob Archive
- PolyStore Rollup History Market
- PolyStore Historical DA Retrieval

Avoid "DA layer" as the lead phrase for this product. It invites the wrong
comparison. The better wedge is:

**Durable, paid, verifiable retrieval for data that DA layers stop serving.**

Minimum product surface:

1. **Archive ingestion**
   - Ethereum blob ingestion by block range, transaction, versioned hash, or
     rollup batch source.
   - Celestia namespace ingestion by height range and namespace.
   - Generic adapter for DA providers that can export blob commitments and raw
     payloads.
2. **Canonical index**
   - Map external identifiers to PolyStore file paths and Deal generations.
   - Store source-chain metadata beside the archived bytes.
   - Expose coverage status and gaps.
3. **Verifiable retrieval API**
   - Retrieve by external ID, not only by PolyStore-internal path.
   - Return PolyStore proof metadata plus the external DA commitment metadata
     needed to verify origin.
4. **Coverage and SLA dashboard**
   - Show archived ranges, missing ranges, retrieval success, latency,
     provider health, and repair status.
5. **Economic modes**
   - Owner-funded archive for a rollup team.
   - Public archive where anyone can pay retrieval fees.
   - Sponsored/free-read archive where a foundation, rollup, or explorer funds
     retrieval for users.

## Buyers

Likely early buyers:

- Rollup teams that need reliable derivation history and disaster recovery.
- RaaS providers that operate many rollups and want one archival backend.
- Explorers and indexers that need expired blob/namespace data.
- Bridges, auditors, incident-response teams, and forensics providers.
- DA layers that want an ecosystem answer for "what happens after the DA
  window?"
- Foundations funding public goods archives for their ecosystem.

The first buyer is probably not an end user. It is an operator with an explicit
cost-of-failure: a rollup, RaaS provider, explorer, or infrastructure team.

## Competitor Landscape

### EthStorage: closest named competitor

EthStorage is the closest public competitor for this wedge because it already
uses the language that the market is converging toward: long-term DA, expired
blob retrieval, rollup derivation history, and Ethereum-native archival.

EthStorage's rollup pitch is direct:

- An OP Stack rollup replaces or wraps the batch inbox so blob-carrying
  transactions can also pay the EthStorage storage contract.
- EthStorage nodes retain the blob data beyond Ethereum's native blob window.
- The rollup or node operator can later use an es-node archiver API as a
  fallback resource alongside the normal beacon API.
- The archiver API mirrors the beacon endpoint shape
  `/eth/v1/beacon/blobs/{block_id}`, with optional filtering by versioned hash.

Its broader product is a programmable storage L2 for Ethereum:

- data is written as EIP-4844 blobs and referenced by a key-value interface;
- L1 contracts handle fees and proof verification;
- es-nodes store replicas off chain and submit proof-of-storage work over time;
- the developer surface is EVM-native, with Solidity, Foundry, ETH payments,
  SDKs, FlatDirectory-style file tooling, and web3:// access;
- the narrative is "pay once, store long term / permanently."

Strengths:

- **Clear wedge:** EthStorage talks directly to rollups that need expired blob
  retrieval. That makes them the category-shaping competitor to watch.
- **Ethereum-native buyer path:** ETH fees, L1 contracts, EVM tooling, and an
  OP Stack tutorial reduce adoption friction for Ethereum rollups.
- **API compatibility:** returning blob data through a beacon-like endpoint is
  exactly what rollup node software wants for fallback blob retrieval.
- **Protocol credibility:** the design includes storage-provider incentives,
  proof-of-storage, and on-chain verification rather than only an S3 archive.
- **Narrative clarity:** "EIP-4844 made blobs cheap but temporary; EthStorage
  makes them durable" is easy to understand.

Weaknesses or open questions:

- **Ethereum-first scope:** the product is strongest when the buyer already
  wants Ethereum-native contracts and OP Stack blob fallback. That leaves room
  for a cross-DA archival layer covering Celestia namespaces, EigenDA blobs,
  Avail blocks, and other future DA sources under one retrieval market.
- **Retrieval accountability is less central:** EthStorage's public materials
  emphasize storage proofs and long-term retention. PolyStore can make paid
  retrieval completion, serving attribution, requester funding, sponsored
  public reads, and retrieval SLAs the product center.
- **Archive indexing is still a product surface:** an API compatible with
  beacon blob lookup is useful, but rollup operators also need coverage maps,
  gaps, source-chain metadata, derivation-batch mapping, and incident-response
  workflows.
- **Perpetual economics need buyer diligence:** one-time permanent-storage
  narratives are attractive, but rollup teams will still ask who is accountable
  when reads fail, how repair is funded, what latency is expected, and how fees
  adapt if data volume grows faster than modeled.
- **Early network assumptions matter:** if provider participation is still
  controlled, staged, or uneven, customers may treat EthStorage as promising but
  not yet a neutral archival market.

PolyStore should not dismiss EthStorage. It should use EthStorage as proof that
the category exists and then position against the parts EthStorage does not make
central:

1. **Multi-DA archival:** not only Ethereum blobs.
2. **Paid retrieval as the primitive:** every important read is a session with a
   payer, proof boundary, completion semantics, and provider accountability.
3. **Public retrieval markets:** anyone can pay to retrieve public data without
   draining the archive owner's escrow.
4. **External-commitment mapping:** store DA bytes and expose verification
   metadata back to Ethereum versioned hashes, Celestia namespace roots,
   EigenDA commitments, or other source-native anchors.
5. **Operational archive product:** coverage, gaps, repair, latency, hot/cold
   routing, and audit evidence are first-class product outputs.

The clean founder-level positioning is:

**EthStorage is trying to make Ethereum blobs permanent. PolyStore should make
historical DA retrieval accountable across DA ecosystems.**

### Rollup-native blob archivers

OP Stack and Arbitrum documentation make the need concrete. OP Stack node
operators need blob-archiver fallback endpoints when syncing from a snapshot or
genesis older than the blob retention window, or after being offline longer than
the window. Arbitrum similarly tells node operators they need an Ethereum beacon
chain node with historical blob data or a third-party provider that supports it.

Base's open-source `blob-archiver` is a canonical example of the pragmatic
incumbent:

- it tracks the beacon chain;
- writes blobs to file or S3-compatible storage;
- exposes the blob sidecars API for retrieval;
- explicitly notes that the archiver/API currently do not validate beacon-node
  data, so operators must trust the beacon node or validate client-side.

This competitor category is operationally important but weak as a protocol
category. It proves that rollup software wants a beacon-compatible historical
blob endpoint. It does not by itself provide decentralized custody, paid
retrieval settlement, repair incentives, cross-DA indexing, or market-wide
accountability.

### Explorer and indexer archives

Blobscan and The Graph validate demand from the explorer, analytics, and data
infrastructure side.

Blobscan is an EIP-4844 blob explorer with indexer, API, frontend, storage
manager, and background upload jobs. It is closer to a public-good explorer plus
archive than a storage protocol. Its value is discoverability, indexing, and
historical visibility.

The Graph frames blobs as an indexing problem: blobs expire, developers need
access after expiry, and Firehose/Substreams can extract, transform, store, and
query blob data. This is a strong data-product competitor, especially for
analytics and structured querying, but it is not primarily a storage-deal and
retrieval-settlement protocol.

PolyStore should view these as potential partners and customers as much as
competitors. Blobscan-like and Graph-like systems need durable backing storage,
coverage guarantees, and retrieval economics. PolyStore can provide the archive
substrate while they own discovery, query semantics, and user-facing analytics.

### DA-native archival paths

Celestia, Avail, EigenDA, Ethereum clients, and similar systems have native or
ecosystem-specific answers for historical access:

- Celestia docs say historical data may be retrievable from archival nodes and
  tell rollups not to rely only on free public archival service; they point
  toward professional archival providers for better guarantees.
- Avail has discussed archival mode and future pruning, leaving room for
  dedicated long-term block-data storage.
- EigenDA includes retrieval nodes in its architecture and separates dispersal,
  validator custody, and retrieval, but its primary product is DA throughput and
  attestations, not permanent cross-DA archival.
- Ethereum's own client ecosystem is moving toward history pruning while trying
  to preserve old data in explicit archive formats and services.

These paths have ecosystem alignment and can be the first place a buyer looks.
Their limitation is fragmentation. Each DA ecosystem may provide a different
archival mode, provider list, API, retention model, and trust assumption. A
cross-DA archive product can win when buyers operate multiple rollups, multiple
DA providers, or want one contract and retrieval market for historical data.

### Centralized APIs and internal archives

Centralized APIs validate urgency and simplify integration. Blocknative's Blob
Archive API, provider-hosted historical blob endpoints, rollup-team S3/R2/GCS
buckets, and internal snapshots are the practical default today.

The weakness is not that they fail to work. The weakness is that they create
vendor, team, or foundation dependency for data that should remain verifiable
and recoverable for years. Blocknative's June 19, 2026 service-winddown notice is
a useful market signal: even useful infrastructure can disappear or force
migrations.

Most rollup teams can also use S3, R2, GCS, or snapshots. That is the practical
incumbent. PolyStore needs to beat this path on verifiability, public
retrieval, durability incentives, and multi-provider accountability, not on
basic object-storage convenience.

### Permanent storage networks

Filecoin, Arweave, Walrus, IPFS pinning providers, and WeaveVM-like archival
integrations can all store bytes and may compete for the same budget.

- Filecoin has mature storage and retrieval-deal concepts, cryptographic
  storage proofs, and large storage-supply branding.
- Arweave has the strongest permanent-storage narrative and a one-time payment
  / endowment model.
- Walrus is a modern blob-storage network with erasure coding, availability
  proofs, Sui coordination, and explicit discussion of read-access incentives.
- WeaveVM's EigenDA integration is a direct example of "temporary DA plus
  permanent archive" thinking, using a modified EigenDA sidecar proxy to push
  blobs into WeaveVM/Arweave.

These systems are important substitutes, but most are not DA-aware products out
of the box. They usually do not provide source-native rollup derivation indexes,
beacon-compatible fallback APIs, Celestia namespace coverage maps, or paid
retrieval sessions tied to DA identifiers. PolyStore can use them as comparison
points while keeping the product narrower: historical DA data, verifiable
retrieval, and accountable service.

### Comparison Matrix

| Project / path | Category | Strongest buyer promise | Strategic weakness for this wedge | PolyStore response |
|---|---|---|---|---|
| EthStorage | Ethereum-native long-term DA / storage L2 | Keep Ethereum blobs retrievable after expiry through an EVM-native storage network and archiver API | Ethereum-first; retrieval settlement and cross-DA archival are not the center of the pitch | Compete on multi-DA coverage, paid retrieval sessions, public retrieval markets, and operational archive dashboards |
| Base blob-archiver / no-prune beacon nodes | Rollup ops tooling | Beacon-compatible historical blob fallback endpoint | Usually centralized or self-operated; no storage market, repair market, or proof-of-retrieval layer | Offer the same retrieval compatibility but backed by decentralized custody and accountable sessions |
| Blobscan | Explorer / indexer / public archive | Find, browse, and preserve Ethereum blob history | Discovery-first, not a generalized storage-and-retrieval market | Partner or compete as the verifiable archive backend for explorers |
| The Graph / Firehose / Substreams | Data indexing and query | Transform and query blob data at scale after expiry | Query/indexing-first; storage durability and paid retrieval are not the only product | Integrate as storage substrate; let Graph-like systems own transformed data products |
| Celestia archival providers | DA-native archival nodes | Historical namespace data from Celestia ecosystem providers | Ecosystem-specific, provider-specific, and often outside explicit retrieval settlement | Offer customer-owned Celestia namespace archives with paid public retrieval |
| EigenDA | DA protocol | High-throughput DA attestations and retrieval flow for rollups | Primarily availability-window DA, not long-term archive product | Archive EigenDA blobs/certificates after the native service window and expose retrieval proofs |
| Filecoin | Decentralized storage market | Large-scale storage with proofs and retrieval deals | Generic storage substrate; not DA-indexed by default | Use DA-specific ingestion, indexing, and retrieval-accounting to avoid generic-storage competition |
| Arweave / WeaveVM | Permanent storage | Pay once for permanent data availability | Permanent-storage narrative can be expensive or rigid; DA mapping is integration-specific | Offer storage-duration choice, repair economics, and source-native DA lookup |
| Walrus | Blob storage and availability | Erasure-coded blob storage with proof of availability and Sui coordination | Read incentives and DA-specific archival products are still separate surfaces | Emphasize paid retrieval completion and rollup/DA-specific archive APIs |
| S3/R2/GCS/internal snapshots | Centralized object storage | Cheap, familiar, operationally simple | Centralized custody, weak public verification, vendor/team dependency | Do not fight on basic storage; win on verifiability, decentralized custody, public reads, and auditability |

### Competitive Diligence Checklist

EthStorage diligence:

- Can a normal OP Stack node use an EthStorage archiver endpoint as a fallback
  with no client patch, or does the integration require a custom batch inbox and
  deployment-specific assumptions?
- Does the archiver API return enough metadata for independent verification, or
  only the blob content needed by OP Stack derivation?
- How does a customer see coverage and gaps by block, slot, transaction, rollup,
  and versioned hash?
- What is the current fee model for a rollup-sized archive, and how does it
  change if blob throughput keeps increasing?
- How permissionless is provider participation in practice today?
- What happens when a retrieval fails: who is accountable, what evidence exists,
  and how is repair triggered?
- Can the same product support Celestia namespace data, EigenDA blobs, Avail
  blocks, and non-Ethereum DA sources without losing its Ethereum-native
  advantages?

Rollup-archiver diligence:

- Run Base's `blob-archiver` with file storage and S3-compatible storage.
- Confirm exactly which Beacon API endpoints it implements.
- Confirm whether client-side validation is enough for the buyer or whether a
  verifiable storage/retrieval layer is required.
- Measure storage cost and operational burden for one high-volume rollup over
  30, 90, and 365 days.

Explorer/indexer diligence:

- Compare Blobscan, The Graph, Dune-style dashboards, and internal rollup
  indexers by API surface: raw blob retrieval, structured query, provenance,
  coverage reporting, and export.
- Identify which of these systems want to own storage themselves and which would
  prefer a durable archive backend.

Permanent-storage diligence:

- Price a rollup archive on Filecoin, Arweave, Walrus, and S3/R2 as neutral
  baselines.
- Compare retrieval latency and read incentives, not just storage cost.
- Check whether DA identifiers can be preserved as first-class lookup keys
  without custom glue.

## Market Research Plan

### 1. Build the desk-research map

Collect sources by phrase family:

- "blob archive", "blob archiver API", "expired blobs"
- "data retrievability", "historical DA", "DA pruning"
- "rollup derivation history", "rollup full node sync blobs"
- "Celestia archival node", "namespace historical data"
- "EigenDA retrieval node", "Avail archive node"
- "long-term DA", "permanent DA", "rollup archive"

For each source, tag:

- buyer named or implied,
- data source supported,
- retention window,
- retrieval API,
- verification story,
- pricing or funding model,
- decentralization/trust assumption,
- operational risk.

### 2. Interview buyers before overbuilding

Target 12-20 calls:

- 4 rollup/RaaS operators,
- 3 explorer/indexer teams,
- 3 DA provider ecosystem teams,
- 2 bridge/security/audit teams,
- 2 infra providers that already run archive nodes,
- 2 foundations or ecosystem public-goods funders.

Core questions:

- Where do historical DA bytes live today?
- Who owns the bill?
- What happens if that archive disappears?
- What identifiers do you need to retrieve by?
- What proof do you require that bytes match the original DA publication?
- What retention period matters: 90 days, 1 year, 7 years, forever?
- How often is the data read after the first month?
- What latency is acceptable for cold historical reads?
- Would you pay per stored byte, per retrieved byte, or by coverage/SLA?
- Would public third-party paid retrieval be useful?

### 3. Run a narrow data probe

Pick one public target, preferably Ethereum blobs for a specific rollup or a
small Celestia namespace set.

Measure:

- ingest volume per day,
- uncompressed/compressed size,
- duplicate rate,
- object count and indexing complexity,
- cost under S3/R2/Filecoin/Arweave-like assumptions,
- expected PolyStore slot overhead,
- retrieval frequency scenarios,
- minimum viable coverage dashboard.

This turns the market conversation from abstract "archive DA" into a costed
product.

### 4. Produce a competitor matrix

Columns:

- project/service,
- supported DA source,
- retention promise,
- retrieval API,
- proof/verification model,
- decentralization and custody model,
- pricing/funding,
- operational maturity,
- gaps PolyStore could exploit.

### 5. Decide the first wedge

Recommended first wedge:

**Ethereum blob archival for rollup derivation history, with verifiable paid
retrieval and public coverage reporting.**

Reasons:

- Ethereum blob expiry is widely understood.
- Rollups have obvious operational need.
- Blob identifiers and commitments give a clear verification anchor.
- Public datasets make demos easier.
- Existing archivers validate the category without fully owning the
  decentralized accountability narrative.

Second wedge:

**Celestia namespace archival for app-specific historical data.**

Reasons:

- Celestia docs explicitly put long-term historical storage responsibility on
  rollups/apps.
- Namespace-level retrieval maps naturally to customer-owned archives.
- PolyStore can present itself as a complementary storage/retrieval layer, not
  a direct DA competitor.

## Positioning

Good:

- "Durable retrieval for ephemeral DA."
- "A paid retrieval market for historical DA data."
- "Keep rollup history verifiable after blob expiry."
- "DA with a memory layer."
- "A decentralized archive for rollup derivation data."

Avoid:

- "We are a better Celestia" for this product.
- "PolyStore is DA" unless discussing a separate research track.
- "Permanent DA" unless the exact retention and repair economics are specified.
- "Free archive" unless a sponsor budget is explicit.

The most defensible category phrase is:

**Historical DA retrieval infrastructure.**

It is broad enough to cover Ethereum blobs, Celestia namespaces, EigenDA blobs,
Avail blocks, and future DA systems, while still being specific enough to avoid
generic decentralized-storage positioning.

## Open Product Questions

- Should the archive be organized primarily by external DA identifiers or by
  PolyFS paths with external IDs as secondary metadata?
- Should PolyStore provide the indexer itself, or only the storage/retrieval
  substrate plus reference indexers?
- Should the first version be a public-good archive or a customer-owned archive
  for one design partner?
- How much retrieval latency is acceptable for cold rollup derivation history?
- Does the buyer care more about proof of storage, proof of retrieval, or
  coverage reporting?
- Which external commitment checks must be first-class in the API?
- Can sponsored retrieval become a visible differentiator for explorers and
  public datasets?

## Source Pointers

- Ethereum.org, "Data availability": distinguishes data availability from data
  retrievability and says blob DA is not permanent storage.
  https://ethereum.org/developers/docs/data-availability/
- EIP-4844: defines blob-carrying transactions and the 4096-epoch sidecar
  request parameter.
  https://eips.ethereum.org/EIPS/eip-4844
- Celestia docs, "Data retrievability and pruning": says DA publication does
  not inherently guarantee permanent historical retrievability and that rollups
  are responsible for historical storage.
  https://docs.celestia.org/learn/celestia-101/retrievability/
- EthStorage Rollup Guide: positions long-term blob retrieval for expired L1
  blobs as a rollup need and documents a beacon-like archiver API.
  https://docs.ethstorage.io/rollup-guide
- EthStorage overview / how-it-works / provider docs: describe EthStorage as a
  decentralized storage L2 powered by DA, with storage-provider proof and reward
  flow.
  https://docs.ethstorage.io/
  https://docs.ethstorage.io/readme/how-ethstorage-works
  https://docs.ethstorage.io/storage-provider-guide
- EthStorage storage contracts: describe L1 fee distribution, storage-proof
  verification, EIP-4844 blob uploads, and key-value storage.
  https://github.com/ethstorage/storage-contracts-v1
- EthStorage Mainnet Alpha post: describes Ethereum-native integration,
  proof-of-storage, BLOB P2P sync, and provider incentive narrative.
  https://blog.ethstorage.io/ethstorage-mainnet-alpha-launch-petabyte-scale-decentralized-storage-on-ethereum/
- Optimism docs, "Using blobs": explains when OP Stack operators need blob
  archiver fallbacks and names no-prune beacon nodes, dedicated blob archivers,
  and third-party archiver services as options.
  https://docs.optimism.io/node-operators/guides/management/blobs
- Arbitrum docs, "Historical blobs": says node operators need beacon-chain
  historical blob access or a provider with historical-blob support.
  https://docs.arbitrum.io/run-arbitrum-node/beacon-nodes-historical-blobs
- Base `blob-archiver`: open-source beacon blob archiver using file or
  S3-compatible backends, with a note that beacon-node data is not currently
  validated by the archiver/API.
  https://github.com/base/blob-archiver
- Blobscan docs: describes blob explorer/indexer/storage-manager architecture.
  https://docs.blobscan.com/
- Blobscan, "The Cost of Archiving Ethereum's Blob Data": frames indefinite
  blob archival as a growing sustainability problem.
  https://paragraph.com/@blobscan/blobscan-the-cost-of-archiving-ethereums-blob-data
- The Graph, "Saving the Blobs": describes long-term blob storage/retrieval and
  Firehose/Substreams-based blob indexing.
  https://thegraph.com/blog/eip-4844-blobs-data/
- Avail RFP-003 discussion: notes archival mode and future pruning expectations.
  https://forum.availproject.org/t/discussion-rfp-003-long-term-block-data-storage/619
- EigenDA overview/spec: separates dispersal, validator custody, retrieval, and
  erasure-coded shard verification.
  https://docs.eigencloud.xyz/eigenda/core-concepts/overview
  https://layr-labs.github.io/eigenda/
- Filecoin storage/retrieval deal overview: describes storage deals, retrieval
  deals, proofs, and slashing for failed storage commitments.
  https://www.filecoin.io/blog/how-storage-and-retrieval-deals-work-on-filecoin
- Arweave endowment explainer: describes one-time payment and endowment logic
  for permanent storage incentives.
  https://www.arweave.com/blog/endowment-with-arweave
- Walrus docs and paper: describe erasure-coded blob storage, availability
  proofs, and read-incentive tradeoffs.
  https://docs.wal.app/
  https://docs.wal.app/walrus.pdf
- WeaveVM x EigenDA: describes a proof-of-concept permanent archive layer for
  EigenDA blobs using a modified sidecar proxy.
  https://blog.wvm.dev/eigenda-weavevm/
- Alchemy listing for Blocknative Blob Archive API: describes versioned-hash blob
  retrieval and returned metadata.
  https://www.alchemy.com/dapps/blob-archive
- Blocknative service-winddown notice: says services remain available through
  June 19, 2026 and then API requests will stop receiving responses.
  https://www.blocknative.com/
- Blocknative service winddown notice: useful signal for centralized archive
  API dependency risk.
  https://www.blocknative.com/

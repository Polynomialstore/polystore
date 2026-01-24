# Side Project: Public Data Explorer (Reference Implementation Spec)

Last updated: 2026-01-23

Goal: provide a community-buildable reference that indexes **public deals** and hosts their metadata (NilFS) so many users can discover and pay to retrieve public datasets.

This is intentionally scoped so an independent contributor can implement it without privileged access.

---

## 1) What the explorer does

1) **Index public deals**
   - Query chain state for deals where `retrieval_policy == PUBLIC`
   - Store minimal deal metadata:
     - deal_id, owner, manifest_root, size_bytes, end_block, created_at, etc.

2) **Fetch metadata MDUs**
   - For each deal, pay to retrieve MDU #0 (and witness MDUs as required) via a sponsored session open:
     - `MsgOpenRetrievalSessionSponsored`
   - Download bytes using `X-Nil-Session-Id`

3) **Parse NilFS file table**
   - Extract file list, paths, sizes, and any metadata.
   - Store in DB for fast browsing.

4) **Serve a public API + UI**
   - `/deals`
   - `/deals/:id`
   - `/deals/:id/files`
   - optional: `/deals/:id/files/:path/download` that routes users to open their own sponsored sessions.

---

## 2) Architecture (minimal)

- **Indexer** (cron / worker)
  - connects to chain RPC
  - scans new deals (events or `QueryPublicDeals`)
  - schedules metadata fetch jobs

- **Retrieval worker**
  - opens sponsored sessions (funded by:
    - the explorer operator, OR
    - the end user via MetaMask)
  - fetches MDU #0
  - parses NilFS
  - writes DB rows

- **API server**
  - read-only metadata endpoints

- **UI**
  - browse public deals
  - view files
  - initiate “Pay to retrieve” (client-side tx + download)

---

## 3) Funding models

### A) Operator-sponsored metadata
Explorer pays to fetch and host metadata proactively.  
Pros: fast browsing.  
Cons: operator bears cost.

### B) User-sponsored metadata (default-friendly)
Explorer shows deals list from chain, but fetches metadata only when a user requests it and pays.  
Pros: no operator subsidy.  
Cons: metadata appears on demand.

NilStore’s sponsored session open semantics ensure the explorer or users can pay without draining deal owner escrow.

---

## 4) Required chain features

Minimum:
- Deal query returns `retrieval_policy` fields.
- Retrieval sessions are mandatory for served bytes (already required).

Recommended:
- `QueryPublicDeals` (paginated) to avoid scanning all deals.
- Events:
  - Deal created
  - Retrieval policy updated

---

## 5) Security notes

- Public deals are not private. The explorer should display this clearly.
- The explorer should rate-limit metadata fetching to avoid accidental self-DoS.
- Use the session + batching RFC: metadata fetches can retrieve multiple blobs/MDUs per session.


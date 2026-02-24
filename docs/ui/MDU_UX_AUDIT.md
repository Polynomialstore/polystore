# MDU UX Audit (User-Facing Representation)

Date: 2026-02-24  
Repo: `nil-store-ux`  
Scope: user-visible MDU concepts across the website (`nil-website`) and desktop GUI (`nil_gateway_gui`).

## Why this matters

MDUs are not just an internal implementation detail — they are the product’s *verifiability unit*, *throughput unit*, and (in Mode 2) the bridge between “normal files” and a striped, self-healing storage market. Treating MDUs as a first-class UX object is a direct lever for:

- User trust (“what exactly is stored and verified?”)
- Troubleshooting (“why did my upload/download behave this way?”)
- Marketing (“verifiable striping and shared-nothing verification” are differentiators)

## Terminology (current + recommended)

Today, the UI uses a mix of: “Data Units (DUs)”, “Mega-Data Units (MDUs)”, “blobs”, “manifest root”, “witness”, “meta”.

Recommended stable, user-facing baseline:

- **Blob (128 KiB)**: atomic KZG unit (commitment + receipt granularity).
- **MDU (8 MiB)**: 64 blobs; the slab/service unit users reason about (“chunks”).
- **MDU #0 (NilFS Super-Manifest)**: file table + root table.
- **Witness MDUs**: commitment cache/acceleration structure.
- **User MDUs**: data-bearing MDUs (file bytes packed into NilFS).
- **Mode 2 slot shard**: the per-provider share of an MDU (`8 MiB / K` bytes) plus parity shards (conceptually).

If “DU” remains in copy, explicitly alias it to MDU (“DU (aka MDU)”) and phase it out.

## Inventory: where MDUs show up today

### Website: interactive UX (dashboard + explorer)

1) **Upload / sharding UI (“Manifest Visualization”)**
- `nil-website/src/components/FileSharder.tsx`
  - Shows: “MDUs expanded” grid, each tile labeled `#<id>` and `8MiB`.
  - Tracks: `totalUserMdus`, `totalWitnessMdus`, “1 meta”.
  - Mode 2 copy: “Upload Stripes (Mode 2)” vs Mode 1 “Upload N MDUs to SP”.
  - Gap: MDU tiles don’t explain *type* (MDU #0 vs witness vs user) and always render as “8MiB” even when it’s metadata; commitments shown are truncated and not contextualized.

2) **Deal Explorer → “Manifest & MDUs” tab**
- `nil-website/src/components/DealDetail.tsx`
  - Shows:
    - Slab layout summary: total MDUs and breakdown (MDU #0 / witness / user).
    - Segmented layout bar (`mdu0`, `witness`, `user`).
    - NilFS summary (“files”, “records”).
    - A per-MDU inspector: select `MDU #n` and load commitments; shows:
      - MDU root (Merkle root over commitments)
      - blob commitment count
      - stripe layout grid (Mode 2 visual)
  - Gap:
    - No “file → MDU range” mapping surfaced (which MDUs does `video.mp4` occupy?).
    - The stripe grid is a good start, but it mixes “data blob” and “parity shard” semantics without connecting to *providers/slots* for this specific deal.
    - The “MDU commitments” view does not bridge to retrieval behavior (range planning, receipts, per-blob proofs).

3) **First-time onboarding flow**
- `nil-website/src/pages/FirstFile.tsx`
  - Shows: `total_mdus` and `witness_mdus` returned from upload; high-level retrieval progress.
  - Gap: Doesn’t explain *why* witness MDUs exist, how they scale with deal size, or how retrieval chunks map to blobs/MDUs.

### Website: education / marketing pages

4) **How NilStore Works (Technology deep dives)**
- `nil-website/src/pages/Technology.tsx`
- `nil-website/src/pages/ShardingDeepDive.tsx`
- `nil-website/src/pages/KZGDeepDive.tsx`
  - Strengths:
    - Correctly introduces 8 MiB MDUs + 128 KiB blobs.
    - Clearly narrates the “3-hop” verification chain conceptually.
    - Mentions replicated metadata (“MDU #0 + Witness”).
  - Gaps:
    - “DUs” vs “MDUs” naming is inconsistent and risks confusing readers.
    - Does not connect the deep-dive diagrams to the live Deal Explorer (“go inspect MDU #0 / witness / blob commitments”).

5) **Security / Threat model**
- `nil-website/src/pages/Security.tsx`
  - Strength: explicitly calls out **MDU #0 Super-Manifest** + Witness MDUs + user MDUs.
  - Gap: does not teach practical “what I will see in the UI” artifacts (manifest root, slab segments, why witness count matters).

6) **S3 adapter docs**
- `nil-website/src/pages/S3AdapterDocs.tsx`
  - Shows: “file split into 8 MiB MDUs” → manifest root.
  - Gap: no concrete example of MDU counts / witness overhead / retrieval receipts for a real file size.

7) **FAQ**
- `nil-website/src/pages/FAQ.tsx`
  - Contains a short MDU definition.
  - Gap: doesn’t point users to the Deal Explorer’s MDU tools.

### Desktop GUI app (Tauri): local gateway UI

8) **Nil Gateway GUI**
- `nil_gateway_gui/src/App.tsx`
  - Today: user sees manifest root, can list files, and download files.
  - Gap: there is effectively **no MDU visibility** (no slab layout, no MDU #0/witness/user breakdown, no commitments, no “this download will generate N receipts”).

## Key UX gaps (what users can’t currently see)

1) **File ↔ MDU mapping**
- Users can’t answer: “Which MDUs does this file occupy?” or “Why did a small append allocate a whole new MDU?”

2) **NilFS artifacts**
- MDU #0 is conceptually important (filesystem on slab), but the UI doesn’t surface:
  - file record limits/path truncation implications
  - tombstones and reuse behavior (why “allocated length” changes or stays stable)

3) **Witness MDUs: purpose + impact**
- Witness MDUs appear as a number, but users can’t see:
  - why witness grows with deal sizing
  - how witness accelerates proofs / retrieval

4) **Retrieval behavior at blob/MDU granularity**
- The fetch UX does not make it obvious that:
  - receipts are blob-granular
  - range chunking is blob-aligned
  - one “download a file” may correspond to many proof submissions

5) **Mode 2: slot + shard reality**
- The UI can show stripe math, but not:
  - “which provider is slot 0/1/2… for this deal?”
  - “how many bytes per slot shard for this file?”
  - “which shard(s) were fetched from which provider on the last retrieval?”

## Recommendations (prioritized)

### A) Quick wins (copy + labeling)

- Make MDU tiles in `FileSharder` label type and index:
  - `MDU #0 (NilFS)` / `Witness #i` / `User #i` (instead of always “8MiB”).
- Standardize copy on **MDU** (avoid “DU” except as a legacy alias).
- Add tooltips in “Manifest & MDUs” to define:
  - manifest root (KZG), MDU root (Merkle), blob commitment (KZG)

### B) “MDU Inspector” as a first-class UX feature (education + debugging)

In Deal Explorer, add an MDU-centric view that answers:

- **Slab overview:** `total_mdus`, witness count, user MDU count, overhead.
- **File occupancy:** each file → MDU range(s) + offsets; highlight shared MDUs.
- **MDU drill-down:** for an MDU:
  - commitments summary (already exists)
  - show “blob count, blob size, expected receipts if fetched fully”
  - show “slot shards” for Mode 2 (bytes per slot, parity)

### C) Retrieval transparency (“what just happened?”)

After a file download, persist a short “retrieval trace” summary:

- session id (if any)
- route (gateway/direct/libp2p)
- blob range fetched (global blob start + count)
- derived MDU range(s)
- receipts submitted count + total bytes

This can be presented as a collapsible “Details” panel in Deal Explorer and/or FirstFile.

### D) Bring MDU visibility to the desktop GUI

In `nil_gateway_gui`, add a “Slab / MDUs” panel for the selected deal/manifest:

- show slab breakdown (MDU #0 / witness / user) and MDU size settings
- allow viewing MDU #0 summary (file table count, root table slots used)
- optionally: “open MDU file on disk” for advanced users (debugging + education)

## Proposed marketing angle (what we should make visually obvious)

- “**Your file becomes verifiable structure**”: file → NilFS → MDUs → blobs → commitments → manifest root.
- “**Shared-nothing verification**”: any provider can prove a shard without trusting neighbors.
- “**MDU-level observability**”: users can see which MDU/blob ranges were served and paid for.

## Next steps (implementation plan)

Track this work as a short PR series (copy + UI improvements + GUI parity). Suggested starting point:

- Add a lightweight “MDU Primer” tooltip/modal and improved labeling in:
  - `nil-website/src/components/FileSharder.tsx`
  - `nil-website/src/components/DealDetail.tsx`
- Add a basic retrieval trace summary to the download flow.
- Add a minimal slab breakdown card to `nil_gateway_gui/src/App.tsx`.


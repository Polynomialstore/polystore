# Critical: Implement "Filesystem on Slab" in `nil_s3` Gateway

The previous session culminated in a detailed architectural discussion and the definition of the "Filesystem on Slab" data model and lifecycle for NilStore. The `notes/triple-proof.md` has been updated to reflect this new canonical data structure and behavior.

The primary task for the next agent is to **implement this new filesystem logic within the `nil_s3` Gateway**. This refactor is crucial for enabling a robust user experience with files (not just raw data slabs) and for proving the feasibility of our elastic storage model.

## Primary Goal

Implement the new "Filesystem on Slab" logic in the `nil_s3` Gateway, as detailed in `notes/triple-proof.md`.

## Task Breakdown (Refer to `AGENTS.md` for full TDD Plan)

All tasks are outlined with a **Test-Driven Development (TDD)** approach in `AGENTS.md`, Section 9. Follow that plan rigorously, writing tests first and committing/pushing upon completion of each defined "Definition of Done".

**Key Areas of Implementation:**

1.  **Data Structures (`nil_s3/pkg/layout`):** Define Go structs for `FileTableHeader` and `FileRecordV1`, including bit-packing for `length_and_flags`.
2.  **MDU #0 Builder (`nil_s3/pkg/builder`):** Implement the core logic for initializing, modifying, and serializing the 8MB MDU #0 buffer (Root Table + File Table).
3.  **`GatewayUpload` Refactor:** Adapt the upload handler to manage the MDU #0 state, append files, and return the new `ManifestRoot` and `AllocatedLength`.
4.  **`GatewayFetch` Refactor:** Update the fetch handler to resolve files by path within the filesystem and reconstruct from the correct MDU ranges.
5.  **Chain Integration (`GatewayUpdateDealContent`):** Ensure `ManifestRoot` and `AllocatedLength` are correctly updated on-chain.

## Context from Previous Session

*   **Canonical Data Model:** `notes/triple-proof.md` now defines the `FileRecordV1` struct, MDU #0 layout, and lifecycle (Elastic Slab, Tombstones, Compaction).
*   **Gateway Role:** `nil_s3` is confirmed as the primary "Ingress Provider" responsible for implementing this logic on the server-side.
*   **E2E Test:** The E2E test outlined previously will be re-evaluated *after* the `nil_s3` refactor is complete, as its current objectives are superseded by the new architecture. The UI updates will also follow `nil_s3` changes.

## Mandates

*   **Strictly follow the TDD plan in `AGENTS.md` (Section 9).** Write tests first, then code.
*   **Commit changes after each "Definition of Done" is met for a sub-task.**
*   **Prioritize correctness and adherence to the `notes/triple-proof.md` specification.**

---
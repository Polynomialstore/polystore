# UX Review: The "NilDrive" Paradigm

**Date:** 2025-12-15
**Status:** Draft / Proposal
**Context:** Shifting from a transactional "Deal" model to a resource-based "Drive" model, integrated with an optional Local Gateway.

## 1. Core Philosophy: "Deals are Drives"

The current UI treats storage as a transaction ("Create Deal"). We are pivoting to treating storage as a **resource** ("Manage Drive").

*   **The Metaphor:** A `Deal` is a **Secure Drive** (Volume).
*   **The Behavior:** Users provision a Drive once, then live inside it (upload, organize, retrieve).
*   **The Advantage:** Aligns with NilFS technical reality (a Deal is a filesystem slab) and user mental models (S3 Buckets, Hard Drives).

---

## 2. Terminology Map

| Protocol Concept | Old UI Term | New UI Term |
| :--- | :--- | :--- |
| `Deal` | Storage Deal | **NilDrive** (or just "Drive") |
| `CreateDeal` | Create Deal | **New Drive** |
| `UpdateDealContent` | Commit Content | **Sync / Save** |
| `Escrow` | Escrow Balance | **Fuel** / Balance |
| `Expiry` | End Block | **Lease End** |
| `ManifestRoot` | CID | **Root Hash** (Advanced) |

---

## 3. The Dashboard: "My Drives"

The landing page becomes a collection view, not a transaction list.

### 3.1 Visual Components
*   **Drive Cards:** Grid layout. Each card represents a Deal ID.
    *   **Header:** Drive ID + User Alias (e.g., "Backups").
    *   **Visuals:** Icon indicating "Hot" (Flame) or "Cold" (Snowflake).
    *   **Fuel Gauge:** A progress bar showing Escrow vs. Burn Rate. "30 days remaining".
    *   **Capacity:** "1.2 GB used".
*   **Global Status:**
    *   **Wallet:** Top Right.
    *   **Turbo Mode:** A status indicator (Green Dot) showing if the Local Gateway is connected for acceleration.

### 3.2 Key Actions
*   **[+] New Drive:** Opens the provisioning modal.
    *   *Inputs:* Duration (Lease), Performance (Hot/Cold), Spending Cap.
    *   *Output:* A transaction to create an empty Deal (Thin Provisioning).

---

## 4. The Drive View: "File Explorer"

Clicking a card enters the **Drive View**. This acts as a standard file explorer for the NilFS volume inside that Deal.

### 4.1 The Stage (Local vs. Remote)
The UI must distinguish between files that are *committed* to the network and files that are *staged* locally.

*   **Drop Zone:** The main area. Dragging files here adds them to the **Staging Area**.
*   **Staging Area (The "Cart"):**
    *   Files waiting to be synced.
    *   Stored in **OPFS** (Browser Mode) or **Local Disk** (Turbo Mode).
    *   *Visual:* Faded/Ghosted icons or a separate "Unsaved Changes" list.
*   **Committed Files (The "Cloud"):**
    *   Files listed in the on-chain `MDU #0`.
    *   *Visual:* Solid icons. Status: "Sealed".

### 4.2 The "Sync" Action (Commit)
The "Update Deal Content" transaction is reframed as a **Sync** operation.

1.  **User Click:** "Sync to Network".
2.  **Processing:**
    *   *Browser Mode:* Web Worker calculates KZG chunks.
    *   *Turbo Mode:* Local Gateway calculates KZG chunks (GPU/Native).
3.  **Signing:** Browser prompts MetaMask to sign the new `ManifestRoot`.
4.  **Result:** Staged files become Committed files.

---

## 5. Hybrid Architecture Integration

The UI seamlessly upgrades capabilities if a Local Gateway is detected.

### 5.1 The "Green Dot" Widget
*   **State:**
    *   *Grey:* "Browser Mode". "Fine for small files. Connect Gateway for power."
    *   *Green:* "Turbo Mode". "Gateway Connected. GPU Acceleration Ready."
*   **Function:**
    *   Polls `http://localhost:8080/health`.
    *   If found, switches Ingest/Retrieval strategies to delegate to the Gateway.

### 5.2 Tiered Retrieval (The "Open" Button)
When a user clicks "Download/Open" on a file:
1.  **Check Local:** Is it in OPFS? (Instant open).
2.  **Check Gateway:** Is it in the Local Gateway's slab cache? (Stream from localhost).
3.  **Fetch Network:** Is it only on the network?
    *   *Prompt:* "This requires a retrieval session. Cost: ~0.001 NIL."
    *   *Action:* Trigger `openRetrievalSession` transaction.

---

## 6. Implementation Stages

1.  **Visual Redesign:** Implement "Drive Cards" and "File Explorer" components using existing hooks.
2.  **Hybrid Logic:** Implement the "Green Dot" discovery hook and the `IngestStrategy` interface (WASM vs API).
3.  **Staging Layer:** Build the `OpfsSlabStore` to hold files before they are committed to the chain.

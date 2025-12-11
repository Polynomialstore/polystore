# Website Specification Expansion Plan

This document outlines the high-level tasks required to expand `website-spec.md` into a comprehensive, file-by-file specification of the `nil-website` project.

**Status:** IN PROGRESS (Educational Content Audit Active).

## 1. Core Configuration & Environment
- [x] **Build & Environment Spec:** Define exact configurations for `vite.config.ts`, `tsconfig.json`, and `tailwind.config.js`.
- [x] **Environment Variables:** Document all required `VITE_` env vars and their mapping in `src/config.ts`.
- [x] **Project Constants:** List all hardcoded constants (chain IDs, contract addresses, default endpoints).

## 2. Type System & Data Models
- [x] **Domain Interfaces:** Create a dedicated section defining TypeScript interfaces for core entities (`Deal`, `Provider`, `Proof`).
- [x] **API Response Types:** Specify the exact JSON shape returned by LCD and Gateway.
- [x] **Simulation Data Models:** Document the structure of JSON files in `src/data/`.

## 3. Global State (Context Providers)
- [x] **ProofContext:** Detail the streaming logic, polling intervals, and `addSimulatedProof` mechanism.
- [x] **ThemeContext:** Document the exact logic for system preference detection vs. manual override.
- [x] **Web3Provider:** detailed Wagmi/Viem configuration.

## 4. Hooks (Logic Layer)
- [x] **Transaction Hooks:** Fully specify `useCreateDeal` and `useUpdateDealContent` (EIP-712 Typed Data).
- [x] **Data Hooks:** `useUpload` (FormData), `useFaucet`, `useNetwork`.

## 5. UI Component Specifications
- [x] **Core/Layout:** `Layout.tsx`, `StatusBar.tsx`, `ConnectWallet.tsx`, `ModeToggle.tsx`.
- [x] **Dashboard Components:** `Dashboard`, `DealDetail`, `DealLivenessHeatmap`, `FileSharder`, `FaucetWidget`.
- [x] **Educational/Deep Dives:** `LatticeMap`.

## 6. Page Specifications
- [x] **Pages:** `AdversarialSimulation`, `Home`, `Leaderboard`, `Papers`, `ProofsDashboard`, `Technology`, `TestnetDocs`.

## 7. Utilities & Libraries
- [x] **Utils:** `src/lib/` function specs (`address.ts`, `status.ts`, `cn`).

---

## 8. Educational Content Remediation (Audit Findings)
The following updates are required to align the website with the final Architecture (Mode 2, Triple Proof, Unified Liveness).

### 8.1 Fix Existing Pages
- [ ] **`src/pages/KZGDeepDive.tsx`**:
    *   **Update:** Replace generic "Proof" text with specific **Triple Proof** logic.
    *   **Visualize:** Show the 3-Hop Chain: `Deal Root` -> `MDU` -> `Blob` -> `Byte`.
    *   **Example:** Add the "Polynomial Interpolation" example (`[3, 1, 4]`).
    *   **Correction:** Clarify that Commitments bind to **1 MB Atomic Units** (Blobs), not 8 MB chunks directly.

- [ ] **`src/pages/ShardingDeepDive.tsx`**:
    *   **Correction:** Change `RS(12,9)` to **`RS(12,8)`**.
    *   **Correction:** Update terminology: **1 MB Shards** (Atomic), **8 MB MDUs** (User Unit).
    *   **Add Concept:** **Replicated Metadata**. Explain that *every* node holds the Witness Map to verify *any* shard independently.
    *   **Add Concept:** **Self-Healing**. Explain how a new node reconstructs data from neighbors trustlessly.

- [ ] **`src/pages/PerformanceDeepDive.tsx`**:
    *   **Add Concept:** **Incremental Signing (Fair Exchange)**. Explain that speed is not enough; users must also *pay* (sign) incrementally to prevent "Free Riding".

### 8.2 Create New Content
- [ ] **`src/pages/DeputySystem.tsx`** (New):
    *   **The Problem:** "Ghosting" SPs and "He Said, She Said" disputes.
    *   **The Solution:** The **Deputy** (Mystery Shopper) routing around damage.
    *   **Mechanism:** Ephemeral Keys + Audit Debt.
- [ ] **`src/pages/NilFS.tsx`** (Optional/Advanced):
    *   Explain the **Filesystem on Slab** concept.
    *   Visual: Mapping `Hash("video.mp4")` -> `Offset 500`.

### 8.3 Global Updates
- [ ] **`src/pages/Technology.tsx`**: Update the list of "Deep Dives" to include the Deputy System.
- [ ] **`src/pages/Home.tsx`**: Ensure the "Features" grid mentions **Self-Healing** (Mode 2) and **Triple Proof** explicitly.
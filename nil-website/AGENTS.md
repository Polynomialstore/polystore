# Website Specification Expansion Plan

This document outlines the high-level tasks required to expand `website-spec.md` into a comprehensive, file-by-file specification of the `nil-website` project.

**Status:** ALL TASKS COMPLETED (Spec updated to include all items below).

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

## 8. Educational Content (New)
These pages are required to explain the novel cryptographic and economic mechanisms of NilStore.

- [ ] **KZG Deep Dive:** Create a dedicated page explaining the KZG Commitment algorithm.
    *   **High Level:** "Polynomials as Files" (The `[3, 1, 4]` example).
    *   **Rigorous:** Elliptic Curve Pairings, SRS, and q-SDH assumption.
    *   **Application:** How NilStore uses Triple Proofs to bind Deal Root -> MDU -> Blob -> Byte.
- [ ] **Retrieval Solved:** A guide on how NilStore inverts the storage model.
    *   **Unified Liveness:** Receipts = Storage Proofs.
    *   **Triple Proof:** Trustless verification of petabytes.
    *   **Mode 2:** Erasure Coding and Self-Healing.
- [ ] **The Deputy System:** Explaining the "Mystery Shopper" network.
    *   **Concept:** Routing around damage vs. Courts.
    *   **Audit Debt:** How nodes are forced to audit neighbors.
    *   **Participation:** How users can run a node to earn rewards.

---

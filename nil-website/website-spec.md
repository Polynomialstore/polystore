# NilStore Website Specification (v2.5)

**Status:** Living Document
**Last Updated:** Dec 10, 2025

## 1. Project Identity & Architecture

*   **Name:** `nil-website`
*   **Type:** Single Page Application (SPA)
*   **Core Stack:** React 18, Vite, TypeScript, Tailwind CSS.
*   **Routing:** `react-router-dom` (HashRouter).
*   **State:** React Context + React Query (via Wagmi).
*   **Design System:** "Cyberpunk/Scientific" aesthetic (Dark mode default, glassmorphism, neon accents).

### 1.1 File Structure

```text
/src
├── assets/                 # Static images (logo variants)
├── components/             # Reusable UI modules
│   ├── Dashboard.tsx       # [Core] Main user interaction hub (Alloc/Content tabs)
│   ├── DealDetail.tsx      # [Core] Modal for inspecting Deal Manifests & Heatmaps
│   ├── Layout.tsx          # [Shell] Global navigation, footer, and mobile menu
│   ├── ConnectWallet.tsx   # [Auth] Wallet connection button
│   ├── StatusBar.tsx       # [Global] Network status indicator
│   └── ... (Charts, Maps, etc.)
├── context/                # Global State Providers
│   ├── ProofContext.tsx    # Streaming global ZK proofs
│   ├── ThemeContext.tsx    # Light/Dark mode logic
│   ├── Web3Provider.tsx    # Wagmi/Viem/TanStack Query configuration
│   └── TechnologyContext.tsx # Educational module state
├── hooks/                  # Logic Encapsulation
│   ├── useCreateDeal.ts    # [Tx] Capacity allocation (EIP-712)
│   ├── useUpdateDeal.ts    # [Tx] Content commitment (EIP-712)
│   ├── useUpload.ts        # [API] Gateway file processing
│   ├── useProofs.ts        # [Read] Consumes ProofContext
│   ├── useFaucet.ts        # [API] Testnet token requests
│   └── useNetwork.ts       # [Web3] Chain switching logic
├── pages/                  # Route Targets
│   ├── Home.tsx            # Landing Page
│   ├── Dashboard.tsx       # (Wrapper for component)
│   ├── TestnetDocs.tsx     # CLI/Node Setup Guide
│   ├── Technology.tsx      # Tech Deep Dives (Sharding, KZG)
│   ├── Papers.tsx          # Whitepaper/Litepaper renderers
│   └── ... (Leaderboard, Performance, etc.)
├── lib/                    # Utilities (Address conversion, formatting)
├── config.ts               # Environment configuration
├── App.tsx                 # Route definitions & Provider nesting
└── main.tsx                # Entry point
```

---

## 2. Global State & Context

### 2.1 Web3Provider (`src/context/Web3Provider.tsx`)
*   **Purpose:** Configures `wagmi` for wallet connection and blockchain interaction.
*   **Chains:** `NilChain Local` (Custom, ID via config), `Mainnet`, `Sepolia`.
*   **Transport:** HTTP (configured via `appConfig.evmRpc`).
*   **Exports:** Wraps app in `WagmiProvider` and `QueryClientProvider`.

### 2.2 ProofContext (`src/context/ProofContext.tsx`)
*   **Purpose:** Streams a global feed of ZK proofs (both real chain data and simulated visuals).
*   **State:** `proofs: Proof[]`, `loading: boolean`.
*   **Source:** Polls LCD `/nilchain/nilchain/v1/proofs` on mount.
*   **Methods:** `addSimulatedProof(proof)` for UI demos.

### 2.3 ThemeContext (`src/context/ThemeContext.tsx`)
*   **Purpose:** Manages Dark/Light/System mode preference.
*   **Storage:** `localStorage` key `nilstore-theme`.
*   **Effect:** Toggles `.dark` class on `document.documentElement`.

---

## 3. Core Workflow Specification

### 3.1 The "Two-Step Deal" (Dashboard)
The Dashboard implements the "Container vs. Content" model via a tabbed interface.

#### Step 1: Allocation (Tab: "1. Alloc Capacity")
*   **Input:** Size Tier (Enum 1-3), Duration (Blocks), Escrow (Tokens), Max Spend, Replication (Count).
*   **Logic:**
    1.  User clicks "Allocate".
    2.  `useCreateDeal` constructs an EIP-712 `CreateDeal` intent.
    3.  User signs via MetaMask.
    4.  Payload + Signature sent to `POST /gateway/create-deal-evm`.
*   **Output:** Returns `deal_id`. UI auto-switches to Step 2.

#### Step 2: Commitment (Tab: "2. Commit Content")
*   **Input:** Target Deal ID (Select from user's deals), File (Upload).
*   **Logic:**
    1.  User selects Deal ID.
    2.  User uploads file -> `useUpload` -> `POST /gateway/upload`.
    3.  Gateway returns `CID` (Manifest Root) and `size_bytes`.
    4.  User clicks "Commit".
    5.  `useUpdateDealContent` constructs EIP-712 `UpdateContent` intent.
    6.  User signs via MetaMask.
    7.  Payload + Signature sent to `POST /gateway/update-deal-content-evm`.
*   **Output:** Deal becomes "Active".

### 3.2 Deal Visualization (`DealDetail.tsx`)
*   **Trigger:** Clicking a row in the Dashboard table.
*   **Data Source:**
    *   Metadata: Passed from parent `Dashboard`.
    *   Manifest: Fetched from `GET /gateway/manifest/{cid}`.
    *   Heatmap: Derived from `ProofContext` + `GET /deals/{id}/heat`.
*   **Visuals:**
    *   **MDU Layout:** Renders the "Triple Proof" hierarchy (Manifest -> MDUs -> 64 Blobs).
    *   **Traffic:** Real-time counters for bytes served and failed proofs.

---

## 4. API Contract & Integration

The website depends on the following services (configured in `config.ts`):

| Service | Config Key | Default |
|:---|:---|:---|
| **Cosmos LCD** | `lcdBase` | `http://localhost:1317` |
| **Storage Gateway** | `gatewayBase` | `http://localhost:8080` |
| **EVM JSON-RPC** | `evmRpc` | `http://localhost:8545` |

### Key Endpoints
*   `POST /gateway/upload`: `FormData{file, owner}` -> `{cid, size_bytes, filename}`.
*   `POST /gateway/create-deal-evm`: `{intent, evm_signature}` -> `{tx_hash}`.
*   `GET /nilchain/nilchain/v1/deals`: Returns list of all deals (client-side filtering by owner).
*   `GET /nilchain/nilchain/v1/providers`: Returns list of active SPs.

---

## 5. Styling System

*   **Framework:** Tailwind CSS.
*   **Colors (Theme):**
    *   `primary`: Blue/Purple gradients (`from-blue-400 to-purple-600`).
    *   `background`: White (Light) / `hsl(222.2 84% 4.9%)` (Dark).
    *   `card`: Translucent glass (`bg-gray-900/50` + `backdrop-blur`).
*   **Typography:** Sans-serif (Default). Markdown content (Docs) uses `prose` plugin patterns.
*   **Layout:** Responsive Container (`max-w-6xl mx-auto`).

## 6. Routing Map

| Path | Component | Description |
|:---|:---|:---|
| `/` | `Home` | Marketing landing page. |
| `/dashboard` | `Dashboard` | App: Deal management. |
| `/testnet` | `TestnetDocs` | Guide: Connect CLI/Node. |
| `/technology` | `TechnologyLayout` | Wrapper for tech deep dives. |
| `/technology/kzg` | `KZGDeepDive` | Explainer: Polynomial Commitments. |
| `/technology/sharding` | `ShardingDeepDive` | Explainer: Erasure Coding. |
| `/leaderboard` | `Leaderboard` | Table: Top SPs by score. |
| `/proofs` | `ProofsDashboard` | Stream: Live ZK verification. |
| `/whitepaper` | `Whitepaper` | PDF/Markdown render of spec. |
| `/s3-adapter` | `S3AdapterDocs` | Guide: Using S3 compatibility. |
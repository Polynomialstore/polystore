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
├── main.tsx                # Entry point
```

### 1.2 Configuration & Environment

The application uses Vite for building and handling environment variables. Configuration is centralized in `src/config.ts`.

#### Environment Variables (`.env`)
| Variable | Default | Description |
|:---|:---|:---|
| `VITE_API_BASE` | `http://localhost:8081` | Backend API base URL. |
| `VITE_LCD_BASE` | `http://localhost:1317` | Cosmos LCD (Light Client Daemon) URL. |
| `VITE_GATEWAY_BASE` | `http://localhost:8080` | Storage Gateway URL for file uploads. |
| `VITE_COSMOS_CHAIN_ID` | `test-1` | Chain ID for the Cosmos layer. |
| `VITE_EVM_RPC` | `http://localhost:8545` | JSON-RPC endpoint for the EVM layer. |
| `VITE_CHAIN_ID` | `31337` | Chain ID for the EVM layer (default: Localhost). |
| `VITE_BRIDGE_ADDRESS` | `0x0000...0000` | Optional NilBridge contract address for bridge status UI. |

#### Build Configuration
*   **Vite (`vite.config.ts`):** Standard React plugin setup.
*   **TypeScript (`tsconfig.json`):** Strict mode enabled, Target ES2020.
*   **Tailwind (`tailwind.config.js`):** Configured for CSS variable-based theming (HSL values) with `darkMode: 'class'`.
*   **WASM (`nil_core`):** `npm run dev` and `npm run build` run `wasm-pack build` via `predev`/`prebuild`, outputting artifacts to `public/wasm/`. This requires `wasm-pack` + a Rust toolchain on the machine/CI runner.

### 1.3 Key Dependencies
*   **Web3:** `wagmi`, `viem`
*   **State/Data:** `@tanstack/react-query`
*   **UI/Styling:** `tailwindcss`, `clsx`, `tailwind-merge`, `lucide-react`, `framer-motion`
*   **Visualization:** `recharts`
*   **Utilities:** `bech32` (address formatting), `marked` (markdown rendering)

---

## 2. Type System & Data Models

### 2.1 Domain Entities
TypeScript interfaces representing the core data structures.

#### `Deal`
Represents a storage contract between a user and the network.
```typescript
interface Deal {
  id: string;              // Unique identifier (uint64 as string)
  cid: string;             // Deal.manifest_root (48-byte KZG commitment, hex; empty if not committed)
  size: string;            // Current committed content size in bytes
  owner: string;           // Bech32 address of the creator
  escrow: string;          // Token amount locked
  end_block: string;       // Expiration block height
  start_block?: string;    // Activation block height
  service_hint?: string;   // Metadata/Label
  current_replication?: string; // Number of active providers
  max_monthly_spend?: string;   // Cost cap
  providers?: string[];    // List of assigned SP addresses
  deal_size?: number;      // Legacy/Reserved (capacity tiers removed); avoid relying on this
}
```

#### `Provider` (Storage Provider)
Represents a node offering storage capacity.
```typescript
interface Provider {
  address: string;         // Bech32 address
  capabilities: string;    // e.g., "fast-retrieval,archive"
  total_storage: string;   // Total capacity in bytes
  used_storage: string;    // Consumed capacity in bytes
  status: string;          // e.g., "active", "jailed"
  reputation_score: string;// 0.0-1.0 score
}
```

#### `Proof`
Represents a Zero-Knowledge proof of storage.
```typescript
interface Proof {
  id: string;
  creator: string;         // SP address
  commitment: string;      // Cryptographic commitment
  block_height: string;    // Block where proof was submitted
  source?: 'chain' | 'simulated'; // Origin of the data
}
```

#### `ServiceStatus`
Global health status of connected services.
```typescript
type ServiceStatus = 'ok' | 'warn' | 'error';

interface StatusSummary {
  lcd: ServiceStatus;      // Cosmos REST API
  evm: ServiceStatus;      // EVM JSON-RPC
  faucet: ServiceStatus;   // Token Faucet
  chainIdMatch: ServiceStatus; // Web3 Wallet vs App Config
  height?: number;         // Current block height
  networkName?: string;    // Chain ID from node
  evmChainId?: number;     // Chain ID from EVM RPC
  error?: string;
}
```

---

## 3. Global State & Context

### 3.1 Web3Provider (`src/context/Web3Provider.tsx`)
*   **Purpose:** Configures `wagmi` for wallet connection and blockchain interaction.
*   **Chains:** `NilChain Local` (Custom, ID defined in `VITE_CHAIN_ID`), `Mainnet`, `Sepolia`.
*   **Transport:** HTTP (configured via `appConfig.evmRpc`).
*   **Client:** Integrates `@tanstack/react-query`'s `QueryClient` for caching blockchain reads.
*   **Exports:** Wraps app in `WagmiProvider` and `QueryClientProvider`.

### 3.2 ProofContext (`src/context/ProofContext.tsx`)
*   **Purpose:** Streams a global feed of ZK proofs (both real chain data and simulated visuals).
*   **State:** `proofs: Proof[]`, `loading: boolean`.
*   **Logic:**
    *   **Initialization:** Fetches initial proofs from `${LCD_BASE}/nilchain/nilchain/v1/proofs`.
    *   **Deduplication:** Merges new proofs preventing duplicates by `id`.
    *   **Simulation:** `addSimulatedProof(proof)` prepends locally generated proofs with `source: 'simulated'`.
*   **Exports:** `useProofs()` hook.

### 3.3 ThemeContext (`src/context/ThemeContext.tsx`)
*   **Purpose:** Manages Dark/Light/System mode preference.
*   **Storage:** `localStorage` key `vite-ui-theme`.
*   **Logic:**
    *   Detects system preference via `window.matchMedia("(prefers-color-scheme: dark)")`.
    *   Applies `dark` or `light` class to `document.documentElement`.
*   **Exports:** `useTheme()` hook.

### 3.4 TechnologyContext (`src/context/TechnologyContext.tsx`)
*   **Purpose:** Manages state for educational deep-dive modules (e.g., current step in a walkthrough).
*   *(To be fully specified based on implementation details)*

---

## 4. Hooks & Logic Layer

This layer encapsulates business logic, specifically EIP-712 signing and Gateway interactions.

### 4.1 `useCreateDeal` (`src/hooks/useCreateDeal.ts`)
*   **Purpose:** Orchestrates the capacity allocation transaction.
*   **Input:** `CreateDealInput` (duration, escrow, maxSpend, replication).
*   **EIP-712 Signature:**
    *   **Domain:** `NilStore` (Verifying Contract: `0x0...0`).
    *   **Type:** `CreateDeal(address creator, uint32 size_tier, uint64 duration, string service_hint, uint256 initial_escrow, uint256 max_monthly_spend, uint64 nonce)` (size_tier fixed to `0` for legacy compatibility).
    *   **Nonce Logic:** Manages local nonce counter in `localStorage` (`nilstore:evmNonces:<addr>`).
*   **API:** POSTs `{ intent, evm_signature }` to `/gateway/create-deal-evm`.

### 4.2 `useUpdateDealContent` (`src/hooks/useUpdateDealContent.ts`)
*   **Purpose:** Commits a file Manifest to an existing Deal.
*   **Input:** `UpdateDealContentInput` (dealId, cid, sizeBytes).
*   **EIP-712 Signature:**
    *   **Type:** `UpdateContent(address creator, uint64 deal_id, string cid, uint64 size, uint64 nonce)`.
*   **API:** POSTs `{ intent, evm_signature }` to `/gateway/update-deal-content-evm`.

### 4.3 `useUpload` (`src/hooks/useUpload.ts`)
*   **Purpose:** Handles file upload to the Storage Gateway.
*   **Logic:**
    1.  Converts EVM address to Cosmos (Bech32) format if needed using `ethToNil`.
    2.  Constructs `FormData` with `file` and `owner`.
    3.  POSTs to `/gateway/upload` with a bounded timeout (AbortController).
*   **Returns:** `{ cid, sizeBytes, fileSizeBytes, allocatedLength?, filename }` (where `cid` is the new `manifest_root`).

### 4.4 `useFaucet` (`src/hooks/useFaucet.ts`)
*   **Purpose:** Requests test tokens for the connected address.
*   **API:** GET `${API_BASE}/request?addr={address}`.

---

## 5. UI Component Specifications

### 5.1 Global Layout (`src/components/Layout.tsx`)
*   **Structure:** Fixed "Cyber-Glass" Navbar + Main Content + Footer.
*   **Navigation:**
    *   Links: Dashboard, Technology, Leaderboard, Performance, Proofs, Economy, Security, S3 Adapter, Governance, FAQ.
    *   Mobile: Hamburger menu with `framer-motion` slide-down.
*   **Child Components:** `ConnectWallet`, `ModeToggle`.

### 5.2 Dashboard (`src/components/Dashboard.tsx`)
The central hub for deal management.
*   **State:**
    *   `activeTab`: 'alloc' (Allocation) vs 'content' (Commitment).
    *   `deals`: List of user's deals (fetched from LCD).
    *   `providers`: Active SP list.
    *   `nilAddress`: Derived Cosmos address from connected EVM wallet.
*   **Key Interactions:**
    *   **Allocation:** Form -> `useCreateDeal`.
    *   **Commitment:** File Input -> `useUpload` -> `useUpdateDealContent`.
    *   **Inspection:** Clicking a deal row opens `DealDetail`.
*   **Network Checks:** Warns on Chain ID mismatch or local RPC mismatch.

### 5.3 Deal Detail Modal (`src/components/DealDetail.tsx`)
*   **Props:** `deal: Deal`, `onClose: () => void`.
*   **Tabs:**
    1.  **Overview:** Metadata (ID, Owner, Size, Economics), Provider List, Download Button.
    2.  **Manifest & MDUs:** Visualizes the Deal *slab layout* (MDU #0 + Witness + User) and provides an educational viewer for roots/commitments.
    3.  **Heat:** Traffic stats and `DealLivenessHeatmap`.
*   **Key Definitions:**
    *   **Manifest Root:** 48-byte KZG commitment over the ordered vector of **MDU Roots**: `[Root(MDU0), Root(MDU1), ..., Root(MDUN)]`.
    *   **MDU Root:** 32-byte Blake2s Merkle root of the 64 **Blob Commitments** for a single 8 MiB MDU.
    *   **Blob Commitment:** 48-byte KZG commitment for one 128 KiB blob (64 blobs per MDU).
*   **Viewer Panels (Manifest Tab):**
    *   **Manifest Root Explainer:** Displays `manifest_root`, `manifest_blob_hex`, and the ordered root vector; optionally builds a debug Merkle tree over MDU roots behind a button (for intuition only; not the on-chain commitment).
    *   **Root Table (MDU #0):** Lists root-table entries (witness + user roots) and maps each entry to its `mdu_index`.
    *   **MDU Inspector:** For a selected MDU, fetches and displays the 64 blob commitments and the derived MDU root.
*   **APIs:**
    *   **Slab layout:** `GET /gateway/slab/{manifest_root}?deal_id=...&owner=...` (summary + segment ranges).
    *   **NilFS file list:** `GET /gateway/list-files/{manifest_root}?deal_id=...&owner=...` (authoritative; parsed from `mdu_0.bin`).
    *   **Manifest details:** `GET /gateway/manifest-info/{manifest_root}?deal_id=...&owner=...` (manifest blob + ordered MDU roots).
    *   **MDU KZG details:** `GET /gateway/mdu-kzg/{manifest_root}/{mdu_index}?deal_id=...&owner=...` (64 blob commitments + MDU root).
    *   **Shard JSON manifest (debug):** `GET /gateway/manifest/{cid}` (file-level; served via the gateway index and may not reflect slab layout).

### 5.4 Deal Liveness Heatmap (`src/components/DealLivenessHeatmap.tsx`)
*   **Props:** `proofs: ProofRow[]`.
*   **Visualization:** `recharts` ScatterChart.
    *   **X-Axis:** Block Height.
    *   **Y-Axis:** Tier (Platinum=3, Gold=2, Silver=1, Fail=0).
    *   **Color Coding:** Cyan (Plat), Yellow (Gold), Slate (Silver), Red (Fail/Invalid).

### 5.5 Status Bar (`src/components/StatusBar.tsx`)
*   **Purpose:** Displays global health of the 4 key dependencies.
*   **State:** Polls `fetchStatus` on mount.
*   **Indicators:**
    *   **LCD:** Cosmos REST API reachability.
    *   **EVM:** JSON-RPC reachability & Chain ID.
    *   **Faucet:** Health check endpoint.
    *   **Wallet:** Matches configured Chain ID.

### 5.6 Connect Wallet (`src/components/ConnectWallet.tsx`)
*   **Library:** `wagmi` hooks (`useConnect`, `useAccount`, `useDisconnect`).
*   **Behavior:**
    *   **Disconnected:** Shows "Connect Wallet" button (injected connector).
    *   **Connected:** Shows truncated address + Disconnect button.

### 5.7 Utility Components
*   **`ModeToggle.tsx`:** Sun/Moon icon toggle using `useTheme`.
*   **`FaucetWidget.tsx`:** Standalone button triggering `useFaucet`.
*   **`FileSharder.tsx`:** *Educational Demo*. Simulates client-side file chunking (8MB), SHA-256 hashing, and "sealing" delay. Updates `ProofContext` with simulated proofs.

---

## 6. Page Specifications

### 6.1 Landing & Marketing (`src/pages/Home.tsx`)
*   **Hero:** "Storage, Unsealed." tagline with animated Logo.
*   **Content:** High-level value props (Unified Liveness, Performance Market).
*   **CTAs:** Links to Testnet, Whitepaper, Litepaper.

### 6.2 Technology Deep Dives
*   **Wrapper (`src/pages/TechnologyLayout.tsx`):** Provides `TechnologyProvider` and transitions.
*   **Hub (`src/pages/Technology.tsx`):** Index of modules.
*   **Modules:**
    *   `ShardingDeepDive`: Interactive Erasure Coding explainer.
    *   `KZGDeepDive`: Polynomial Commitment math visualizer.
    *   `PerformanceDeepDive`: Sealing latency comparison.

### 6.3 Dashboards
*   **`Leaderboard.tsx`:**
    *   Fetches providers from LCD.
    *   Renders grid of Provider Cards sorted by capacity.
    *   Badges top 3 nodes (Trophy/Medal).
*   **`ProofsDashboard.tsx`:**
    *   Real-time "Observatory" of KZG proofs.
    *   Charts: Tier Distribution (Bar), Top Deals/Providers (List).
    *   Timeline: Table of recent proof events (Block, Status, Commitment).

### 6.4 Documentation & Research
*   **`TestnetDocs.tsx`:** Guide for CLI setup, Faucet usage, and Running a Node. Embeds `FaucetWidget` and `FileSharder`.
*   **`AdversarialSimulation.tsx`:** "Lazy Provider" attack simulator.
    *   Uses `recharts` to plot Profit/Loss of Honest vs. AWS S3 (Lazy) nodes over time.
    *   Consumes `src/data/adversarial_simulation.json`.
*   **`Papers.tsx`:** `Litepaper` and `Whitepaper` components wrapping a generic `MarkdownPage` loader.
*   **`LatticeMap.tsx`:** Visualization component (likely embedded in Technology or Home) showing nodes as a grid.

---

## 7. Utilities & Libraries

### 7.1 Address (`src/lib/address.ts`)
*   `ethToNil(ethAddress: string)`: Converts 0x Ethereum addresses to `nil1...` Bech32 format.

### 7.2 Status (`src/lib/status.ts`)
*   `fetchStatus(chainId)`: Aggregates health checks from LCD, EVM RPC, and Faucet.
*   `ServiceStatus`: Type `'ok' | 'warn' | 'error'`.

### 7.3 Styling (`src/lib/utils.ts`)
*   `cn(...)`: Combines `clsx` and `tailwind-merge` for dynamic classes.


The website depends on the following services (configured in `config.ts`):

| Service | Config Key | Default |
|:---|:---|:---|
| **Cosmos LCD** | `lcdBase` | `http://localhost:1317` |
| **Storage Gateway** | `gatewayBase` | `http://localhost:8080` |
| **EVM JSON-RPC** | `evmRpc` | `http://localhost:8545` |

### Key Endpoints
*   `POST /gateway/upload`: `FormData{file, owner}` -> `{cid, size_bytes, filename}`.
*   `POST /gateway/create-deal-evm`: `{intent, evm_signature}` -> `{tx_hash}`.
*   `GET /gateway/manifest-info/{manifest_root}`: Returns `manifest_blob_hex` + ordered MDU roots (debug/inspection).
*   `GET /gateway/mdu-kzg/{manifest_root}/{mdu_index}`: Returns blob commitments + MDU root (debug/inspection).
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

---

## 8. Spec Compliance & Implementation Reality (Gap Analysis)

**Critical Note:** As of v2.5, the web frontend functions as a **Thin Client**. It deviates from the core `spec.md` "Thick Client" model in the following ways to accommodate browser limitations and UX speed:

### 8.1 Data Ingestion (Upload)
*   **Spec:** Client locally packs files into 8 MiB MDUs, computes KZG commitments (Triple Proof root), and uploads encrypted shards to SPs.
*   **Actual:** Client uploads **raw `FormData`** to the **Storage Gateway** (`POST /gateway/upload`). The *Gateway* performs the sharding, KZG commitment generation (Trusted Setup binding), and MDU packing. It returns the `CID` and `size_bytes` to the client.
*   **Implication:** The client currently trusts the Gateway to generate the correct canonical representation of the data.

### 8.2 Data Retrieval (Download)
*   **Spec:** Client fetches chunks from SPs, verifies the KZG Triple Proof (Manifest->MDU->Blob->Data) locally, and signs a receipt.
*   **Actual:** Client requests data via **Gateway Proxy** (`GET /gateway/fetch/...`). The Gateway performs the retrieval and verification from the NilChain network and streams the reconstructed file to the user.
*   **Implication:** Browser-side KZG verification is not yet implemented.

### 8.3 Visualizations vs. Logic
*   **`FileSharder.tsx`:** This component is explicitly a **Simulation/Educational Demo**. It uses SHA-256 for visual feedback and does *not* generate valid NilStore KZG commitments, nor does it perform actual MDU packing compliant with the protocol.
*   **Real Data Flow:** The actual data flow for a deal is:
    1.  `useCreateDeal` -> Allocates storage on-chain.
    2.  `useUpload` -> Streams raw file to Gateway -> Gateway returns CID.
    3.  `useUpdateDealContent` -> Commits Gateway-provided CID to the chain.

---

## 9. Deal Observables & TDD Refinement

This sprint prioritizes a clean separation between:
- **Model/domain logic (Node-testable):** parsing/normalizing LCD + Gateway responses into stable “observables”.
- **Controller logic (Node-testable):** orchestrating reads across LCD + Gateway (slab layout + file list).
- **Visualization (React):** rendering panels using the centralized observables.

### 9.1 Primary Observables (Authoritative Sources)
*   **Deal (LCD):** `GET /nilchain/nilchain/v1/deals` → `Deal.id`, `Deal.owner`, `Deal.manifest_root` (48 bytes), `Deal.size`.
*   **Slab layout (Gateway):** `GET /gateway/slab/{manifest_root}?deal_id=...&owner=...` → `total_mdus`, `witness_mdus`, `user_mdus`, and segment ranges (MDU #0, witness, user).
*   **NilFS file table (Gateway):** `GET /gateway/list-files/{manifest_root}?deal_id=...&owner=...` → `{files:[{path,size_bytes,start_offset,flags}]}` parsed from `mdu_0.bin`.
*   **Upload staging (Gateway response):** `POST /gateway/upload` → `{manifest_root,size_bytes,file_size_bytes,allocated_length}` used for immediate UX before LCD reflects the commit.

### 9.2 Tests
*   **Node unit tests:** validate domain normalization and controller orchestration (no React/DOM required).
    *   Command: `npm run test:unit`
*   **Opt-in local-stack e2e (Node):** uses the same TypeScript clients to run:
    1. Create deal (EIP-712 → `/gateway/create-deal-evm`)
    2. Upload file (→ `/gateway/upload`)
    3. Commit content (EIP-712 → `/gateway/update-deal-content-evm`)
    4. Verify LCD deal state + gateway slab/files
    *   Command: `NIL_E2E=1 npm run test:unit` (requires `./scripts/run_local_stack.sh start` running)

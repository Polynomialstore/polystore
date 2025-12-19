# NilStore Website Specification (v2.7)

**Status:** Living Document
**Last Updated:** Dec 18, 2025

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
│   ├── GatewayStatusWidget.tsx # [Global] Local gateway detection widget (green dot)
│   └── ... (Charts, Maps, etc.)
├── context/                # Global State Providers
│   ├── ProofContext.tsx    # Streaming global ZK proofs
│   ├── TransportContext.tsx # Route preference + last trace (gateway vs direct SP)
│   ├── StagingContext.tsx  # IndexedDB-backed staging queue (OPFS paths)
│   ├── ThemeContext.tsx    # Light/Dark mode logic
│   ├── Web3Provider.tsx    # Wagmi/Viem/TanStack Query configuration
│   └── TechnologyContext.tsx # Educational module state
├── hooks/                  # Logic Encapsulation
│   ├── useCreateDeal.ts    # [Tx] Create Deal via precompile
│   ├── useUpdateDealContent.ts # [Tx] Commit manifest_root via precompile
│   ├── useUpload.ts        # [API] Gateway/SP upload via transport router
│   ├── useFetch.ts         # [API] Retrieval sessions + data fetch
│   ├── useTransportRouter.ts # [Router] Gateway/direct SP fallback
│   ├── useLocalGateway.ts  # [Probe] Local gateway health/capabilities
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
│   ├── storage/            # OPFS adapter + helpers
│   ├── transport/          # Gateway/direct SP routing + error classification
├── config.ts               # Environment configuration
├── App.tsx                 # Route definitions & Provider nesting
├── main.tsx                # Entry point
├── workers/                # Web Workers (WASM sharding / gateway harness)
```

### 1.2 Configuration & Environment

The application uses Vite for building and handling environment variables. Configuration is centralized in `src/config.ts`.

#### Environment Variables (`.env`)
| Variable | Default | Description |
|:---|:---|:---|
| `VITE_API_BASE` | `http://localhost:8081` | Backend API base URL. |
| `VITE_LCD_BASE` | `http://localhost:1317` | Cosmos LCD (Light Client Daemon) URL. |
| `VITE_GATEWAY_BASE` | `http://localhost:8080` | Optional local gateway base (routing + proof relay). |
| `VITE_SP_BASE` | `http://localhost:8082` | Default Storage Provider base for direct uploads/fetches. |
| `VITE_COSMOS_CHAIN_ID` | `31337` | Chain ID for the Cosmos layer. |
| `VITE_EVM_RPC` | `http://localhost:8545` | JSON-RPC endpoint for the EVM layer. |
| `VITE_CHAIN_ID` | `31337` | Chain ID for the EVM layer (default: Localhost). |
| `VITE_BRIDGE_ADDRESS` | `0x0000...0000` | Optional NilBridge contract address for bridge status UI. |
| `VITE_NILSTORE_PRECOMPILE` | `0x0000...0900` | NilStore precompile address (create/update/retrieval sessions). |
| `VITE_E2E` | `0` | Enable injected E2E wallet shim when `1`. |
| `VITE_E2E_PK` | *(dev key)* | Private key for E2E wallet shim (local/CI only). |

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
  cid: string;             // Deal.manifest_root (48-byte compressed G1; canonical string is `0x` + 96 lowercase hex; empty if not committed). Legacy alias only; not a file identifier.
  size: string;            // Current committed content size in bytes
  owner: string;           // Bech32 address of the creator
  escrow: string;          // Token amount locked
  end_block: string;       // Expiration block height
  start_block?: string;    // Activation block height
  service_hint?: string;   // Metadata/Label
  current_replication?: string; // Number of active providers
  max_monthly_spend?: string;   // Cost cap
  providers?: string[];    // List of assigned SP addresses
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
*   **E2E Mode:** When `VITE_E2E=1`, install a deterministic injected wallet shim (no MetaMask extension) to make Playwright runs stable and CI‑friendly (recommended env: `VITE_E2E_PK` for the dev private key).
    *   **Provider API (minimum):** EIP‑1193 `request({ method, params })` supports `eth_requestAccounts`, `eth_accounts`, `eth_chainId`, `eth_signTypedData_v4`, and `eth_sendTransaction` (optionally `wallet_switchEthereumChain` as a deterministic no‑op/error).

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

This layer encapsulates MetaMask transactions, transport routing, and gateway/SP interactions.

### 4.1 `useCreateDeal` (`src/hooks/useCreateDeal.ts`)
*   **Purpose:** Orchestrates Deal creation (thin-provisioned container; no capacity tiers).
*   **Input:** `CreateDealInput` (duration, escrow, maxSpend, replication).
*   **Flow:** MetaMask `eth_sendTransaction` to the NilStore precompile (`createDeal(duration, service_hint, initial_escrow, max_monthly_spend)`); `service_hint` encodes replica count and (for Mode 2) `rs=K+M`.
*   **Output:** `deal_id` parsed from the `DealCreated` event.

### 4.2 `useUpdateDealContent` (`src/hooks/useUpdateDealContent.ts`)
*   **Purpose:** Commits a file Manifest to an existing Deal.
*   **Input:** `UpdateDealContentInput` (dealId, manifestRoot, sizeBytes).
*   **Flow:** MetaMask `eth_sendTransaction` to the NilStore precompile (`updateDealContent(dealId, manifestRoot, sizeBytes)`).
    *   **Compatibility:** Some codepaths may still label this field as `cid`, but it is always the *deal-level* `manifest_root` (not a file identifier).

### 4.3 `useUpload` (`src/hooks/useUpload.ts`)
*   **Purpose:** Handles thin-client file upload via the transport router (gateway or direct SP).
*   **Logic:**
    1.  Converts EVM address to Cosmos (Bech32) format if needed using `ethToNil`.
    2.  Constructs `FormData` with `file`, `owner`, and optional controls (`deal_id`, `max_user_mdus`, `file_path`).
    3.  Calls `transport.uploadFile(...)` which selects `gatewayBase` or `spBase` based on routing preference and availability.
*   **Returns:** `{ manifestRoot, sizeBytes, fileSizeBytes, allocatedLength?, filename }`.
    *   **Compatibility:** Responses may include legacy aliases `cid == manifest_root` and `allocated_length == total_mdus`.
    *   **NilFS invariant:** `filePath` is the authoritative identifier for later fetch/prove and MUST be unique within a deal (re-upload is overwrite).

### 4.4 `useTransportRouter` (`src/hooks/useTransportRouter.ts`)
*   **Purpose:** Centralizes routing between local gateway and direct SP endpoints.
*   **Behavior:** Exposes `listFiles`, `slab`, `plan`, `uploadFile`, `manifestInfo`, `mduKzg` with bounded retries and a `DecisionTrace` for UX.
*   **Preference:** `auto`, `prefer_gateway`, `prefer_direct_sp` (persisted in localStorage via `TransportContext`).

### 4.5 `useFetch` (`src/hooks/useFetch.ts`)
*   **Purpose:** Orchestrates retrieval sessions, byte fetch, and proof submission (Mode 1 + Mode 2).
*   **Flow:**
    1.  Plan blob-range via `GET /gateway/plan-retrieval-session/{manifest_root}?deal_id=...&owner=...&file_path=...` (gateway or direct SP).
    2.  Open session on-chain via MetaMask (`openRetrievalSession` precompile).
    3.  Fetch bytes with `X-Nil-Session-Id` header via `/gateway/fetch/{manifest_root}` (gateway or direct SP).
    4.  Confirm completion on-chain (`confirmRetrievalSession`).
    5.  Submit proof relay via `POST /gateway/session-proof` (gateway forwards to provider).
*   **Mode 2:** When the deal is striped, the fetch path is slot-aware (blob ranges must stay within a slot); gateways may reconstruct missing MDUs from `/sp/shard`.

### 4.6 `useFaucet` (`src/hooks/useFaucet.ts`)
*   **Purpose:** Requests test tokens for the connected address.
*   **API:** GET `${API_BASE}/request?addr={address}`.

---

## 5. UI Component Specifications

### 5.1 Global Layout (`src/components/Layout.tsx`)
*   **Structure:** Fixed "Cyber-Glass" Navbar + Main Content + Footer.
*   **Navigation:**
    *   Links: Dashboard, Technology, Leaderboard, Performance, Proofs, Economy, Devnet, FAQ, Governance, S3 Adapter.
    *   Mobile: Hamburger menu with `framer-motion` slide-down.
*   **Child Components:** `ConnectWallet`, `ModeToggle`.

### 5.2 Dashboard (`src/components/Dashboard.tsx`)
The central hub for deal management.
*   **State:**
    *   `activeTab`: 'alloc' (Allocation), 'content' (Commitment), 'mdu' (Thick client).
    *   `deals`: List of user's deals (fetched from LCD).
    *   `providers`: Active SP list.
    *   `nilAddress`: Derived Cosmos address from connected EVM wallet.
*   **Key Interactions:**
    *   **Allocation:** Form -> `useCreateDeal` (Mode 1 or Mode 2 with RS selector).
    *   **Commitment (Content tab):** File Input -> `useUpload` -> `useUpdateDealContent`.
    *   **Commitment (MDU tab):** `FileSharder` (WASM) -> uploads metadata + shards -> `useUpdateDealContent`.
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
*   **Manifest Root Explainer:** Displays `manifest_root` and (if available) `manifest_blob_hex` plus the ordered root vector; optionally builds a debug Merkle tree over MDU roots behind a button (for intuition only; not the on-chain commitment).
    *   **Root Table (MDU #0):** Lists root-table entries (witness + user roots) and maps each entry to its `mdu_index`.
    *   **MDU Inspector:** For a selected MDU, fetches and displays the 64 blob commitments and the derived MDU root.
*   **APIs (gateway or direct SP base):**
    *   **Slab layout:** `GET /gateway/slab/{manifest_root}?deal_id=...&owner=...` (summary + segment ranges).
    *   **NilFS file list:** `GET /gateway/list-files/{manifest_root}?deal_id=...&owner=...` (authoritative; parsed from `mdu_0.bin`).
    *   **Fetch file (NilFS path):**
        *   Plan range: `GET /gateway/plan-retrieval-session/{manifest_root}?deal_id=...&owner=...&file_path=...`.
        *   Data plane: `GET /gateway/fetch/{manifest_root}?deal_id=...&owner=...&file_path=...` with `X-Nil-Session-Id` header (session opened on-chain via MetaMask).
        *   Errors are JSON `{ error, hint }`: `400` (missing/unsafe), `403` (owner mismatch), `404` (not found/tombstone), `409` (stale `manifest_root` or inconsistent NilFS state).
    *   **Manifest details:** `GET /gateway/manifest-info/{manifest_root}?deal_id=...&owner=...` (manifest blob + ordered MDU roots).
    *   **MDU KZG details:** `GET /gateway/mdu-kzg/{manifest_root}/{mdu_index}?deal_id=...&owner=...` (64 blob commitments + MDU root).
    *   **Legacy manifest (debug, deprecated):** `GET /gateway/manifest/{cid}` (legacy per-upload artifacts; `cid` is an alias for `manifest_root`; expected to be removed as NilFS-only flows harden).

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
*   **`FileSharder.tsx`:** Thick-client sharder. Uses `nil_core` WASM to expand MDUs, generate commitments, and (for Mode 2) produce RS shards. Uploads via the transport router and supports direct-to-SP flows.

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
    *   `PerformanceDeepDive`: Performance market + latency racer visualization.

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
*   **`AdversarialSimulation.tsx`:** Archived incentive simulation (local NVMe vs. remote storage).
    *   Uses `recharts` to plot Profit/Loss of local vs remote providers over time.
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
| **Storage Gateway (optional)** | `gatewayBase` | `http://localhost:8080` |
| **Storage Provider (direct)** | `spBase` | `http://localhost:8082` |
| **EVM JSON-RPC** | `evmRpc` | `http://localhost:8545` |

### Key Endpoints
*   `POST /gateway/upload`: `FormData{file, owner, deal_id?, max_user_mdus?, file_path?}` -> `{manifest_root, size_bytes, file_size_bytes, total_mdus, file_path, filename}` (legacy aliases: `cid`, `allocated_length`).
*   `POST /sp/upload_shard`: Raw shard bytes with headers `X-Nil-Deal-ID`, `X-Nil-Mdu-Index`, `X-Nil-Slot`, `X-Nil-Manifest-Root` (Mode 2).
*   `GET /sp/shard?deal_id=...&manifest_root=...&mdu_index=...&slot=...`: Streams a stored shard (Mode 2).
*   `GET /gateway/slab/{manifest_root}?deal_id=...&owner=...`: Returns slab segment ranges + counts (MDU #0 / Witness / User).
*   `GET /gateway/list-files/{manifest_root}?deal_id=...&owner=...`: `{ manifest_root, total_size_bytes, files:[{path,size_bytes,start_offset,flags}] }` (deduplicated: latest non-tombstone record per path).
*   `GET /gateway/plan-retrieval-session/{manifest_root}?deal_id=...&owner=...&file_path=...`: Returns blob-range plan for retrieval sessions.
*   `GET /gateway/fetch/{manifest_root}?deal_id=...&owner=...&file_path=...`: Streams file bytes with `X-Nil-Session-Id` header (encode `file_path` with `encodeURIComponent`; errors are JSON `{error,hint}`).
*   `POST /gateway/session-proof`: `{session_id}` -> `{session_id}` (gateway forwards provider proof submission).
*   `POST /gateway/prove-retrieval`: `{deal_id, epoch_id, manifest_root, file_path}` -> `{tx_hash}` (legacy devnet helper; deprecated).
*   `GET /gateway/status`: Local gateway status/capabilities (optional).
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
| `/devnet` | `Devnet` | Guide: Join multi-provider devnet. |
| `/technology` | `TechnologyLayout` | Wrapper for tech deep dives. |
| `/technology/kzg` | `KZGDeepDive` | Explainer: Polynomial Commitments. |
| `/technology/sharding` | `ShardingDeepDive` | Explainer: Erasure Coding. |
| `/leaderboard` | `Leaderboard` | Table: Top SPs by score. |
| `/proofs` | `ProofsDashboard` | Stream: Live ZK verification. |
| `/performance` | `PerformanceReport` | Metrics: Performance market/chain benchmarks. |
| `/economy` | `EconomyDashboard` | Simulation: Token + storage economics. |
| `/faq` | `FAQ` | Frequently asked questions. |
| `/whitepaper` | `Whitepaper` | PDF/Markdown render of spec. |
| `/s3-adapter` | `S3AdapterDocs` | Guide: Using S3 compatibility. |
| `/governance` | `GovernanceDocs` | DAO + council overview. |
| `/adversarial-simulation` | `AdversarialSimulation` | Archived incentive simulation. |

---

## 8. Spec Compliance & Implementation Reality (Gap Analysis)

**Critical Note:** As of v2.7, the web frontend is a **Hybrid Client**. It can operate without a local gateway (direct SP + OPFS) and now supports a thick-client WASM sharding path alongside the legacy gateway ingest path.

### 8.1 Data Ingestion (Upload)
*   **Spec:** Client locally packs files into 8 MiB MDUs, computes KZG commitments (Triple Proof root), and uploads encrypted shards to SPs.
*   **Actual (two paths):**
    1. **Gateway ingest (Content tab):** Client uploads raw `FormData` to `/gateway/upload` (gateway or SP base). The server performs sharding, KZG commitments, and NilFS packing, returning `manifest_root` and `size_bytes`.
    2. **Thick client ingest (MDU tab):** Client uses WASM to shard locally, uploads metadata MDUs to all slots (`/sp/upload_mdu`) and user shards via `/sp/upload_shard` (Mode 2), then commits the `manifest_root` on-chain.

### 8.2 Data Retrieval (Download)
*   **Spec:** Client fetches chunks from SPs (or gateway acting as SP proxy), verifies the KZG Triple Proof, and confirms success on-chain.
*   **Actual (Gamma‑4):**
    1.  Client plans a retrieval session via `GET /gateway/plan-retrieval-session/...` (gateway or direct SP).
    2.  Client opens the session on-chain (MetaMask `openRetrievalSession`).
    3.  Client fetches bytes via `GET /gateway/fetch/...` with `X‑Nil‑Session‑Id` header.
    4.  Client confirms completion on-chain (`confirmRetrievalSession`).
    5.  Gateway forwards `POST /gateway/session-proof` to submit provider proofs.
*   **Implication:** Browser holds the **Liveness Authority** (on‑chain session open/confirm). Gateway is a relay/compute helper, not a signer.

### 8.3 Visualizations vs. Logic
*   **`FileSharder.tsx`:** Uses `nil_core` WASM to generate real MDU roots, manifest commitments, and Mode 2 shards; outputs are valid for on-chain commit.
*   **Real Data Flow:** The actual data flow for a deal is:
    1.  `useCreateDeal` -> Creates a thin-provisioned Deal on-chain.
    2.  **Gateway path:** `useUpload` streams raw file to Gateway -> Gateway returns `manifest_root`.
    3.  **Thick path:** `FileSharder` uses WASM to shard -> uploads to SPs -> yields `manifest_root`.
    4.  `useUpdateDealContent` -> Commits the `manifest_root` to the chain.

---

## 9. Deal Observables & TDD Refinement

This sprint prioritizes a clean separation between:
- **Model/domain logic (Node-testable):** parsing/normalizing LCD + Gateway responses into stable “observables”.
- **Controller logic (Node-testable):** orchestrating reads across LCD + Gateway (slab layout + file list).
- **Visualization (React):** rendering panels using the centralized observables.

### 9.1 Primary Observables (Authoritative Sources)
*   **Deal (LCD):** `GET /nilchain/nilchain/v1/deals` → `Deal.id`, `Deal.owner`, `Deal.manifest_root` (48 bytes), `Deal.size`.
*   **Heat (LCD):** `GET /nilchain/nilchain/v1/deals/{deal_id}/heat` → `bytes_served_total`, `successful_retrievals_total`, `failed_challenges_total`.
*   **Slab layout (Gateway):** `GET /gateway/slab/{manifest_root}?deal_id=...&owner=...` → `total_mdus`, `witness_mdus`, `user_mdus`, and segment ranges (MDU #0, witness, user).
*   **NilFS file table (Gateway):** `GET /gateway/list-files/{manifest_root}?deal_id=...&owner=...` → `{files:[{path,size_bytes,start_offset,flags}]}` parsed from `mdu_0.bin`.
*   **Upload staging (Gateway response):** `POST /gateway/upload` → `{manifest_root,size_bytes,file_size_bytes,total_mdus,file_path}` (legacy alias: `allocated_length`) used for immediate UX before LCD reflects the commit.

### 9.2 Tests
*   **Node unit tests:** validate domain normalization and controller orchestration (no React/DOM required).
    *   Command: `npm run test:unit`
*   **Opt-in local-stack e2e (Node):** uses the same TypeScript clients to run:
    1. Create deal (MetaMask precompile)
    2. Upload file (→ `/gateway/upload` on gateway or SP)
    3. Commit content (MetaMask precompile)
    4. Verify LCD deal state + slab/files
    *   Command: `VITE_E2E=1 npm run test:unit` (requires `./scripts/run_local_stack.sh start` running)
*   **Browser smoke e2e (Playwright, target):**
    *   Runs headless against `./scripts/run_local_stack.sh start`.
    *   Uses a deterministic injected wallet shim when `VITE_E2E=1` (no MetaMask extension automation).
    *   Gateway-absent path: `scripts/e2e_browser_smoke_no_gateway.sh` (direct SP + OPFS).

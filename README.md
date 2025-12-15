# NilStore Network (Testnet Phase 3)

NilStore is a decentralized storage network optimizing for performance and verifiability without sealing. This repository contains the full stack for the "Store Wars" Incentivized Testnet.

## 🚀 Getting Started

### 1. Quick Start (Release Binaries)
Download the latest release from `dist/` and extract it.

```bash
tar -xvf nilstore-v0.1.0-rc1-Darwin-arm64.tar.gz
cd dist
./bin/nilchaind start
```

### 2. Build from Source

**Prerequisites:**
*   Go 1.22+
*   Rust (latest stable)
*   Make
*   Clang/GCC

```bash
# Build everything
./release.sh
```

### 3. Running the Network (Local DevNet)

We provide an automated script to spin up a local chain, register providers, and run a full lifecycle test.

```bash
# Run End-to-End "Happy Path"
./e2e_flow.sh

# Run Elasticity & Budget Checks
./e2e_elasticity.sh

# Run Slashing & Fault Injection
./e2e_slashing.sh
```

## 📦 Components

*   **`nilchain` (L1):** The consensus layer (Cosmos SDK). Handles deals, proofs (KZG), and economics.
*   **`nil_core` (Rust):** Cryptographic primitives (KZG, Merkle, Reed-Solomon) exposed via C-FFI and WASM.
*   **`nil_cli`:** Client tool for sharding files and generating commitments.
*   **`nil_gateway`:** S3-compatible gateway for Web2 apps.
*   **`nil_faucet`:** Token faucet service for testnet users.
*   **`nil-website`:** The frontend explorer and dashboard (React).

## 🌐 Web Dashboard & Faucet

To run the frontend explorer:

```bash
cd nil-website
npm install
npm run dev
```

To run the Faucet service (requires running chain):

```bash
cd nil_faucet
./nil_faucet
```

## 📊 Economics & Governance

*   **Token:** $NIL ($STOR)
*   **Inflation:** Halving every 1000 blocks.
*   **Elasticity:** User-funded "Stripe-Aligned Scaling".
*   **Governance:** On-chain parameter updates via `MsgUpdateParams`.

See `ECONOMY.md` for the full tokenomics specification.

## 📚 Documentation

See `DOCS.md` for a curated index of canonical protocol docs, RFCs, and working notes.

## 🧩 Multi-Provider Devnet (Join Guide)

- Local multi-provider devnet (single machine): `PROVIDER_COUNT=5 ./scripts/run_devnet_alpha_multi_sp.sh start`
- Hub + remote providers: see `DEVNET_MULTI_PROVIDER.md`

## 🧪 Performance Benchmarks

See `performance/PERFORMANCE_TEST_PLAN.md` and the **Performance Report** page on the website for detailed benchmarks.

## 🤝 Contributing

Please read `CONTRIBUTING.md` (coming soon) for details on our code of conduct and the process for submitting pull requests.

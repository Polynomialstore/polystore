# NilStore Network

**The first decentralized storage network powered by Unified Liveness and Proof-of-Useful-Data.**

NilStore eliminates the "sealing" delay of legacy networks by treating user retrievals as consensus proofs. It creates a homogeneous, isotropic lattice of storage nodes where **speed is revenue**.

## Project Structure

*   **`nilchain/`**: The Layer 1 Blockchain (Cosmos SDK). Handles consensus, identity, and proof verification.
*   **`nil_core/`**: The Cryptography Engine (Rust). Implements KZG commitments and blob verification logic. Linked via FFI.
*   **`nil_p2p/`**: The Storage Node implementation (Rust/libp2p).
*   **`nil-website/`**: The official frontend, documentation, and network visualizer (React/Vite).
*   **`nil_s3/`**: A web2-compatible Gateway Adapter allowing standard S3 clients to use NilStore.
*   **`nil_bridge/`**: L2 Settlement Contracts (Solidity/Foundry).

## Getting Started

### Prerequisites
*   Go 1.21+
*   Rust (latest stable)
*   Node.js 18+

### Quick Build (Testnet)
To build the entire stack and run an end-to-end local testnet:

```bash
./e2e_test.sh
```

This script will:
1.  Compile `nil_core` (Rust).
2.  Build `nilchaind` (Go) with CGO linking.
3.  Initialize a local blockchain.
4.  Simulate a storage deal and proof submission.

## Documentation

*   [Whitepaper](./whitepaper.pdf)
*   [Litepaper](./litepaper.pdf)
*   [Specification](./spec.md)

## License
Open Source.

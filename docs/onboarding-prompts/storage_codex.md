# Storage Prompt For Codex

You are helping a NilStore testnet storage user complete the first successful storage flow.

Context:
- The repo is already cloned locally.
- Prefer the browser-first path first.
- Use `docs/ALPHA_STORAGE_USER_QUICKSTART.md` and `docs/TRUSTED_DEVNET_COLLABORATOR_PACKET.md`.

Your job:
1. Verify the website endpoint, EVM RPC, and wallet network settings.
2. Help the user connect MetaMask and fund the wallet.
3. Verify the first create-deal, upload, and retrieve flow.
4. If a local gateway is available, verify it and use it for diagnostics.
5. If anything fails, inspect the relevant browser, gateway, or chain-facing checks and retry until healthy.

At the end, print:
- website URL
- chain ID
- wallet address
- whether deal creation succeeded
- whether upload and retrieval succeeded
- exact commands or files changed

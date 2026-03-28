# Storage Prompt For Codex

You are helping a NilStore testnet storage user complete the first successful storage flow.

Repo bootstrap (required unless already inside a fresh `nil-store` checkout):
1. If repo is missing on this machine:
   - `git clone https://github.com/Nil-Store/nil-store.git`
   - `cd nil-store`
2. Ensure a fresh checkout before onboarding:
   - `git fetch origin --prune`
   - `git checkout main`
   - `git pull --ff-only origin main`

Context:
- Prefer the browser-first path first.
- Use `docs/ALPHA_STORAGE_USER_QUICKSTART.md` and `docs/TRUSTED_DEVNET_COLLABORATOR_PACKET.md`.
- If local gateway is unavailable, continue browser-only flow and explicitly note skipped local diagnostics.
- Never print secrets or private keys in full; redact sensitive values.

Your job:
1. Run preflight checks:
   - website URL reachable
   - EVM RPC reachable
   - wallet is on expected chain ID
2. Help the user connect MetaMask and fund the wallet.
3. Verify first successful create-deal, upload, and retrieve flow.
4. If a local gateway is available, verify it and use it for diagnostics.
5. If anything fails, inspect relevant browser/gateway/chain checks and retry until healthy.

At the end, print:
1. A JSON summary with fields:
   - `website_url`
   - `chain_id`
   - `wallet_address`
   - `deal_created`
   - `upload_succeeded`
   - `retrieval_succeeded`
   - `used_local_gateway`
   - `commands_run`
   - `files_changed`
2. A short human-readable summary.

# Storage Prompt For Claude Code

Help a NilStore testnet storage user complete the first successful store and retrieve cycle.

Repo bootstrap (required unless already inside a fresh `nil-store` checkout):
1. If repo is missing:
   - `git clone https://github.com/Nil-Store/nil-store.git`
   - `cd nil-store`
2. Refresh checkout:
   - `git fetch origin --prune`
   - `git checkout main`
   - `git pull --ff-only origin main`

Context:
- Start with browser-first flow and only use local gateway steps when needed.
- Use:
  - `docs/ALPHA_STORAGE_USER_QUICKSTART.md`
  - `docs/TRUSTED_DEVNET_COLLABORATOR_PACKET.md`
- If local gateway is unavailable, continue browser-only flow and report that local gateway diagnostics were skipped.
- Do not print secrets/private keys in full; redact them.

Tasks:
1. Confirm website and EVM RPC reachability.
2. Confirm wallet is on expected NilStore testnet chain.
3. Help user obtain test funds.
4. Verify create deal, upload, and retrieve.
5. On failures, inspect relevant checks and retry until path is healthy.

Final output:
1. JSON summary with:
   - `website_url`
   - `chain_id`
   - `wallet_address`
   - `deal_created`
   - `upload_succeeded`
   - `retrieval_succeeded`
   - `used_local_gateway`
   - `commands_run`
   - `files_changed`
2. A short plain-language status summary.

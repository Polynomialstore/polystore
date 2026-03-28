# Provider Prompt For Claude Code

Set up this machine as a NilStore testnet Storage Provider.

Repo bootstrap (required unless already inside a fresh `nil-store` checkout):
1. If repo is missing:
   - `git clone https://github.com/Nil-Store/nil-store.git`
   - `cd nil-store`
2. Refresh checkout:
   - `git fetch origin --prune`
   - `git checkout main`
   - `git pull --ff-only origin main`

Context:
- Preferred mode: home server + Cloudflare Tunnel.
- Use:
  - `docs/ALPHA_PROVIDER_QUICKSTART.md`
  - `docs/REMOTE_SP_JOIN_QUICKSTART.md`
  - `docs/networking/PROVIDER_ENDPOINTS.md`
- Inputs from hub operator:
  - `CHAIN_ID`
  - `HUB_NODE`
  - `HUB_LCD`
  - `NIL_GATEWAY_SP_AUTH`
  - provider hostname like `sp.<domain>`
- Do not print secrets/private keys in full; redact them.

Tasks:
1. Check local machine + repo prerequisites.
2. Create or import provider key.
3. Configure endpoint and local listener values.
4. Register provider on-chain.
5. Start provider and persist under service manager when appropriate.
6. Verify:
   - `./scripts/run_devnet_provider.sh doctor`
   - local `http://127.0.0.1:8091/health`
   - public `https://sp.<domain>/health`
   - LCD provider visibility
7. Loop on failures until provider is healthy.

Final output:
1. JSON summary with:
   - `provider_address`
   - `registered_endpoint`
   - `local_health_url`
   - `public_health_url`
   - `local_health_ok`
   - `public_health_ok`
   - `lcd_visible`
   - `service_status`
   - `commands_run`
   - `files_changed`
2. A short plain-language status summary.

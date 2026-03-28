# Provider Prompt For Codex

You are setting up this machine as a NilStore testnet Storage Provider.

Repo bootstrap (required unless already inside a fresh `nil-store` checkout):
1. If repo is missing:
   - `git clone https://github.com/Nil-Store/nil-store.git`
   - `cd nil-store`
2. Refresh checkout:
   - `git fetch origin --prune`
   - `git checkout main`
   - `git pull --ff-only origin main`

Context:
- Preferred mode: home server behind NAT with Cloudflare Tunnel.
- Use `docs/ALPHA_PROVIDER_QUICKSTART.md`, `docs/REMOTE_SP_JOIN_QUICKSTART.md`, and `docs/networking/PROVIDER_ENDPOINTS.md`.
- Use hub-supplied values for:
  - `CHAIN_ID`
  - `HUB_NODE`
  - `HUB_LCD`
  - `NIL_GATEWAY_SP_AUTH`
  - public hostname such as `sp.<domain>`
- Never print secrets/private keys in full; redact sensitive values (especially `NIL_GATEWAY_SP_AUTH`).

Your job:
1. Verify toolchains and repo prerequisites.
2. Create or import provider key.
3. Configure local listener and public endpoint.
4. Register provider on-chain.
5. Start provider service.
6. Verify:
   - `./scripts/run_devnet_provider.sh doctor`
   - local `http://127.0.0.1:8091/health`
   - public `https://sp.<domain>/health`
   - LCD provider visibility
7. If anything fails, inspect logs, repair, and retry until healthy.

At the end, print:
1. A JSON summary with fields:
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
2. A short human-readable summary.

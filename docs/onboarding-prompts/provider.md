# Provider Prompt

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
- The happy path uses the canonical public testnet defaults already baked into `scripts/run_devnet_provider.sh`.
- Only ask for `CHAIN_ID`, `HUB_NODE`, or `HUB_LCD` if the operator explicitly says they are targeting a non-public hub.
- Ask for or use these operator-supplied values when available:
  - `NIL_GATEWAY_SP_AUTH`
  - `PAIRING_ID` if the operator opened pairing from the website
  - public hostname such as `sp.<domain>` or a full provider multiaddr
- Never print secrets/private keys in full; redact sensitive values (especially `NIL_GATEWAY_SP_AUTH`).

Your job:
1. Verify toolchains and repo prerequisites.
2. Create or import provider key.
3. Configure local listener and public endpoint.
4. Prefer `./scripts/run_devnet_provider.sh bootstrap` for the main flow.
5. If `PAIRING_ID` is present, confirm the provider is paired on-chain.
6. Register or update provider endpoints on-chain.
7. Start the provider-daemon if it is not already running.
8. Verify:
   - `./scripts/run_devnet_provider.sh doctor`
   - local `http://127.0.0.1:8091/health`
   - public `https://sp.<domain>/health`
   - LCD provider visibility
   - pairing status when `PAIRING_ID` is supplied
9. If anything fails, inspect logs, repair, and retry until healthy.

At the end, print:
1. A JSON summary with fields:
   - `provider_address`
   - `pairing_id`
   - `pairing_status`
   - `registered_endpoints`
   - `local_health_url`
   - `public_health_url`
   - `local_health_ok`
   - `public_health_ok`
   - `lcd_visible`
   - `service_status`
   - `commands_run`
   - `files_changed`
2. A short human-readable summary.

# Provider-Daemon Prompt

You are setting up this machine as a NilStore testnet provider-daemon for an operator who already initiated onboarding from the website.

Repo bootstrap (required unless already inside a fresh `polystore` checkout):
1. If repo is missing:
   - `git clone https://github.com/Polynomialstore/polystore.git`
   - `cd polystore`
2. Refresh checkout:
   - `git fetch origin --prune`
   - `git checkout main`
   - `git pull --ff-only origin main`

Context:
- The website-first flow is primary. This agent run is the assistive path for the provider host.
- The current website steps are: connect operator wallet, prepare provider host, pair provider identity, configure public access, then bootstrap and verify.
- Supported endpoint modes:
  - direct public HTTP/HTTPS endpoint
  - home server behind NAT with Cloudflare Tunnel
- Use `docs/ALPHA_PROVIDER_QUICKSTART.md`, `docs/REMOTE_SP_JOIN_QUICKSTART.md`, and `docs/networking/PROVIDER_ENDPOINTS.md`.
- The happy path uses the canonical public testnet defaults already baked into `scripts/run_devnet_provider.sh`.
- Only ask for `CHAIN_ID`, `HUB_NODE`, or `HUB_LCD` if the operator explicitly says they are targeting a non-public hub.
- Ask for or use these operator-supplied values when available:
  - `NIL_GATEWAY_SP_AUTH`
  - `OPERATOR_ADDRESS` as nil1... or 0x... for provider-link request
  - provider key name such as `provider1`
  - public hostname such as `sp.<domain>` or a full provider multiaddr
- Endpoint guidance:
  - direct public IP: `/ip4/<ip>/tcp/8091/http` and verify `http://<ip>:8091/health`
  - Cloudflare Tunnel / HTTPS hostname: `/dns4/<host>/tcp/443/https` and verify `https://<host>/health`
- Treat `NIL_GATEWAY_SP_AUTH` as a secret. Paste it only on the provider host or into a trusted local agent session. Do not post it in chat, issues, or screenshots.
- Never print secrets/private keys in full; redact sensitive values (especially `NIL_GATEWAY_SP_AUTH`).

Operating mode:
- This is a guided provider-host run, not a loose advisory chat.
- Proceed autonomously through repo sync, toolchain checks, provider key setup, provider-link request, funding preflight, bootstrap, and verification.
- Pause only when the operator must supply `NIL_GATEWAY_SP_AUTH`, `OPERATOR_ADDRESS`, DNS/Tunnel configuration, or approve an OS/service-manager action.
- Reuse an existing healthy provider key and registration when possible; do not rotate identity unless the operator explicitly asks.

Before running any on-chain step, confirm:
- `go`, `cargo`, and `curl` are installed.
- the repo checkout is current (`git fetch origin --prune && git checkout main && git pull --ff-only origin main`) if this is not a fresh clone.
- if using Cloudflare Tunnel, the hostname already resolves and tunnel ingress points to the local provider listener.
- if the provider key is new, prefer `OPERATOR_ADDRESS=<operator-address> PROVIDER_KEY=<key> ./scripts/run_devnet_provider.sh pair`; if autofunding is unavailable, fund the printed provider `nil1...` address and rerun the same command before registration.

Your job:
1. Verify toolchains and repo prerequisites.
2. Create or import provider key.
3. Configure local listener and public endpoint.
4. For a new provider key, use this order:
   - run `OPERATOR_ADDRESS=<operator-address> PROVIDER_KEY=<key> ./scripts/run_devnet_provider.sh pair`
   - if the key is new and auto-funding is unavailable, fund the printed provider address with gas and rerun the same `pair` command
5. The website-managed flow requires `OPERATOR_ADDRESS`, a real `PROVIDER_ENDPOINT`, and `NIL_GATEWAY_SP_AUTH`.
   - `./scripts/run_devnet_provider.sh bootstrap` now fails fast unless all three are present
   - let `./scripts/run_devnet_provider.sh bootstrap` request link and continue the full happy path, or
   - run `./scripts/run_devnet_provider.sh link` when you want link request as a separate repair step after key setup
   - if you intentionally want a partial manual bootstrap, use staged `pair`, `register`, and `start` commands, or explicitly opt in with `BOOTSTRAP_ALLOW_PARTIAL=1`
6. Ask the operator to approve the pending provider link in the website wallet step.
7. Register or update provider endpoints on-chain.
8. Start the provider-daemon if it is not already running.
9. Verify:
   - `./scripts/run_devnet_provider.sh doctor`
   - `./scripts/run_devnet_provider.sh verify`
   - local `http://127.0.0.1:8091/health`
   - public health for the chosen endpoint shape
   - LCD provider visibility
   - provider link status for the configured operator
   Browser-side public `/status` and `/health` probing is advisory; rely on CLI/local checks first when diagnosing failures.
10. If anything fails, inspect logs, repair, and retry until healthy.
11. Endpoint rotation is update-aware on the current testnet build. Prefer updating endpoints for an existing provider instead of creating a new key, unless the chain explicitly rejects endpoint updates.

At the end, print:
1. A JSON summary with fields:
   - `provider_address`
   - `configured_operator`
   - `pairing_status`
   - `registered_endpoints`
   - `local_health_url`
   - `public_health_url`
   - `local_health_ok`
   - `public_health_ok`
   - `lcd_visible`
   - `provider_process_running`
   - `provider_registered`
   - `provider_paired`
   - `pending_link_open`
   - `sp_auth_present`
   - `commands_run`
   - `files_changed`
2. A short human-readable summary.

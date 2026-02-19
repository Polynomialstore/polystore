# Runtime Personas and Ownership (Source of Truth)

This document defines the runtime persona contract for NilStore processes.

If any other doc uses ambiguous terms like "router" or generic "gateway", this file is authoritative for naming and behavior.

## Personas

### `user-gateway`
- Purpose: client-facing gateway for browser and desktop GUI flows.
- Primary APIs: `/gateway/*`, `/health`, `/status`.
- Typical local endpoint: `http://127.0.0.1:8080`.
- Responsibilities:
  - upload/retrieval orchestration
  - cache/freshness checks
  - retrieval session and proof-related gateway workflows
- Must not require local provider identity to operate in user mode.

### `provider-daemon`
- Purpose: storage-provider-facing process that serves provider data-plane/control-plane APIs.
- Primary APIs: `/sp/*` (and provider-side receipt/session endpoints as configured).
- Typical local endpoints: provider ports (for example `8082+` in local stack scripts, `8091+` in multi-SP devnet scripts).
- Responsibilities:
  - store/serve shards and MDUs
  - provider-side session/receipt/proof handling

### Other independent daemons
- `nilchain` (chain/LCD/EVM), `nil_faucet`, and website are separate daemons.
- In local/dev environments they can run on one host, but ownership and lifecycle remain separate.

## Allowed call graph

### Gateway mode (preferred when `user-gateway` is healthy)
- Browser -> `user-gateway` only (`:8080`).
- `user-gateway` -> `provider-daemon` as needed for SP operations.

### Fallback mode (when `user-gateway` is unavailable)
- Browser may call `provider-daemon` endpoints directly.

## Terminology migration and compatibility

- "router gateway", "gateway router", and "router mode" are legacy terms.
- Canonical terms are:
  - `user-gateway`
  - `provider-daemon`
- Legacy env/code names may remain temporarily for compatibility, but new docs/logs/UI should use canonical terms and explicitly note legacy aliases when needed.

## Operational expectations

- Desktop GUI owns/manages the local `user-gateway` when running in managed mode.
- Provider processes are separate daemons and should be treated as independent personas, even on localhost.
- Any change that affects runtime role boundaries must update this file and any referenced runbooks/specs in the same PR.

## Local command mapping (authoritative shortcuts)

From repo root:

- `./scripts/run_local_stack.sh restart-gateway-user`
  - Starts/restarts the external `user-gateway` persona (`127.0.0.1:8080`).
- `./scripts/run_local_stack.sh restart-gateway-sp`
  - Starts/restarts `provider-daemon` persona processes for local SP ports.
- `./scripts/run_local_stack.sh stop-gateway-user`
  - Stops external `user-gateway`.
- `./scripts/run_local_stack.sh stop-gateway-sp`
  - Stops local `provider-daemon` processes.
- `./scripts/ensure_stack.sh`
  - Full local stack bring-up (chain/faucet/providers/user-gateway/web) for devnet-style testing.

From `nil_gateway_gui/`:

- `npm run desktop` (`desktop:user`)
  - GUI-managed `user-gateway` mode. Stops external user-gateway first, then launches desktop app.
- `npm run desktop:with-sp`
  - Ensures SP daemons are running, then launches GUI-managed desktop mode.
- `npm run sp:ensure` / `npm run sp:stop`
  - Manage only local provider-daemon processes.

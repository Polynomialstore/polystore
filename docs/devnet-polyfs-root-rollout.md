# PolyFS Root Devnet Rollout

Use `scripts/update_devnet_stack.sh` when rolling out proof-format-coupled changes to the local trusted devnet on this machine.

The script rebuilds and installs:

- `polystore_core/target/release/libpolystore_core.so`
- `polystorechain/polystorechaind`
- `polystore_gateway/polystore_gateway`
- `polystore_faucet/polystore_faucet`
- `polystore_cli/target/release/polystore_cli`
- `polystorechain/trusted_setup.txt`

It restarts services in this order:

1. Stop user providers: `polystore-provider1.service` through `polystore-provider4.service`.
2. Stop hub services: `polystore-gateway-router.service`, `polystore-faucet.service`, then `polystorechaind.service`.
3. Install artifacts with backups and sha256 evidence.
4. Start chain first.
5. Start faucet and router.
6. Start all providers, including provider4.

Tunnel services are not restarted by default. Use `--restart-tunnels` only when endpoint or tunnel config changes.

The default health endpoints match the current local devnet on this machine:

- RPC: `http://127.0.0.1:26657`
- LCD: `http://127.0.0.1:1317`
- EVM JSON-RPC: `http://127.0.0.1:8545`
- Router gateway: `http://127.0.0.1:18080`
- Faucet: `http://127.0.0.1:8081`
- Providers: `http://127.0.0.1:8091` through `http://127.0.0.1:8094`

Override these with `POLYSTORE_RPC_BASE`, `POLYSTORE_LCD_BASE`,
`POLYSTORE_EVM_BASE`, `POLYSTORE_ROUTER_BASE`, `POLYSTORE_FAUCET_BASE`, and
`POLYSTORE_PROVIDER_BASES` if a target machine uses different ports. The
checked-in systemd template still documents `8080` as a generic router example;
this machine's live `/etc/polystore` router env binds the managed devnet router
to `18080`.

## State Policy

The PolyFS root migration changes the trust root for new deals from the retired flat `manifest.bin` commitment to the MDU #0 PolyFS root. The rollout script is intentionally a binary/runtime rollout tool; it does not reset chain state and it does not silently migrate old committed deals.

When the chain/gateway proof-format PRs land, choose one of these policies before running live validation:

- **Reset devnet state**: preferred for alpha if the committed root field is not backward-compatible.
- **Explicit migration**: only if a migration script or chain upgrade handler exists and records old root to new root mapping.
- **Explicit legacy versioning**: only if the chain verifier has a deliberate legacy path for old alpha deals.

Do not treat green `/health` endpoints as proof-format compatibility. Final validation belongs in issue #218 and must include a new-format proof accepted by the local chain.

## Dry Run

Use:

```bash
scripts/update_devnet_stack.sh --dry-run --skip-build
```

This prints the source commit, target paths, provider inventory, stop/start order, install paths, and healthcheck commands without mutating services or files.

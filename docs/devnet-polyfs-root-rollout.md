# PolyFS Root Devnet Rollout

Use `scripts/update_devnet_stack.sh` when rolling out proof-format-coupled changes to the local trusted devnet on this machine.

The script rebuilds as the configured run user, then installs:

- `polystore_core/target/release/libpolystore_core.so`
- `polystorechain/polystorechaind`
- `polystore_gateway/polystore_gateway`
- `polystore_faucet/polystore_faucet`
- `polystore_cli/target/release/polystore_cli`
- `polystorechain/trusted_setup.txt`

It restarts services in this order:

1. Preflight source/target layout. Build mode refuses `--source-root == --target-root` so live artifacts are not overwritten while services are still running.
2. Preflight local command dependencies required for post-restart health polling, including `curl`.
3. Build artifacts as `--run-user`/`POLYSTORE_RUN_USER`; when invoked with `sudo`, this avoids root-owned Cargo/Go outputs in the source checkout.
4. Preflight all build artifacts before stopping any service.
5. Preflight the install plan. If a source artifact is already the target path, the later install step skips it instead of failing after services stop.
6. Preflight root service control. Live non-root runs must prove `sudo -n systemctl` works before any `provider-daemon` is stopped.
7. Preflight hub root service units so a missing chain, faucet, or legacy router unit cannot abort after provider-daemons are already stopped.
8. Resolve `provider-daemon` service managers. The default `auto` mode resolves the local user-service provider layout; the checked-in root provider template must be selected explicitly with `POLYSTORE_PROVIDER_SERVICE_SCOPE=root`.
9. Derive default provider health targets from known resolved service names unless `POLYSTORE_PROVIDER_BASES` is set. Unknown custom service names require explicit bases.
10. Stop `provider-daemon` services from their resolved manager: user services such as `polystore-provider1.service` through `polystore-provider4.service`, or root services such as `polystore-gateway-provider.service`.
11. Stop hub services: `polystore-gateway-router.service` (legacy service alias for the `user-gateway` persona), `polystore-faucet.service`, then `polystorechaind.service`.
12. Install artifacts with backups and sha256 evidence.
13. Start chain first.
14. Start faucet and the `user-gateway` legacy router service.
15. Start all resolved `provider-daemon` services, including provider4 when the local user-service layout is present.

Tunnel services are not restarted by default. Use `--restart-tunnels` only when endpoint or tunnel config changes.

The default health endpoints match the checked-in local devnet and systemd
templates:

- RPC: `http://127.0.0.1:26657`
- LCD: `http://127.0.0.1:1317`
- EVM JSON-RPC: `http://127.0.0.1:8545`
- `user-gateway` via legacy router service: `http://127.0.0.1:8080`
- Faucet: `http://127.0.0.1:8081`
- `provider-daemon` services: derived from resolved provider service names. The four local user-provider layout maps `polystore-provider1.service` through `polystore-provider4.service` to `8091` through `8094`; the checked-in single root-provider template maps `polystore-gateway-provider.service` to `8091`.

Override these with `POLYSTORE_RPC_BASE`, `POLYSTORE_LCD_BASE`,
`POLYSTORE_EVM_BASE`, `POLYSTORE_ROUTER_BASE`, `POLYSTORE_FAUCET_BASE`, and
`POLYSTORE_PROVIDER_BASES` if a target machine uses different ports. The
`POLYSTORE_ROUTER_BASE` env name is a legacy compatibility alias for the
`user-gateway` endpoint. If a target host's live `/etc/polystore` legacy router
env binds the managed devnet `user-gateway` to another port such as `18080`, set
`POLYSTORE_ROUTER_BASE` explicitly before running the rollout.
Set `POLYSTORE_PROVIDER_BASES` when a host's provider ports do not follow the
default known service-name mapping or when using custom provider service names.
When set, it must provide exactly one base URL for each resolved
`provider-daemon` service so rollout healthchecks cannot silently skip a
restarted provider.

Provider service management is controlled by `POLYSTORE_PROVIDER_SERVICE_SCOPE`:

- `auto` (default): resolve each default or configured provider service against user and root systemd managers before any stop/start action.
- `user`: require every configured provider service to exist in the user systemd manager.
- `root`: require every configured provider service to exist in the root systemd manager. With the checked-in provider template, use this with `POLYSTORE_PROVIDER_SERVICES=polystore-gateway-provider.service`.

If a service name exists in both managers, `auto` exits before stopping services; set the scope explicitly for that host.
The default `auto` inventory intentionally does not include the checked-in root
provider template, because a loaded-but-unused root template can collide with
the four user-provider devnet layout on port `8091`.

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

This prints the source commit, target paths, `provider-daemon` inventory,
preflight artifact status, stop/start order, install paths, and healthcheck
commands without mutating services or files. If a required artifact is missing,
the dry run exits before printing any service-stop plan, matching live rollout
safety behavior.

If `--source-root` and `--target-root` refer to the same live checkout, matching
artifact paths are supported only with `--skip-build`: they are reported before
the stop plan and skipped during install. Without `--skip-build`, the script
exits before building so it cannot partially overwrite live artifacts while
services are still running.
In live non-root mode, the script also verifies passwordless `sudo systemctl`
access before printing the service-stop plan. On this host, dry runs report that
check without requiring a sudo prompt.
Live runs also verify that all configured hub root service units are loaded and
that `curl` is available before any service-stop mutation.

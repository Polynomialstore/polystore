# PolyFS Root Devnet Rollout

Use `scripts/update_devnet_stack.sh` when rolling out proof-format-coupled changes to the local trusted devnet on this machine.

For local machines, prefer the rootless hub layout documented in
`docs/devnet-rootless-handoff.md`. After that one-time handoff,
`scripts/update_devnet_stack.sh` can manage `polystorechaind`,
`polystore-faucet`, and the `user-gateway` legacy router service with
`systemctl --user`, avoiding sudo/root blockers during routine deploys.

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
6. Preflight hub service units with non-mutating `systemctl show`, including dry-runs, so a missing chain, faucet, or legacy router unit cannot abort after provider-daemons are already stopped. Hub services can be resolved from the user or root systemd manager.
7. If `--restart-tunnels` is supplied, preflight tunnel user service units with non-mutating `systemctl --user show`.
8. Resolve `provider-daemon` service managers with non-mutating unit checks, including dry-runs. The default `auto` mode resolves the local user-service provider layout; the checked-in root provider template must be selected explicitly with `POLYSTORE_PROVIDER_SERVICE_SCOPE=root`.
9. Derive default provider health targets from known resolved service names unless `POLYSTORE_PROVIDER_BASES` is set. Unknown custom service names require explicit bases, and duplicate provider service names or duplicate canonical provider health bases fail before any service-stop mutation.
10. Preflight root service control only for services resolved from the root systemd manager. Live non-root runs must prove passwordless sudo authorization for exact root-managed `systemctl stop/start` actions before any `provider-daemon` is stopped. User-managed hub services do not require sudo.
11. If `--restart-tunnels` is supplied, stop tunnel user services before taking down the devnet stack.
12. Stop `provider-daemon` services from their resolved manager: user services such as `polystore-provider1.service` through `polystore-provider4.service`, or root services such as `polystore-gateway-provider.service`.
13. Stop hub services from their resolved manager: `polystore-gateway-router.service` (legacy service alias for the `user-gateway` persona), `polystore-faucet.service`, then `polystorechaind.service`.
14. Install artifacts with backups and sha256 evidence.
15. Start chain first.
16. Start faucet and the `user-gateway` legacy router service.
17. Start all resolved `provider-daemon` services, including provider4 when the local user-service layout is present.
18. If `--restart-tunnels` is supplied, verify restarted tunnel user services are active before reporting `DONE`.

Tunnel services are not restarted by default. Use `--restart-tunnels` only when endpoint or tunnel config changes. When enabled, tunnel user units must be loaded before any service-stop mutation, tunnel stop runs before the devnet stack is taken down, and tunnel stop/start plus post-restart `is-active` failures are fatal because local healthchecks do not prove the public tunnel process restarted.

The default health endpoints match the checked-in local devnet and systemd
templates:

- RPC: `http://127.0.0.1:26657`
- LCD: `http://127.0.0.1:1317`
- EVM JSON-RPC: `http://127.0.0.1:8545`
- `user-gateway` via legacy router service: `http://127.0.0.1:8080`
- Faucet: `http://127.0.0.1:8081`
- `provider-daemon` services: derived from resolved provider service names. The four local user-provider layout maps `polystore-provider1.service` through `polystore-provider4.service` to `8091` through `8094`; the checked-in single root-provider template maps `polystore-gateway-provider.service` to `8091`. If a configured provider inventory repeats a service name, or resolves two services to the same canonical health base including `localhost`/`127.0.0.1` aliases or omitted default ports, the rollout exits before stopping services.

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
`provider-daemon` service. Every configured service name and every canonical
base must be unique, so rollout healthchecks cannot silently poll one surviving
endpoint twice while skipping a restarted provider.

For the shared `polynomialstore.com` devnet, each provider service's
EnvironmentFile must also carry the public on-chain endpoint that matches the
local listener and ingress mapping:

- provider1 / `8091` -> `/dns4/sp1.polynomialstore.com/tcp/443/https`
- provider2 / `8092` -> `/dns4/sp2.polynomialstore.com/tcp/443/https`
- provider3 / `8093` -> `/dns4/sp3.polynomialstore.com/tcp/443/https`

Do not register `/ip4/127.0.0.1/...` or `localhost` as a shared-devnet SP
endpoint. Those addresses are only valid inside the provider host and will make
the provider unreachable for hub/client placement.

Provider service management is controlled by `POLYSTORE_PROVIDER_SERVICE_SCOPE`:

- `auto` (default): resolve each default or configured provider service against user and root systemd managers before any stop/start action.
- `user`: require every configured provider service to exist in the user systemd manager.
- `root`: require every configured provider service to exist in the root systemd manager. With the checked-in provider template, use this with `POLYSTORE_PROVIDER_SERVICES=polystore-gateway-provider.service`.

If a service name exists in both managers, `auto` exits before stopping services; set the scope explicitly for that host.
The default `auto` inventory intentionally does not include the checked-in root
provider template, because a loaded-but-unused root template can collide with
the four user-provider devnet layout on port `8091`.

Hub service management is controlled by `POLYSTORE_HUB_SERVICE_SCOPE`:

- `auto` (default): resolve `polystorechaind.service`,
  `polystore-faucet.service`, and `polystore-gateway-router.service` against
  user and root systemd managers.
- `user`: require all hub services to exist in the user systemd manager.
- `root`: require all hub services to exist in the root systemd manager.

If a hub service name exists in both managers, `auto` exits before stopping
services; set the scope explicitly. On rootless local devnets, run:

```bash
POLYSTORE_HUB_SERVICE_SCOPE=user scripts/update_devnet_stack.sh
```

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

This validates source layout, command dependencies, hub root unit inventory,
optional tunnel user unit inventory, `provider-daemon` unit inventory, provider
service uniqueness, health target derivation, and install preflight behavior,
then prints the source
commit, target paths, `provider-daemon` inventory, preflight artifact status,
stop/start order, install paths, and healthcheck commands without
mutating services or files. If a required artifact is missing, the dry run exits
before printing any service-stop plan, matching live rollout safety behavior.

If `--source-root` and `--target-root` refer to the same live checkout, matching
artifact paths are supported only with `--skip-build`: they are reported before
the stop plan and skipped during install. Without `--skip-build`, the script
exits before building so it cannot partially overwrite live artifacts while
services are still running.
In live non-root mode, the script also verifies passwordless sudo authorization
for exact root-managed `systemctl stop/start` actions before printing the
service-stop plan. On rootless hub devnets, this only applies to any
root-managed `provider-daemon` services that remain. On this host, dry runs
report that check without requiring a sudo prompt.
Dry-runs and live runs both verify that all configured hub service units are
loaded in their resolved systemd manager with non-mutating `systemctl show`.
Live runs also verify that `curl` is available before any service-stop mutation.
Final `systemctl is-active` status probes are best-effort evidence after the
healthchecks have passed; a restricted sudoers policy for status commands should
not mark an otherwise healthy rollout as failed.

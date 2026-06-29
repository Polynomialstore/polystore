# Devnet Rootless Handoff

The trusted devnet should not require root for routine chain binary rollouts.
Root should only be needed for machine-level ingress such as Caddy on `:443` or
for the first handoff from root systemd units to user systemd units.

## Why This Exists

The local hub services bind only high ports:

- `polystorechaind`: RPC/LCD/EVM ports such as `26657`, `1317`, `8545`, `8546`
- `polystore-faucet`: local faucet port such as `8081`
- `polystore-gateway-router`: local user-gateway port such as `8080`

These services do not need root. If they run as root, every deploy can block on
root-owned binaries, root-owned chain state, or unavailable sudo for
`systemctl restart`.

For local hosts that already run Prometheus on `:9090`, keep the chain gRPC
address explicit as `POLYSTORE_GRPC_ADDRESS=127.0.0.1:9091` in the user
systemd chain env. LCD REST and EVM JSON-RPC can start and then disappear when
the default Cosmos gRPC bind collides with another service.

## One-Time Handoff

Run this once from a repo checkout:

```bash
sudo -E scripts/devnet_rootless_handoff.sh --run-user "$USER"
```

The script:

- stops, disables, and masks the root hub units by default
- makes `/opt/polystore`, `/etc/polystore`, `/var/lib/nilstore`, and
  `/var/lib/polystore` owned by the run user
- installs the hub units into `~/.config/systemd/user`
- enables lingering for the run user
- starts the hub through `systemctl --user`

Use `--dry-run` to inspect the plan first:

```bash
sudo -E scripts/devnet_rootless_handoff.sh --run-user "$USER" --dry-run
```

If you want to install user units without starting them, pass `--no-start`.

## Routine Rollouts After Handoff

After handoff, recurring stack updates should resolve the hub from the user
systemd manager:

```bash
POLYSTORE_HUB_SERVICE_SCOPE=user scripts/update_devnet_stack.sh --dry-run --skip-build
POLYSTORE_HUB_SERVICE_SCOPE=user scripts/update_devnet_stack.sh
```

When the root units are masked, `scripts/update_devnet_stack.sh` can also use
the default `auto` mode and will resolve the hub services from the user manager.

Useful service commands:

```bash
systemctl --user status polystorechaind.service polystore-faucet.service polystore-gateway-router.service
systemctl --user restart polystorechaind.service
journalctl --user -u polystorechaind.service -f
```

## Root Still Belongs Elsewhere

This handoff does not try to manage privileged ingress. Caddy, DNS, and public
`:443` routing are still host-level concerns and may remain root-managed. The
goal is narrower: routine PolyStore devnet build/install/restart work should be
owned by the same unprivileged user that runs agents and local deploy scripts.

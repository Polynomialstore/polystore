# polystorechaind Redeploy Runbook

Use this runbook whenever you need to rebuild and roll out a new `polystorechaind` binary for a systemd-managed hub node.

Primary tool: [`scripts/redeploy_polystorechaind.sh`](/scripts/redeploy_polystorechaind.sh)

## What the script does

Default execution (`no flags`):
1. Loads `/etc/polystore/polystorechaind.env` (if present) to discover the live binary path.
2. Builds `polystorechain/polystorechaind` from your source checkout.
3. Backs up the live binary as `polystorechaind.bak.<timestamp>`.
4. Installs the new binary in place.
5. Prints the exact `sudo systemctl restart ...` command and verify command.

It does **not** restart by default, so you can control the maintenance window.

## Quick start (recommended)

From repo root:

```bash
./scripts/redeploy_polystorechaind.sh
```

Then run the printed restart command:

```bash
sudo systemctl restart polystorechaind && sudo systemctl status --no-pager polystorechaind
```

Then verify:

```bash
./scripts/redeploy_polystorechaind.sh --verify-only
```

## Useful options

```bash
# Verify only (no build/install)
./scripts/redeploy_polystorechaind.sh --verify-only

# Include pending-by-operator endpoint probe for a specific operator
./scripts/redeploy_polystorechaind.sh --verify-only \
  --operator-address nil19lnnwjulnxadhe05vwh7knsarz7ftgavw49tn7

# Show what would happen without changing anything
./scripts/redeploy_polystorechaind.sh --dry-run

# Use a different source checkout
./scripts/redeploy_polystorechaind.sh --source-root /path/to/polystore

# Attempt restart inline (uses sudo unless root)
./scripts/redeploy_polystorechaind.sh --with-restart
```

## Expected verify checks

`--verify-only` checks:
- `systemctl is-active` for the target service (default `polystorechaind`)
- LCD syncing endpoint (`/cosmos/base/tendermint/v1beta1/syncing`)
- Latest block height progression over a short interval
- Optional pending-by-operator route (if `--operator-address` provided):
  - `/polystorechain/polystorechain/v1/provider-pairings/pending-by-operator/{operator}`

## Rollback

If the new binary fails after restart, restore the backup and restart again.

1. Find latest backup:

```bash
ls -1t /opt/polystore/polystorechain/polystorechaind.bak.* | head -n 1
```

2. Restore and restart:

```bash
sudo cp -p /opt/polystore/polystorechain/polystorechaind.bak.<timestamp> /opt/polystore/polystorechain/polystorechaind
sudo systemctl restart polystorechaind
./scripts/redeploy_polystorechaind.sh --verify-only
```

## Notes

- The script defaults to building with `-mod=mod` so local rebuilds do not get stuck on stale vendor state.
- If `libpolystore_core` is missing, the script attempts to build `polystore_core` in the selected source checkout.
- Default runtime paths are tuned to this environment (`/opt/polystore`, `/etc/polystore/polystorechaind.env`) and can be overridden with flags.

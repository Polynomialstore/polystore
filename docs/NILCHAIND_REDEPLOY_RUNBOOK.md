# Nilchaind Redeploy Runbook

Use this runbook whenever you need to rebuild and roll out a new `nilchaind` binary for a systemd-managed hub node.

Primary tool: [`scripts/redeploy_nilchaind.sh`](/scripts/redeploy_nilchaind.sh)

## What the script does

Default execution (`no flags`):
1. Loads `/etc/nilstore/nilchaind.env` (if present) to discover the live binary path.
2. Builds `nilchain/nilchaind` from your source checkout.
3. Backs up the live binary as `nilchaind.bak.<timestamp>`.
4. Installs the new binary in place.
5. Prints the exact `sudo systemctl restart ...` command and verify command.

It does **not** restart by default, so you can control the maintenance window.

## Quick start (recommended)

From repo root:

```bash
./scripts/redeploy_nilchaind.sh
```

Then run the printed restart command:

```bash
sudo systemctl restart nilchaind && sudo systemctl status --no-pager nilchaind
```

Then verify:

```bash
./scripts/redeploy_nilchaind.sh --verify-only
```

## Useful options

```bash
# Verify only (no build/install)
./scripts/redeploy_nilchaind.sh --verify-only

# Include pending-by-operator endpoint probe for a specific operator
./scripts/redeploy_nilchaind.sh --verify-only \
  --operator-address nil19lnnwjulnxadhe05vwh7knsarz7ftgavw49tn7

# Show what would happen without changing anything
./scripts/redeploy_nilchaind.sh --dry-run

# Use a different source checkout
./scripts/redeploy_nilchaind.sh --source-root /path/to/polystore

# Attempt restart inline (uses sudo unless root)
./scripts/redeploy_nilchaind.sh --with-restart
```

## Expected verify checks

`--verify-only` checks:
- `systemctl is-active` for the target service (default `nilchaind`)
- LCD syncing endpoint (`/cosmos/base/tendermint/v1beta1/syncing`)
- Latest block height progression over a short interval
- Optional pending-by-operator route (if `--operator-address` provided):
  - `/nilchain/nilchain/v1/provider-pairings/pending-by-operator/{operator}`

## Rollback

If the new binary fails after restart, restore the backup and restart again.

1. Find latest backup:

```bash
ls -1t /opt/nilstore/nilchain/nilchaind.bak.* | head -n 1
```

2. Restore and restart:

```bash
sudo cp -p /opt/nilstore/nilchain/nilchaind.bak.<timestamp> /opt/nilstore/nilchain/nilchaind
sudo systemctl restart nilchaind
./scripts/redeploy_nilchaind.sh --verify-only
```

## Notes

- The script defaults to building with `-mod=mod` so local rebuilds do not get stuck on stale vendor state.
- If `libpolystore_core` is missing, the script attempts to build `polystore_core` in the selected source checkout.
- Default runtime paths are tuned to this environment (`/opt/nilstore`, `/etc/nilstore/nilchaind.env`) and can be overridden with flags.

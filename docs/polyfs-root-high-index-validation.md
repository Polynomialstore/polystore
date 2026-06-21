# PolyFS Root High-Index Validation

This runbook is the issue #218 closeout path for the MDU #0 PolyFS root migration.

The migration is complete only when the proof-format PRs, rollout PR, and live devnet evidence all agree on the same 32-byte PolyFS root contract.

## Non-Live Validation

Run the composed validation harness:

```sh
scripts/validate_polyfs_root_migration.sh
```

The default mode does not restart services. It validates:

- core MDU #0 root-table proof coverage, including indexes past the old flat-manifest boundary;
- chain keeper acceptance of high-index liveness and retrieval-session proofs;
- gateway proof generation for a sparse high-index slab without canonical `manifest.bin`;
- E2E script syntax for the 32-byte PolyFS dummy-root fixtures;
- the #217 rollout dry-run when `scripts/update_devnet_stack.sh` is present in the branch.

## Live Devnet Evidence

After #215, #216, and #217 are accepted as the selected rollout heads, run the actual rollout script from #217. Then collect non-mutating health evidence:

```sh
scripts/validate_polyfs_root_migration.sh --skip-build --live-devnet
```

This records active service state and endpoint health for:

- `polystorechaind.service`
- `polystore-faucet.service`
- `polystore-gateway-router.service`
- `polystore-provider1.service`
- `polystore-provider2.service`
- `polystore-provider3.service`
- `polystore-provider4.service`
- ports `1317`, `18080`, `8081`, `8091`, `8092`, `8093`, and `8094`

Endpoint health is not proof-format compatibility. The final closeout still needs a high-index proof accepted by the updated chain and a normal small lifecycle after the restart.

## Completion Gate

Do not close #212 or #218 until the final PR or issue comment records:

- selected source commit and branch for the rollout;
- artifact hashes from the #217 rollout output;
- restarted service list and endpoint health;
- high-index proof command/output for `mdu_index >= 4096`;
- small create/update/fetch/prove evidence after the same restart;
- any residual legacy `manifest.bin` caveat, explicitly marked as cache/debug only.

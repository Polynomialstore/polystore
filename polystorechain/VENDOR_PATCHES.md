# Required dependency corrections

Build/test the chain with `../scripts/chain_go.sh build|test|vet|install ...`
from this directory. The wrapper selects vendor mode even when the environment
sets `GOFLAGS=-mod=mod`, reconstructs dependencies when go.mod/go.sum change,
and preserves tracked source patches including uncommitted edits. Generated
`vendor/modules.txt` is retained from the new dependency graph. Run
`../scripts/chain_go.sh vendor` to force reconstruction. Stage newly added vendor
patch files before reconstruction. Use one build/preparation process per checkout.
Other Go modules keep their own dependency mode.

Do not run bare `go mod vendor` over the patches. The three EVM patch version
constants referenced by our precompile intentionally make an unpatched
`-mod=mod` build fail to compile. This is a consensus-affecting correction:
validators must use the same reviewed binary at a coordinated upgrade height;
these source changes alone do not activate retrieval v2.

Tracked baseline SDK corrections remain in cosmos-sdk `x/genutil/collect.go`,
`x/genutil/types/genesis_state.go` and `x/staking/types/msg.go`.

The EVM corrections are based on pinned `github.com/cosmos/evm v0.5.1`:

- `precompiles/common/precompile.go`: retain the native journal engine; give
  each native call its own remaining child gas budget, charge native work once
  including failed actions/balance processing, and preserve actual EVM OOG.
- `precompiles/common/balance_handler.go`: synchronize native events for module
  accounts too, so later EVM balance changes cannot overwrite native fees.
  Existing blocked-recipient authorization remains enforced; a disallowed EVM
  transfer fails and the enclosing SDK transaction cache is discarded.
- `x/vm/statedb/statedb.go`: restore cached events on rollback and publish only
  surviving new events to the caller on successful commit. A successful sibling
  after a caught revert must retain its events; prior caller events stay once.

The real app/store-backed regressions live in `app/precompile_native_test.go`.
When upgrading Cosmos EVM, compare these files against the new upstream version,
port or remove each correction only after those regressions pass, update the
tracked `vendor/modules.txt`, and retain the compile guards until equivalent
behavior is provided by the pinned dependency. No runtime fork selection exists.

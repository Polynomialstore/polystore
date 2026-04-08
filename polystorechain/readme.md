# polystorechain (NilStore L1)

`polystorechain` is the Cosmos SDK + Ethermint chain for NilStore. It tracks Deals,
Providers, retrieval sessions, rewards, Mode2 slot state, and audit/repair flows.

Canonical protocol spec: `../spec.md` and `../rfcs/`.

## Quick start (recommended)

Use the repo orchestrators instead of Ignite:

```bash
../scripts/run_local_stack.sh start
../scripts/run_local_stack.sh stop
```

For a full CI-style lifecycle: `../scripts/e2e_lifecycle.sh`.

## Build

Requirements:
- Go 1.22+
- Rust (stable)

Build the native crypto library first (used via cgo/FFI):

```bash
cd ../polystore_core
cargo build --release
```

Build `polystorechaind`:

```bash
cd ../polystorechain
export CGO_LDFLAGS="-L$(pwd)/../polystore_core/target/release -lpolystore_core -ldl -lpthread -lm"
go build -o ../bin/polystorechaind ./cmd/polystorechaind
```

Notes:
- The trusted setup is `polystorechain/trusted_setup.txt`. Many local scripts export
  `KZG_TRUSTED_SETUP` automatically; if you run manually, set it explicitly.
- On Linux, set `LD_LIBRARY_PATH` to include `../polystore_core/target/release`.
- On macOS, set `DYLD_LIBRARY_PATH` to include `../polystore_core/target/release`.

## Tests

```bash
go test ./...
```

If tests fail to load `libpolystore_core`, set:

```bash
export LD_LIBRARY_PATH="$LD_LIBRARY_PATH:$(pwd)/../polystore_core/target/release"
```

## Code map

- Protos: `proto/polystorechain/polystorechain/v1/*.proto`
- Module implementation: `x/polystorechain/`
- Rust FFI bindings used by Go: `x/crypto_ffi/`

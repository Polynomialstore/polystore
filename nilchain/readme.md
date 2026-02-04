# nilchain (NilStore L1)

`nilchain` is the Cosmos SDK + Ethermint chain for NilStore. It tracks Deals,
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
cd ../nil_core
cargo build --release
```

Build `nilchaind`:

```bash
cd ../nilchain
export CGO_LDFLAGS="-L$(pwd)/../nil_core/target/release -lnil_core -ldl -lpthread -lm"
go build -o ../bin/nilchaind ./cmd/nilchaind
```

Notes:
- The trusted setup is `nilchain/trusted_setup.txt`. Many local scripts export
  `KZG_TRUSTED_SETUP` automatically; if you run manually, set it explicitly.
- On Linux, set `LD_LIBRARY_PATH` to include `../nil_core/target/release`.
- On macOS, set `DYLD_LIBRARY_PATH` to include `../nil_core/target/release`.

## Tests

```bash
go test ./...
```

If tests fail to load `libnil_core`, set:

```bash
export LD_LIBRARY_PATH="$LD_LIBRARY_PATH:$(pwd)/../nil_core/target/release"
```

## Code map

- Protos: `proto/nilchain/nilchain/v1/*.proto`
- Module implementation: `x/nilchain/`
- Rust FFI bindings used by Go: `x/crypto_ffi/`

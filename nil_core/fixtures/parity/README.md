Parity fixtures for native/WASM checks.

- `blob_128k.bin`: 128 KiB deterministic pattern (`(i * 31 + 7) % 256`).
- `mdu_8m.bin`: 8 MiB deterministic pattern (`(i * 31 + 11) % 256`).

These files are generated deterministically so native and WASM outputs match
bit-for-bit across platforms.

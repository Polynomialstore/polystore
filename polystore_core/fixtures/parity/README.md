Parity fixtures for native/WASM checks.

- `blob_128k.bin`: 128 KiB deterministic pattern (`(i * 31 + 7) % 256`).
- `mdu_8m.bin`: 8 MiB deterministic pattern (`(i * 31 + 11) % 256`).

These files are generated deterministically so native and WASM outputs match
bit-for-bit across platforms.

Parity outputs also cover:
- Blob commitment for `blob_128k.bin`.
- Commitments + Merkle root for `mdu_8m.bin`.
- RS expansion parity for a non-default profile (K=4, M=2).

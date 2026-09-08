# Secured retrieval native/browser fixture

Produced by the real native v2 test generator for a nonconstant 12-blob payload;
this is a test-only chain (`test-1`), not a live authorization. `session.json` is
canonical protobuf JSON at committed height 12. Deal 9007199254740993, generation
7, session 0x01 repeated 32 bytes. The selected K8/M4 slot 1 rows 0 and 1 contain
leaves 8 and 9 and two complete encoded 128 KiB blobs. The frozen payee differs
from the assigned provider, exercising deputy identity binding.

`mdu_0.bin.gz` is deterministic gzip (mtime 0) of the exact authenticated FATv2
MDU0, decoded length 8388608 and SHA-256
`6196750acd73cd9a7f04b53c4dc2d5993483a128251c9b1d1e69558fabdb42e0`.
The maintained browser WASM test verifies that hash, metadata commitment, C2
context, PSB1 proofs, and commitments to each received blob. It rejects changed
bytes, reordered challenges and changed identities.

- `session.json`: 1450 bytes, SHA-256 `dcdd30aba720d6b0e4d23589639cc7a543852a1841ad7669b3127eb266606a8b`.
- `metadata.json`: 2788 bytes, SHA-256 `8dbe19b00ff8a6964ab5729ef9980e4a91123f6bfaf66b4ac3f2a8249d9a4ab9`.
- `window.bin`: 262144 bytes, SHA-256 `64f11a1628896cd80aca8058257e93f518af330b2f15e8e73e67bb89ab94ec8a`.
- `mdu_0.bin.gz`: 8316 bytes, SHA-256 `ca37140a778d21eed64d4ac2ef056ab586498df29a6dac41ac4d9355cd59129e`.

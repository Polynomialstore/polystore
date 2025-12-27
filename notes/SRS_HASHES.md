# NilStore SRS and setup digests (provisional)

This file pins the current SRS/trusted setup digests used by demos and reference implementations. Implementations MUST verify the SRS bytes against these hashes before use.

| Purpose | Path | SHA256 |
| --- | --- | --- |
| ckzg demo trusted setup (Powers of Tau compatible) | `demos/kzg/trusted_setup.txt` | `d39b9f2d047cc9dca2de58f264b6a09448ccd34db967881a6713eacacf0f26b7` |

Notes:
- Replace/extend this table with production-grade SRS ceremonies when available; keep all historical digests for auditability.
- All KAT vectors for PoDE Derive and VRF/BATMAN MUST be published alongside this file once generated, with their SHA256 digests and seeds.

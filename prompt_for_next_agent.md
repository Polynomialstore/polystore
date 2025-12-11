# Current State (December 10, 2025)

## "Filesystem on Slab" Architecture
- **Implemented & Verified:** `nil_s3` correctly ingests files, creating a "Slab" layout:
    - MDU #0: FAT + Witness Roots + User Roots (Raw Format).
    - Witness MDUs: Encoded KZG blobs.
    - User MDUs: Raw Data (Slices of original file).
- **Manifest Aggregation:** `nil_cli aggregate` correctly computes `ManifestRoot` (KZG Commitment) from the list of `MDU Roots` (32-byte Merkle Roots).
- **Ingest Flow:** `IngestNewDeal` works, producing a valid CID and storage layout.
- **Retrieval:** `nil_s3` correctly retrieves files using the FAT in MDU #0.

## The Slashing Issue
- **Symptom:** `MsgProveLiveness` transactions were resulting in `slash` (burn) events on-chain due to invalid KZG proofs.
- **Root Cause Identified (Dec 10, 2025):**
    - The `c-kzg` library (v2.1.5) and the provided `trusted_setup.txt` expect **Big Endian** byte representation for Scalars (Blob elements and evaluation point `z`).
    - `nil_core` was incorrectly using Little Endian (`fr_to_bytes_le`) for `z_for_cell` and `frs_to_blobs`.
    - This caused `z=1` to be interpreted as a massive integer, leading to incorrect evaluations.
- **Fix Applied:**
    - Updated `nil_core/src/utils.rs` to use `fr_to_bytes_be` in `z_for_cell` and `frs_to_blobs`.
    - Recompiled `nil_core` (Release) and `nil_cli` (Release).
- **Verification:**
    - Created `nil_core/tests/repro_issue.rs` which confirms that `z=1` (BE) and `blob=[1, 0...]` (BE) now correctly produce `y=1`.

## Next Steps
1.  **Redeploy & Verify:**
    -   Rebuild `nilchain` to link against the updated `libnil_core.a` (in `nil_core/target/release`).
    -   Restart `nilchaind` and `nil_s3`.
    -   Run `e2e_test.sh` or manual proof submission to verify `slash` events are gone.
2.  **Clean Up:**
    -   Remove `nil_core/tests/repro_issue.rs` once full E2E is confirmed (or keep as regression test).

## Code Context
- `nil_core/src/utils.rs`: **FIXED**. Uses Big Endian.
- `nil_core/tests/repro_issue.rs`: Regression test.
- `nilchain/x/crypto_ffi/binding.go`: Go bindings (verified correct, passes raw bytes).

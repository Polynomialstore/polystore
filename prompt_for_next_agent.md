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
- **Symptom:** `MsgProveLiveness` transactions are successfully submitted but result in a `slash` (burn) event on-chain.
- **Error:** The on-chain verification (`VerifyChainedProof`) fails.
- **Investigation Findings (Dec 10, 2025):**
    - **Reproduction:** Created `nil_core/tests/repro_issue.rs`.
        - `test_repro_verification_failure`: A blob with `blob[0]=1` (rest 0) fails to evaluate to `1` at `z=1` (standard root index 0). It yields `0x36...`.
        - `test_constant_polynomial`: A blob with ALL `1`s correctly evaluates to `1` at `z=1`.
    - **Conclusion 1:** `c-kzg` (v2.1.5) definitely treats the input Blob as **Evaluations** (not Coefficients).
    - **Conclusion 2:** There is a mismatch in the **Evaluation Domain** or **Index Ordering** between `nil_core` assumptions (Natural Order, Generator=7) and the `c-kzg` build/trusted setup.
    - **Failed Fixes:**
        - **Bit-Reversal:** Applying bit-reversal to inputs did NOT resolve the mismatch.
        - **Endianness:** Switching to Big Endian inputs did NOT resolve the mismatch.
        - **Generator Search:** Brute-forcing generators (2-100) did not find a matching shift.

## Next Steps
1.  **Resolve Domain Mismatch:**
    -   Inspect `c-kzg` (v2.1.5) source or `trusted_setup.txt` generation parameters to determine the exact Roots of Unity permutation used.
    -   Update `nil_core/src/utils.rs` (`z_for_cell` and `frs_to_blobs`) to match this permutation.
    -   Verify fix using `nil_core/tests/repro_issue.rs`.
2.  **Verify FFI:** Once `nil_core` tests pass, double-check `nilchain/x/crypto_ffi/binding.go` for any remaining byte-slicing errors.
3.  **Resolve Slashing:** Apply the fix to `nil_core` to enable successful on-chain proofs.

## Code Context
- `nil_core/tests/repro_issue.rs`: **CRITICAL**. Contains the reproduction case.
- `nil_core/src/utils.rs`: Contains the `z_for_cell` and `frs_to_blobs` logic that needs fixing.
- `demos/kzg/kzg_toy.py`: Python reference implementation (seems to use standard order, might differ from C lib).
- `nilchain/x/nilchain/keeper/msg_server.go`: On-chain verification logic.
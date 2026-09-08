These 122 verification known answers come from Ethereum's
[c-kzg-4844](https://github.com/ethereum/c-kzg-4844/tree/2374144fef55a7bf104627629ad130df005375ee/tests/verify_kzg_proof/kzg-mainnet)
at commit `2374144fef55a7bf104627629ad130df005375ee`. The upstream Apache-2.0
license is preserved alongside them. Each named `data.yaml` was converted to
JSON without changing its commitment, z, y, proof or expected result; its raw
SHA-256 is recorded in `source_sha256`. `null` means malformed input must return
an error; `false` means a well-formed invalid equation. There are 54 accepting,
48 rejecting and 20 malformed cases. No PolyStore prover generated these inputs.

The verifier test pins the repository's approved setup bytes before checking canonical
big-endian scalars, subgroup-checked compressed points, valid identity cases and
the KZG equation. These vectors exercise mathematical verification independently
of PolyStore's prover. They do not establish PolyFS membership, session authority,
freshness or delivery.

`nonconstant_blob.bin` is the unmodified decoded blob from upstream
`blob_to_kzg_commitment_case_valid_blob_4` and
`compute_kzg_proof_case_valid_blob_4_{0,1,2,3,4,5}`. Its SHA-256, the seven source
YAML hashes, expected commitment and six exact `(z, proof, y)` results are in
`compute_kzg_proof.json`. The companion test checks commitment and proof
generation after converting Ethereum's bit-reversed evaluation order to
PolyStore's natural order: move complete 32-byte chunks using
`poly[i] = ethereum[bitreverse12(i)]`. No scalar byte reversal is performed.
See the [Deneb v1.4.0 ordering definition](https://github.com/ethereum/consensus-specs/blob/v1.4.0/specs/deneb/polynomial-commitments.md#bit-reversal-permutation)
and [pinned c-kzg setup permutation](https://github.com/ethereum/c-kzg-4844/blob/2374144fef55a7bf104627629ad130df005375ee/src/setup/setup.c#L449).
The test covers both domain and off-domain points. Invalid Ethereum blob cases
are excluded: PolyStore's existing commitment API reduces arbitrary blob chunks
modulo the field, whereas Ethereum requires canonical blob elements. Received
bytes need a separate canonical-encoding check before claiming byte binding.

Run from the repository root:

```sh
cargo test --manifest-path polystore_core/Cargo.toml --release --locked --offline -j 2 --test kzg_external_vectors_test
```

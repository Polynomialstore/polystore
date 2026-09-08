use num_bigint::BigUint;
use polystore_core::builder::{validate_mdu0_v2, Mdu0Builder};
use polystore_core::coding::{expand_mdu_encoded, reconstruct_mdu_from_shards};
use polystore_core::kzg::{KzgCommitment, KzgContext, BLOB_SIZE, MDU_SIZE};
use polystore_core::layout::FileRecordV1;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::PathBuf;

#[derive(Deserialize)]
struct FixtureRoots {
    user_mdu_root: String,
    witness_mdu_root: String,
    mdu0_root: String,
    manifest_root: String,
}

#[derive(Deserialize)]
struct Fixture {
    spec: String,
    mdu0_format_version: u8,
    k: usize,
    m: usize,
    leaf_count: usize,
    payload_hex: String,
    payload_sha256: String,
    witness_count: usize,
    roots: FixtureRoots,
    artifact_sha256: std::collections::BTreeMap<String, String>,
    extra: std::collections::BTreeMap<String, serde_json::Value>,
}

fn trusted_setup_ctx() -> KzgContext {
    let setup_bytes = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../demos/kzg/trusted_setup.txt"
    ));
    let cursor = std::io::Cursor::new(setup_bytes.as_slice());
    KzgContext::load_from_reader(std::io::BufReader::new(cursor)).expect("load trusted setup")
}

fn sha256_hex0x(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("0x{}", hex::encode(h.finalize()))
}

fn decode_hex0x(s: &str) -> Vec<u8> {
    let trimmed = s.trim();
    let s = trimmed.strip_prefix("0x").unwrap_or(trimmed);
    hex::decode(s).expect("hex decode")
}

fn encode_payload_to_mdu(raw: &[u8]) -> Vec<u8> {
    const SCALAR_BYTES: usize = 32;
    const SCALAR_PAYLOAD_BYTES: usize = 31;
    const SCALARS_PER_BLOB: usize = BLOB_SIZE / SCALAR_BYTES;
    const SCALARS_PER_MDU: usize = 64 * SCALARS_PER_BLOB;
    const MDU_PAYLOAD_BYTES: usize = SCALARS_PER_MDU * SCALAR_PAYLOAD_BYTES;

    let payload = raw.get(..MDU_PAYLOAD_BYTES).unwrap_or(raw);
    let mut mdu = vec![0u8; MDU_SIZE];
    for (scalar_idx, chunk) in payload.chunks(SCALAR_PAYLOAD_BYTES).enumerate() {
        if scalar_idx >= SCALARS_PER_MDU {
            break;
        }
        let start = scalar_idx * SCALAR_BYTES;
        let pad = SCALAR_BYTES - chunk.len();
        mdu[start + pad..start + SCALAR_BYTES].copy_from_slice(chunk);
    }
    mdu
}

// Independent integer/wire oracle: no metadata serialization or reduction helper.
fn root_cell(root: &[u8; 32]) -> [u8; 32] {
    let modulus = BigUint::parse_bytes(
        b"73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001",
        16,
    )
    .unwrap();
    let reduced = (BigUint::from_bytes_be(root) % modulus).to_bytes_be();
    let mut cell = [0u8; 32];
    cell[32 - reduced.len()..].copy_from_slice(&reduced);
    cell
}

fn independent_mdu0(payload_len: usize, witness_root: &[u8; 32], user_root: &[u8; 32]) -> Vec<u8> {
    let mut mdu = vec![0u8; MDU_SIZE];
    mdu[..32].copy_from_slice(&root_cell(witness_root));
    mdu[32..64].copy_from_slice(&root_cell(user_root));
    let mut fat = [0u8; 384];
    fat[..8].copy_from_slice(b"NILF\x02\x00\x00\x01");
    fat[8..12].copy_from_slice(&1u32.to_le_bytes());
    fat[136..144].copy_from_slice(&(payload_len as u64).to_le_bytes());
    fat[152..163].copy_from_slice(b"fixture.bin");
    for (i, byte) in fat.iter().enumerate() {
        mdu[16 * BLOB_SIZE + i / 31 * 32 + 1 + i % 31] = *byte;
    }
    mdu
}

#[test]
fn mode2_artifacts_v1_fixture_k8m4_matches_hashes() {
    let ctx = trusted_setup_ctx();

    let fixture_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("testdata")
        .join("mode2-artifacts-v1")
        .join("fixture_k8m4_single.json");
    let fixture_bytes = std::fs::read(&fixture_path).expect("read fixture json");
    let fixture: Fixture = serde_json::from_slice(&fixture_bytes).expect("parse fixture json");

    assert_eq!(fixture.spec, "mode2-artifacts-v1");
    assert_eq!(fixture.mdu0_format_version, 2);
    assert_eq!(fixture.k, 8);
    assert_eq!(fixture.m, 4);
    assert_eq!(fixture.leaf_count, 96);
    assert_eq!(fixture.witness_count, 1);

    let payload = decode_hex0x(&fixture.payload_hex);
    assert_eq!(sha256_hex0x(&payload), fixture.payload_sha256);

    let encoded_user = encode_payload_to_mdu(&payload);
    let expanded =
        expand_mdu_encoded(&ctx, &encoded_user, fixture.k, fixture.m).expect("expand_mdu_encoded");
    assert_eq!(expanded.witness.len(), fixture.leaf_count);
    assert_eq!(expanded.shards.len(), fixture.k + fixture.m);

    let mut witness_flat = Vec::with_capacity(expanded.witness.len() * 48);
    for c in &expanded.witness {
        witness_flat.extend_from_slice(c);
    }

    let expected_witness_flat_sha = fixture
        .extra
        .get("witness_flat_sha256")
        .and_then(|v| v.as_str())
        .expect("missing extra.witness_flat_sha256");
    assert_eq!(sha256_hex0x(&witness_flat), expected_witness_flat_sha);

    // Leaf ordering sanity: witness[slot=0,row=0] matches commitment(shards[0][row0]).
    let first_blob = &expanded.shards[0][0..BLOB_SIZE];
    let c0 = ctx
        .blob_to_commitment(first_blob)
        .expect("blob_to_commitment");
    assert_eq!(expanded.witness[0], c0.to_vec());

    // Shard hashes match fixture artifacts for slab_index = 1 + W + user_ordinal, W=1, user_ordinal=0 => 2.
    for (slot, shard) in expanded.shards.iter().enumerate() {
        let name = format!("mdu_2_slot_{slot}.bin");
        let expected = fixture
            .artifact_sha256
            .get(&name)
            .unwrap_or_else(|| panic!("missing artifact hash for {name}"));
        assert_eq!(sha256_hex0x(shard), *expected, "{name} hash mismatch");
    }

    // Reconstruct from <=M missing shards.
    let mut shards_opt: Vec<Option<Vec<u8>>> = expanded.shards.into_iter().map(Some).collect();
    shards_opt[0] = None;
    shards_opt[3] = None;
    shards_opt[9] = None;
    let reconstructed =
        reconstruct_mdu_from_shards(&mut shards_opt, fixture.k, fixture.m).expect("reconstruct");
    assert_eq!(reconstructed, encoded_user);
    assert!(shards_opt[0].is_some() && shards_opt[3].is_some());
    assert!(shards_opt[9].is_none(), "unused parity remains absent");

    // User MDU root from witness commitments.
    let commitments: Vec<KzgCommitment> = witness_flat
        .chunks_exact(48)
        .map(|chunk| {
            let mut c = [0u8; 48];
            c.copy_from_slice(chunk);
            c
        })
        .collect();
    let user_root = ctx
        .create_mdu_merkle_root(&commitments)
        .expect("create_mdu_merkle_root");
    assert_eq!(
        format!("0x{}", hex::encode(user_root)),
        fixture.roots.user_mdu_root
    );

    assert_eq!(
        sha256_hex0x(&encoded_user),
        fixture.extra["encoded_user_mdu_sha256"].as_str().unwrap()
    );
    let witness_mdu = encode_payload_to_mdu(&witness_flat);
    assert_eq!(
        sha256_hex0x(&witness_mdu),
        fixture.artifact_sha256["mdu_1.bin"]
    );
    let witness_root = ctx
        .create_mdu_merkle_root(&ctx.mdu_to_kzg_commitments(&witness_mdu).unwrap())
        .unwrap();
    assert_eq!(
        format!("0x{}", hex::encode(witness_root)),
        fixture.roots.witness_mdu_root
    );

    let mdu0 = independent_mdu0(payload.len(), &witness_root, &user_root);
    assert_eq!(validate_mdu0_v2(&mdu0).unwrap().version, 2);
    let mut builder = Mdu0Builder::new_with_commitments(1, 96);
    builder.set_root(0, witness_root).unwrap();
    builder.set_root(1, user_root).unwrap();
    builder
        .append_file_record(
            FileRecordV1::from_path("fixture.bin", payload.len() as u64, 0, 0).unwrap(),
        )
        .unwrap();
    assert_eq!(builder.bytes(), mdu0);
    let mdu0_root = ctx
        .create_mdu_merkle_root(&ctx.mdu_to_kzg_commitments(&mdu0).unwrap())
        .unwrap();
    assert_eq!(
        format!("0x{}", hex::encode(mdu0_root)),
        fixture.roots.mdu0_root
    );
    assert_eq!(fixture.roots.mdu0_root, fixture.roots.manifest_root);
    assert_eq!(sha256_hex0x(&mdu0), fixture.artifact_sha256["mdu_0.bin"]);
    let mut manifest = vec![0u8; BLOB_SIZE];
    for (i, root) in [mdu0_root, witness_root, user_root].iter().enumerate() {
        manifest[i * 32..i * 32 + 32].copy_from_slice(&root_cell(root));
    }
    assert_eq!(
        sha256_hex0x(&manifest),
        fixture.artifact_sha256["manifest.bin"]
    );
    assert_eq!(
        ctx.compute_manifest_commitment(&[mdu0_root, witness_root, user_root])
            .unwrap()
            .1,
        manifest
    );


}

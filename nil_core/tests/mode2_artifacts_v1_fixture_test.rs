use nil_core::coding::{expand_mdu_encoded, reconstruct_mdu_from_shards};
use nil_core::kzg::{KzgCommitment, KzgContext, BLOB_SIZE, MDU_SIZE};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::PathBuf;

#[derive(Deserialize)]
#[allow(dead_code)]
struct FixtureRoots {
    user_mdu_root: String,
    witness_mdu_root: String,
    mdu0_root: String,
    manifest_root: String,
}

#[derive(Deserialize)]
struct Fixture {
    spec: String,
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
    assert_eq!(fixture.k, 8);
    assert_eq!(fixture.m, 4);
    assert_eq!(fixture.leaf_count, 96);
    assert_eq!(fixture.witness_count, 1);

    let payload = decode_hex0x(&fixture.payload_hex);
    assert_eq!(sha256_hex0x(&payload), fixture.payload_sha256);

    let encoded_user = encode_payload_to_mdu(&payload);
    let expanded = expand_mdu_encoded(&ctx, &encoded_user, fixture.k, fixture.m).expect("expand_mdu_encoded");
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
    let c0 = ctx.blob_to_commitment(first_blob).expect("blob_to_commitment");
    assert_eq!(expanded.witness[0], c0.to_vec());

    // Reconstruct from <=M missing shards.
    let mut shards_opt: Vec<Option<Vec<u8>>> = expanded.shards.into_iter().map(Some).collect();
    shards_opt[0] = None;
    shards_opt[3] = None;
    shards_opt[9] = None;
    let reconstructed = reconstruct_mdu_from_shards(&mut shards_opt, fixture.k, fixture.m).expect("reconstruct");
    assert_eq!(reconstructed, encoded_user);

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
    assert_eq!(format!("0x{}", hex::encode(user_root)), fixture.roots.user_mdu_root);

    // Shard hashes match fixture artifacts for slab_index = 1 + W + user_ordinal, W=1, user_ordinal=0 => 2.
    for (slot, shard) in shards_opt.iter().enumerate() {
        let shard = shard.as_ref().expect("shard should be present after reconstruct");
        let name = format!("mdu_2_slot_{slot}.bin");
        let expected = fixture
            .artifact_sha256
            .get(&name)
            .unwrap_or_else(|| panic!("missing artifact hash for {name}"));
        assert_eq!(sha256_hex0x(shard), *expected, "{name} hash mismatch");
    }
}

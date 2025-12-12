use nil_core::coding::{expand_mdu, CodingError, ExpandedMdu};
use nil_core::kzg::KzgContext;
use std::path::PathBuf;

fn get_trusted_setup_path() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.pop(); // up to repo root
    path.push("demos");
    path.push("kzg");
    path.push("trusted_setup.txt");
    path
}

#[test]
#[ignore]
fn expand_mdu_zero_data_shapes_are_valid() {
    let ts = get_trusted_setup_path();
    let ctx = KzgContext::load_from_file(&ts).expect("load trusted setup");

    let data = vec![0u8; 8 * 1024 * 1024];
    let ExpandedMdu { witness, shards } =
        expand_mdu(&ctx, &data).expect("expand_mdu should succeed for zero data");

    assert_eq!(witness.len(), 96, "witness must have 96 commitments");
    for c in &witness {
        assert_eq!(c.len(), 48, "each commitment must be 48 bytes");
    }

    assert_eq!(shards.len(), 12, "should produce 12 shards (RS 12,8)");
    for s in &shards {
        assert_eq!(s.len(), 1024 * 1024, "each shard must be 1MiB");
    }
}

#[test]
#[ignore]
fn expand_mdu_nonzero_data_succeeds() {
    let ts = get_trusted_setup_path();
    let ctx = KzgContext::load_from_file(&ts).expect("load trusted setup");

    let mut data = vec![0u8; 8 * 1024 * 1024];
    for (i, b) in data.iter_mut().enumerate() {
        *b = ((i * 31) % 256) as u8;
    }

    expand_mdu(&ctx, &data).expect("expand_mdu should succeed for non-zero data");
}

#[test]
fn expand_mdu_rejects_wrong_size() {
    let ts = get_trusted_setup_path();
    let ctx = KzgContext::load_from_file(&ts).expect("load trusted setup");

    let data = vec![0u8; 1024]; // too small
    match expand_mdu(&ctx, &data) {
        Err(CodingError::InvalidSize) => {}
        Err(other) => panic!("expected InvalidSize, got {other:?}"),
        Ok(_) => panic!("expected error for invalid size input"),
    }
}

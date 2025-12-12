use nil_core::coding::{expand_mdu, ExpandedMdu};
use nil_core::kzg::KzgContext;
use sha2::{Digest, Sha256};

fn trusted_setup_ctx() -> KzgContext {
    let setup_bytes = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../demos/kzg/trusted_setup.txt"
    ));
    let cursor = std::io::Cursor::new(setup_bytes.as_slice());
    KzgContext::load_from_reader(std::io::BufReader::new(cursor))
        .expect("load trusted setup")
}

fn fixture_data() -> Vec<u8> {
    let mut data = vec![0u8; 8 * 1024 * 1024];
    for (i, b) in data.iter_mut().enumerate() {
        *b = ((i * 31) % 256) as u8;
    }
    data
}

fn hashes(expanded: ExpandedMdu) -> (String, String) {
    let mut witness_hasher = Sha256::new();
    for c in expanded.witness {
        witness_hasher.update(c);
    }
    let witness_hex = hex::encode(witness_hasher.finalize());

    let mut shards_hasher = Sha256::new();
    for s in expanded.shards {
        shards_hasher.update(s);
    }
    let shards_hex = hex::encode(shards_hasher.finalize());

    (witness_hex, shards_hex)
}

const EXPECTED_WITNESS_SHA256: &str = "8312817ee52306f81cc4c9a03b3a23d9c5fdab93f6ca4e4afd6f5ed6307d095f";
const EXPECTED_SHARDS_SHA256: &str = "bb2644b419c94942f4189cb9fcdde4d4b46ad35d3ae152f7666fb613e2666a7f";

#[test]
#[ignore = "Slow; run with `cargo test -p nil_core --test expand_parity_test -- --ignored`"]
fn expand_mdu_fixture_hashes_match_expected() {
    let ctx = trusted_setup_ctx();
    let data = fixture_data();
    let expanded = expand_mdu(&ctx, &data).expect("expand_mdu");
    let (witness_hex, shards_hex) = hashes(expanded);

    assert_eq!(witness_hex, EXPECTED_WITNESS_SHA256);
    assert_eq!(shards_hex, EXPECTED_SHARDS_SHA256);
}

#[cfg(target_arch = "wasm32")]
#[test]
#[ignore = "Slow; run via wasm-bindgen test harness"]
fn expand_mdu_fixture_hashes_match_expected_wasm() {
    let ctx = trusted_setup_ctx();
    let data = fixture_data();
    let expanded = expand_mdu(&ctx, &data).expect("expand_mdu");
    let (witness_hex, shards_hex) = hashes(expanded);

    assert_eq!(witness_hex, EXPECTED_WITNESS_SHA256);
    assert_eq!(shards_hex, EXPECTED_SHARDS_SHA256);
}

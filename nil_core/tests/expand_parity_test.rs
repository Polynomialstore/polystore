use nil_core::coding::{expand_mdu, ExpandedMdu};
use nil_core::kzg::KzgContext;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::process::Command;

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

fn wasm_pkg_hashes() -> (String, String) {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let script_path = manifest_dir.join("tests/wasm_expand_hashes.js");

    let output = Command::new("node")
        .arg(script_path)
        .current_dir(&manifest_dir)
        .output()
        .expect("failed to execute `node` (is Node.js installed?)");

    if !output.status.success() {
        panic!(
            "wasm hash script failed (exit={}):\nstdout:\n{}\nstderr:\n{}",
            output.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    let stdout = String::from_utf8(output.stdout).expect("node stdout is not valid utf-8");
    let mut lines = stdout.lines();
    let witness_hex = lines
        .next()
        .expect("missing witness sha256 line")
        .trim()
        .to_string();
    let shards_hex = lines
        .next()
        .expect("missing shards sha256 line")
        .trim()
        .to_string();

    (witness_hex, shards_hex)
}

fn wasm_web_hashes() -> (String, String) {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let script_path = manifest_dir.join("tests/wasm_web_expand_hashes.mjs");

    let output = Command::new("node")
        .arg(script_path)
        .current_dir(&manifest_dir)
        .output()
        .expect("failed to execute `node` (is Node.js installed?)");

    if !output.status.success() {
        panic!(
            "wasm(web) hash script failed (exit={}):\nstdout:\n{}\nstderr:\n{}",
            output.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    let stdout = String::from_utf8(output.stdout).expect("node stdout is not valid utf-8");
    let mut lines = stdout.lines();
    let witness_hex = lines
        .next()
        .expect("missing witness sha256 line")
        .trim()
        .to_string();
    let shards_hex = lines
        .next()
        .expect("missing shards sha256 line")
        .trim()
        .to_string();

    (witness_hex, shards_hex)
}

#[test]
#[ignore = "Slow; run with `cargo test --release --test expand_parity_test -- --ignored`"]
fn expand_mdu_native_and_wasm_pkg_hashes_match_expected() {
    let ctx = trusted_setup_ctx();
    let data = fixture_data();
    let expanded = expand_mdu(&ctx, &data).expect("expand_mdu");
    let (native_witness_hex, native_shards_hex) = hashes(expanded);

    assert_eq!(native_witness_hex, EXPECTED_WITNESS_SHA256);
    assert_eq!(native_shards_hex, EXPECTED_SHARDS_SHA256);

    let (wasm_witness_hex, wasm_shards_hex) = wasm_pkg_hashes();
    assert_eq!(wasm_witness_hex, EXPECTED_WITNESS_SHA256);
    assert_eq!(wasm_shards_hex, EXPECTED_SHARDS_SHA256);

    assert_eq!(wasm_witness_hex, native_witness_hex);
    assert_eq!(wasm_shards_hex, native_shards_hex);

    let (web_witness_hex, web_shards_hex) = wasm_web_hashes();
    assert_eq!(web_witness_hex, EXPECTED_WITNESS_SHA256);
    assert_eq!(web_shards_hex, EXPECTED_SHARDS_SHA256);

    assert_eq!(web_witness_hex, native_witness_hex);
    assert_eq!(web_shards_hex, native_shards_hex);
}

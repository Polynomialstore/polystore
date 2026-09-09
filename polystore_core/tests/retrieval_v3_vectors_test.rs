use polystore_core::{integrity_v3, layout::FileTableHeaderV3, retrieval_v3};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;

fn fixture() -> Value {
    let p = format!(
        "{}/../polystorechain/pkg/retrievalchallenge/testdata/large-session-v3-golden.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_slice(&fs::read(p).unwrap()).unwrap()
}
fn hex32(v: &str) -> [u8; 32] {
    hex::decode(v).unwrap().try_into().unwrap()
}
fn providers() -> [[u8; 20]; 8] {
    std::array::from_fn(|i| [0x40 + i as u8; 20])
}
fn lp(out: &mut Vec<u8>, value: &[u8]) {
    out.extend((value.len() as u32).to_be_bytes());
    out.extend(value);
}

#[test]
fn merged_transcripts_drive_range_plan_and_challenges() {
    let f = fixture();
    for name in ["small_transcript", "large_transcript", "offset_transcript"] {
        let x = &f[name];
        let first = x["first"].as_u64().unwrap();
        let last = x["last"].as_u64().unwrap();
        let range = retrieval_v3::Range {
            first,
            last,
            population: last - first + 1,
        };
        let plan = retrieval_v3::Plan::build(range, providers()).unwrap();
        assert_eq!(
            hex::encode(plan.bytes().unwrap()),
            x["plan_hex"].as_str().unwrap()
        );
        assert_eq!(
            hex::encode(plan.hash().unwrap()),
            x["plan_hash"].as_str().unwrap()
        );
        let context_bytes = hex::decode(x["context_hex"].as_str().unwrap()).unwrap();
        let c = retrieval_v3::Context::parse(&context_bytes).unwrap();
        assert_eq!(hex::encode(c.hash()), x["context_hash"].as_str().unwrap());
        let anchor = hex32(x["anchor_hash"].as_str().unwrap());
        let seed = c.seed(&anchor);
        assert_eq!(hex::encode(seed), x["seed"].as_str().unwrap());
        let challenges = c.challenges(&seed).unwrap();
        assert_eq!(
            challenges.len(),
            x["sample_count"].as_u64().unwrap() as usize
        );
        if name == "large_transcript" {
            let mut h = Sha256::new();
            for c in &challenges {
                h.update(c.position.to_be_bytes())
            }
            assert_eq!(
                hex::encode(h.finalize()),
                f["large_sample"]["positions_sha256"].as_str().unwrap()
            );
            for (i, w) in f["large_sample"]["first_eight"]
                .as_array()
                .unwrap()
                .iter()
                .enumerate()
            {
                assert_eq!(challenges[i].position, w.as_u64().unwrap())
            }
        }
        let samples = if name == "small_transcript" {
            Some(&f["small_samples"])
        } else if name == "offset_transcript" {
            Some(&f["offset_samples"])
        } else {
            None
        };
        if let Some(samples) = samples {
            for (i, w) in samples.as_array().unwrap().iter().enumerate() {
                let c = &challenges[i];
                assert_eq!(
                    (
                        c.ordinal,
                        c.position,
                        c.t,
                        c.mdu_index,
                        c.leaf_index,
                        c.slot
                    ),
                    (
                        w["ordinal"].as_u64().unwrap(),
                        w["position"].as_u64().unwrap(),
                        w["t"].as_u64().unwrap(),
                        w["mdu_index"].as_u64().unwrap(),
                        w["leaf_index"].as_u64().unwrap() as u32,
                        w["slot"].as_u64().unwrap() as u32
                    )
                );
                assert_eq!(hex::encode(c.z), w["z"].as_str().unwrap())
            }
        }
        let acceptance = retrieval_v3::generation_acceptance(
            "polystore-test-1",
            &hex32("d39b9f2d047cc9dca2de58f264b6a09448ccd34db967881a6713eacacf0f26b7"),
            42,
            7,
            &[0x22; 32],
            &hex32("074c4b427382c9ff2e85f0fea1bc39a56bd58a3e3849e737e23faf15a2c67707"),
            2,
            (last + 64) / 64,
            0,
            &[0x40; 20],
        )
        .unwrap();
        assert_eq!(
            hex::encode(&acceptance),
            x["acceptance_slot0_hex"].as_str().unwrap()
        );
        assert_eq!(
            hex::encode(Sha256::digest(&acceptance)),
            x["acceptance_slot0_hash"].as_str().unwrap()
        );
        let ack = retrieval_v3::obligation_ack(
            "polystore-test-1",
            &hex32(x["session_id"].as_str().unwrap()),
            &c.hash(),
            &plan.hash().unwrap(),
            &plan.obligations[0],
            plan.obligations[0].blob_count * 131072,
            &hex32("074c4b427382c9ff2e85f0fea1bc39a56bd58a3e3849e737e23faf15a2c67707"),
        )
        .unwrap();
        assert_eq!(
            hex::encode(&ack),
            x["ack_first_obligation_hex"].as_str().unwrap()
        );
        assert_eq!(
            hex::encode(Sha256::digest(&ack)),
            x["ack_first_obligation_hash"].as_str().unwrap()
        );
    }
}

#[test]
fn v3_context_rejects_rebinding_malformed_and_overflow() {
    let f = fixture();
    let mut b = hex::decode(f["offset_transcript"]["context_hex"].as_str().unwrap()).unwrap();
    assert!(retrieval_v3::Context::parse(&b).is_ok());
    b[96] ^= 1;
    assert!(retrieval_v3::Context::parse(&b).is_err());
    assert!(retrieval_v3::checked_range(u64::MAX, 1, 1, 1, 1).is_err());
    let obligation = retrieval_v3::Obligation {
        slot: 0,
        assigned: [1; 20],
        payee: [1; 20],
        blob_count: 1,
    };
    for range in [
        retrieval_v3::Range {
            first: 2,
            last: 1,
            population: 1,
        },
        retrieval_v3::Range {
            first: 0,
            last: u64::MAX,
            population: u64::MAX,
        },
    ] {
        let plan = retrieval_v3::Plan {
            range,
            obligations: vec![obligation.clone()],
        };
        assert!(plan.bytes().is_err());
    }
    let mut suffix = hex::decode(f["small_transcript"]["context_hex"].as_str().unwrap()).unwrap();
    suffix.push(0);
    assert!(retrieval_v3::Context::parse(&suffix).is_err());
    let mut late_deal =
        hex::decode(f["small_transcript"]["context_hex"].as_str().unwrap()).unwrap();
    let n = late_deal.len();
    late_deal[n - 8..].copy_from_slice(&((i64::MAX as u64) + 1).to_be_bytes());
    assert!(retrieval_v3::Context::parse(&late_deal).is_err());
}

#[test]
fn v3_context_accepts_exact_734_byte_chain_and_coin_limits() {
    let f = fixture();
    let x = &f["small_transcript"];
    let chain = "a".repeat(50);
    let denom = format!("a{}", "z".repeat(127));
    let amount = b"115792089237316195423570985008687907853269984665640564039457584007913129639935";
    let owner = [0x11; 20];
    let plan = hex32(x["plan_hash"].as_str().unwrap());
    let sid = retrieval_v3::session_id(&chain, &owner, 42, 7, 3, 0, 2_158_592, &plan, 9).unwrap();
    let mut b = Vec::new();
    lp(&mut b, b"polystore/challenge-context/v3");
    b.extend(3u32.to_be_bytes());
    lp(&mut b, chain.as_bytes());
    b.extend(hex32(
        "d39b9f2d047cc9dca2de58f264b6a09448ccd34db967881a6713eacacf0f26b7",
    ));
    b.extend(sid);
    b.extend(owner);
    b.extend(42u64.to_be_bytes());
    b.extend(7u64.to_be_bytes());
    b.extend([0x22; 32]);
    b.extend(hex32(
        "074c4b427382c9ff2e85f0fea1bc39a56bd58a3e3849e737e23faf15a2c67707",
    ));
    b.extend(3u32.to_be_bytes());
    for v in [0u64, 2_158_592, 0, 2_158_592] {
        b.extend(v.to_be_bytes());
    }
    b.push(2);
    b.extend(8u32.to_be_bytes());
    b.extend(4u32.to_be_bytes());
    b.extend(2u64.to_be_bytes());
    b.extend(1u64.to_be_bytes());
    b.extend(plan);
    b.extend(17u64.to_be_bytes());
    b.extend(17u64.to_be_bytes());
    b.extend(9u64.to_be_bytes());
    lp(&mut b, denom.as_bytes());
    lp(&mut b, amount);
    lp(&mut b, amount);
    b.extend(250u32.to_be_bytes());
    b.push(1);
    b.extend(owner);
    for v in [100u64, 101, 102, 200, 300] {
        b.extend(v.to_be_bytes());
    }
    assert_eq!(b.len(), retrieval_v3::MAX_CONTEXT_BYTES);
    assert!(retrieval_v3::Context::parse(&b).is_ok());
}

fn pattern(name: &str) -> Vec<u8> {
    let mut b = vec![0; 131072];
    match name {
        "valid_incrementing" => {
            for i in 0..4096 {
                for j in 0..31 {
                    b[i * 32 + 1 + j] = (i + j) as u8
                }
            }
        }
        "valid_ff" => {
            for i in 0..4096 {
                b[i * 32 + 1..i * 32 + 32].fill(0xff)
            }
        }
        _ => {}
    }
    b
}
#[test]
fn fat_and_integrity_match_merged_vectors_and_reject_bad_paths() {
    let f = fixture();
    let root = hex32(f["integrity"]["root"].as_str().unwrap());
    let header = FileTableHeaderV3 {
        record_count: 2,
        integrity_leaf_count: 96,
        integrity_root: root,
    };
    let bytes = header.to_bytes().unwrap();
    assert_eq!(
        hex::encode(bytes),
        f["fat_header"]["header_hex"].as_str().unwrap()
    );
    assert_eq!(FileTableHeaderV3::from_bytes(&bytes).unwrap(), header);
    let names = ["zero", "valid_incrementing", "valid_ff"];
    let leaves: Vec<_> = names
        .iter()
        .enumerate()
        .map(|(i, n)| integrity_v3::leaf(10, i as u32, &pattern(n)).unwrap())
        .collect();
    for (i, l) in leaves.iter().enumerate() {
        assert_eq!(
            hex::encode(l),
            f["integrity"]["leaf_hashes"][i].as_str().unwrap()
        )
    }
    assert_eq!(integrity_v3::root(&leaves).unwrap(), root);
    for (i, p) in f["integrity"]["paths"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        let mut path: Vec<[u8; 32]> = p
            .as_array()
            .unwrap()
            .iter()
            .map(|v| hex32(v.as_str().unwrap()))
            .collect();
        assert!(integrity_v3::verify_path(
            leaves[i], i as u64, 3, &path, root
        ));
        if i == 2 {
            path[0] = [0; 32];
            assert!(!integrity_v3::verify_path(
                leaves[i], i as u64, 3, &path, root
            ))
        }
    }
    assert!(!integrity_v3::verify_path(
        leaves[2],
        u64::MAX,
        3,
        &[],
        root
    ));
    assert!(integrity_v3::leaf(10, 0, &[0]).is_err())
}

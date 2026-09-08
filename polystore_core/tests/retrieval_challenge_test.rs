use polystore_core::retrieval_challenge::Context;

fn fixture() -> serde_json::Value {
    serde_json::from_str(include_str!(
        "../../polystorechain/pkg/retrievalchallenge/testdata/challenge-golden.json"
    ))
    .unwrap()
}

fn replace_integer(golden: &serde_json::Value, bytes: &mut [u8], name: &str, value: u64) {
    let mut offset = 0;
    for field in golden["schema"]["fields"].as_array().unwrap() {
        let width = match field[1].as_str().unwrap() {
            "LP" => 4 + field[2].as_str().unwrap().len(),
            "u8" => 1,
            "u32" => 4,
            "u64" => 8,
            "hex32" => 32,
            "hex20" => 20,
            kind => panic!("unexpected oracle field type {kind}"),
        };
        if field[0].as_str().unwrap() == name {
            assert!(width <= 8);
            bytes[offset..offset + width].copy_from_slice(&value.to_be_bytes()[8 - width..]);
            return;
        }
        offset += width;
    }
    panic!("unknown field {name}");
}

#[test]
fn context_rejects_illegal_windows_layouts_and_overflow_before_sampling() {
    let golden = fixture();
    for kind in ["session", "audit", "repair"] {
        let bytes = hex::decode(golden["vectors"][kind]["context_hex"].as_str().unwrap()).unwrap();
        for (field, value) in [
            ("version", 3),
            ("layout", 0),
            ("k", 0),
            ("k", 3),
            ("k", 65),
            ("m", 0),
            ("m", u32::MAX as u64),
            ("slot", u32::MAX as u64),
            ("metadata_mdus", 0),
            ("metadata_mdus", u64::MAX),
            ("user_mdus", u64::MAX),
            ("snapshot_height", u64::MAX),
            ("anchor_height", u64::MAX),
            ("first_response_height", u64::MAX),
            ("deadline_height", u64::MAX),
            ("deal_end", 0),
            ("deal_end", u64::MAX),
        ] {
            let mut bad = bytes.clone();
            replace_integer(&golden, &mut bad, field, value);
            assert!(Context::parse(&bad).is_err(), "{kind}/{field}/{value}");
        }
        let cases = if kind == "session" {
            vec![
                ("epoch_id", 1),
                ("epoch_length", 1),
                ("sample_count", 1),
                ("snapshot_height", 0),
                ("blob_count", 0),
                ("blob_count", 4097),
                ("start_mdu", 0),
                ("start_mdu", u64::MAX),
                ("start_leaf", u32::MAX as u64),
            ]
        } else {
            vec![
                ("epoch_id", 0),
                ("epoch_id", u64::MAX),
                ("epoch_length", 0),
                ("epoch_length", 1),
                ("epoch_length", u64::MAX),
                ("sample_count", 0),
                ("sample_count", 4097),
                ("sample_count", 1065),
                ("start_mdu", 1),
                ("start_leaf", 1),
                ("blob_count", 1),
                ("deal_end", 102),
            ]
        };
        for (field, value) in cases {
            let mut bad = bytes.clone();
            replace_integer(&golden, &mut bad, field, value);
            assert!(Context::parse(&bad).is_err(), "{kind}/{field}/{value}");
        }
        // Chain IDs are byte-bounded valid UTF-8 and cannot contain NUL.
        let chain_offset = 4 + "polystore/challenge-context/v2".len() + 4 + 4;
        for value in [0, 0xff] {
            let mut bad = bytes.clone();
            bad[chain_offset] = value;
            assert!(Context::parse(&bad).is_err());
        }
        if kind != "session" {
            let id_offset = chain_offset + "polystore-test-1".len() + 32 + 1;
            let mut bad = bytes.clone();
            bad[id_offset] = 1;
            assert!(Context::parse(&bad).is_err());
            let payee_offset = id_offset + 32 + 8 + 8 + 32 + 20;
            let mut bad = bytes.clone();
            bad[payee_offset] ^= 1;
            assert!(Context::parse(&bad).is_err());
        }
    }
}

#[test]
fn independent_go_python_c2_vectors() {
    let golden: serde_json::Value = serde_json::from_str(include_str!(
        "../../polystorechain/pkg/retrievalchallenge/testdata/challenge-golden.json"
    ))
    .unwrap();
    let seed: [u8; 32] = hex::decode(golden["schema"]["seed_hex"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    for kind in ["session", "audit", "repair"] {
        let vector = &golden["vectors"][kind];
        let bytes = hex::decode(vector["context_hex"].as_str().unwrap()).unwrap();
        let context = Context::parse(&bytes).unwrap();
        assert_eq!(
            hex::encode(context.hash()),
            vector["context_hash"].as_str().unwrap()
        );
        let challenges = context.challenges(&seed).unwrap();
        let expected = vector["samples"].as_array().unwrap();
        assert_eq!(challenges.len(), expected.len());
        for (got, want) in challenges.iter().zip(expected) {
            assert_eq!(got.ordinal, want["ordinal"].as_u64().unwrap());
            assert_eq!(
                got.population_index,
                want["population_index"].as_u64().unwrap()
            );
            assert_eq!(got.mdu_index, want["mdu_index"].as_u64().unwrap());
            assert_eq!(
                u64::from(got.leaf_index),
                want["leaf_index"].as_u64().unwrap()
            );
            assert_eq!(hex::encode(got.z), want["z"].as_str().unwrap());
        }
        for length in 0..bytes.len() {
            assert!(Context::parse(&bytes[..length]).is_err());
        }
        let mut trailing = bytes.clone();
        trailing.push(0);
        assert!(Context::parse(&trailing).is_err());
    }
}

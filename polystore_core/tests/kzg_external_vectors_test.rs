use polystore_core::kzg::KzgContext;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{fs, path::Path};

#[derive(Deserialize)]
struct Vectors {
    setup_sha256: String,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    commitment: String,
    z: String,
    y: String,
    proof: String,
    expected: Option<bool>,
}

#[derive(Deserialize)]
struct ProverVectors {
    blob_sha256: String,
    commitment: String,
    cases: Vec<ProverCase>,
}

#[derive(Deserialize)]
struct ProverCase {
    name: String,
    z: String,
    y: String,
    proof: String,
}

#[test]
fn ethereum_independent_verification_vectors() {
    let vectors: Vectors =
        serde_json::from_str(include_str!("fixtures/ethereum_kzg/verify_kzg_proof.json")).unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let setup = fs::read(root.join("polystorechain/trusted_setup.txt")).unwrap();
    assert_eq!(hex::encode(Sha256::digest(&setup)), vectors.setup_sha256);
    let ctx = KzgContext::load_from_reader(setup.as_slice()).unwrap();
    assert_eq!(vectors.cases.len(), 122);
    for case in vectors.cases {
        let decode = |s: &str| hex::decode(s.strip_prefix("0x").unwrap()).unwrap();
        let result = ctx.verify_proof(
            &decode(&case.commitment),
            &decode(&case.z),
            &decode(&case.y),
            &decode(&case.proof),
        );
        match case.expected {
            Some(expected) => assert_eq!(result.unwrap(), expected, "{}", case.name),
            None => assert!(result.is_err(), "{}: {result:?}", case.name),
        }
    }
}

#[test]
fn ethereum_nonconstant_commitment_and_prover_vectors() {
    let vectors: ProverVectors =
        serde_json::from_str(include_str!("fixtures/ethereum_kzg/compute_kzg_proof.json")).unwrap();
    let ethereum_blob = include_bytes!("fixtures/ethereum_kzg/nonconstant_blob.bin");
    assert_eq!(
        hex::encode(Sha256::digest(ethereum_blob)),
        vectors.blob_sha256
    );
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let ctx = KzgContext::load_from_file(root.join("polystorechain/trusted_setup.txt")).unwrap();
    // Ethereum orders evaluations by bit-reversed roots. PolyStore uses natural
    // powers of omega with the same raw Lagrange setup. Scalar bytes stay BE.
    let mut blob = vec![0u8; ethereum_blob.len()];
    for i in 0..4096usize {
        let j = i.reverse_bits() >> (usize::BITS - 12);
        blob[i * 32..(i + 1) * 32].copy_from_slice(&ethereum_blob[j * 32..(j + 1) * 32]);
    }
    assert_ne!(blob, ethereum_blob.as_slice());
    let commitment = ctx.blob_to_commitment(&blob).unwrap();
    assert_eq!(hex::encode(commitment), vectors.commitment[2..]);
    assert_eq!(ctx.commit_received_blob(&blob).unwrap(), commitment);
    let mut wrong_received = blob.clone();
    wrong_received[31] ^= 1; // Different canonical bytes, while the old public proof remains valid.
    assert_ne!(
        ctx.commit_received_blob(&wrong_received).unwrap(),
        commitment
    );
    assert_eq!(vectors.cases.len(), 6);
    for case in vectors.cases {
        let z = hex::decode(&case.z[2..]).unwrap();
        let (proof, y) = ctx.compute_proof(&blob, &z).unwrap();
        assert_eq!(hex::encode(proof), case.proof[2..], "{}", case.name);
        assert_eq!(hex::encode(y), case.y[2..], "{}", case.name);
        assert!(ctx.verify_proof(&commitment, &z, &y, &proof).unwrap());
    }
}

#[test]
fn producer_openings_match_polynomial_quotients_and_reduced_cells() {
    use bls12_381::{G1Affine, Scalar};
    use polystore_core::utils::z_for_cell;
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let ctx = KzgContext::load_from_file(root.join("polystorechain/trusted_setup.txt")).unwrap();
    let be = |s: Scalar| {
        let mut b = s.to_bytes();
        b.reverse();
        b
    };
    let scalar = |mut b: [u8; 32]| {
        b.reverse();
        Scalar::from_bytes(&b).unwrap()
    };
    let domain: Vec<_> = (0..4096).map(|i| scalar(z_for_cell(i))).collect();
    let blob: Vec<_> = domain
        .iter()
        .flat_map(|x| be(Scalar::from(5) + Scalar::from(7) * x + Scalar::from(11) * x * x))
        .collect();
    let commitment = ctx.blob_to_commitment(&blob).unwrap();
    // Analytic p(x)=5+7x+11x² has q(x)=7+11(x+z), including p'(z)
    // at a domain point. The commitment path is independent of the prover MSM.
    for z in [
        Scalar::zero(),
        Scalar::from(2),
        domain[0],
        domain[3],
        domain[2048],
        domain[4095],
    ] {
        let quotient: Vec<_> = domain
            .iter()
            .flat_map(|x| be(Scalar::from(7) + Scalar::from(11) * (x + z)))
            .collect();
        let (proof, y) = ctx.compute_proof(&blob, &be(z)).unwrap();
        assert_eq!(proof, ctx.blob_to_commitment(&quotient).unwrap());
        assert_eq!(
            y,
            be(Scalar::from(5) + Scalar::from(7) * z + Scalar::from(11) * z * z)
        );
        assert!(ctx.verify_proof(&commitment, &be(z), &y, &proof).unwrap());
    }
    for value in [Scalar::zero(), Scalar::from(13)] {
        let constant = be(value).repeat(4096);
        for z in [Scalar::zero(), domain[4095]] {
            let (proof, y) = ctx.compute_proof(&constant, &be(z)).unwrap();
            assert_eq!(proof, G1Affine::identity().to_compressed());
            assert_eq!(y, be(value));
        }
    }
    let mut reduced = vec![0u8; 131072];
    reduced[31] = 13;
    let mut noncanonical = reduced.clone();
    let modulus =
        hex::decode("73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001").unwrap();
    noncanonical[..32].copy_from_slice(&modulus);
    noncanonical[31] += 13;
    for z in [Scalar::zero(), domain[3], domain[4095]] {
        assert_eq!(
            ctx.compute_proof(&noncanonical, &be(z)).unwrap(),
            ctx.compute_proof(&reduced, &be(z)).unwrap()
        );
    }
    assert!(ctx.compute_proof(&blob, &modulus).is_err());
    assert!(ctx.compute_proof(&blob, &[0u8; 31]).is_err());
    assert!(ctx.compute_proof(&blob[..131071], &[0u8; 32]).is_err());
}

//! Native verifier/producer heap probe. Run with:
//! cargo run --release --locked --offline -j 2 --example verifier_allocations
//!
//! Add -- --generation for fresh opening allocation measurement.
//! Only this executable installs the counting allocator. Setup, input buffers,
//! validation controls and printing are outside measured regions. Proof
//! generation is outside measurement except in the explicit generation mode.
//! Counts describe Rust allocator requests, not malloc usable sizes, stack, RSS
//! or direct C allocations. Both reported passes run after fixture validation.

use polystore_core::coding::expand_mdu_encoded;
use polystore_core::ffi;
use polystore_core::kzg::{
    BLOB_SIZE, Blake2s256Hasher, KzgContext, MDU_SIZE, Mdu0RootTableProof,
    encode_mdu_root_for_root_table,
};
use rs_merkle::{Hasher, MerkleTree};
use std::alloc::{GlobalAlloc, Layout, System};
use std::ffi::CString;
use std::hint::black_box;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::Relaxed};

struct CountingAllocator;

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static ENABLED: AtomicBool = AtomicBool::new(false);
static PEAK: AtomicUsize = AtomicUsize::new(0);
static TOTAL: AtomicUsize = AtomicUsize::new(0);
static ALLOCS: AtomicUsize = AtomicUsize::new(0);
static REALLOCS: AtomicUsize = AtomicUsize::new(0);

fn allocated(size: usize) {
    let live = LIVE.fetch_add(size, Relaxed) + size;
    if ENABLED.load(Relaxed) {
        PEAK.fetch_max(live, Relaxed);
        TOTAL.fetch_add(size, Relaxed);
        ALLOCS.fetch_add(1, Relaxed);
    }
}

// This process measures synchronous native calls on its sole caller thread.
// Accounting uses no allocations, locks or output from inside allocator hooks.
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ptr = unsafe { System.alloc(layout) };
        if !ptr.is_null() {
            allocated(layout.size());
        }
        ptr
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let ptr = unsafe { System.alloc_zeroed(layout) };
        if !ptr.is_null() {
            allocated(layout.size());
        }
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) };
        LIVE.fetch_sub(layout.size(), Relaxed);
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let next = unsafe { System.realloc(ptr, layout, new_size) };
        if !next.is_null() {
            // Realloc counts the full new request. Live bytes replace the old
            // allocation; allocator-internal transient copies are not observable.
            LIVE.fetch_sub(layout.size(), Relaxed);
            allocated(new_size);
            if ENABLED.load(Relaxed) {
                REALLOCS.fetch_add(1, Relaxed);
            }
        }
        next
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Stats {
    peak_bytes: usize,
    total_bytes: usize,
    allocation_calls: usize,
    realloc_calls: usize,
    retained_bytes: usize,
}

fn measure<T>(f: impl FnOnce() -> T) -> (T, Stats) {
    assert!(!ENABLED.load(Relaxed));
    let baseline = LIVE.load(Relaxed);
    PEAK.store(baseline, Relaxed);
    TOTAL.store(0, Relaxed);
    ALLOCS.store(0, Relaxed);
    REALLOCS.store(0, Relaxed);
    ENABLED.store(true, Relaxed);
    let result = black_box(f());
    ENABLED.store(false, Relaxed);
    let stats = Stats {
        peak_bytes: PEAK.load(Relaxed) - baseline,
        total_bytes: TOTAL.load(Relaxed),
        allocation_calls: ALLOCS.load(Relaxed),
        realloc_calls: REALLOCS.load(Relaxed),
        retained_bytes: LIVE.load(Relaxed) - baseline,
    };
    (result, stats)
}

fn check_allocator() {
    let before = LIVE.load(Relaxed);
    let (buffer, stats) = measure(|| black_box(vec![0u8; black_box(4096)]));
    assert_eq!(
        stats,
        Stats {
            peak_bytes: 4096,
            total_bytes: 4096,
            allocation_calls: 1,
            realloc_calls: 0,
            retained_bytes: 4096,
        }
    );
    drop(buffer);
    assert_eq!(LIVE.load(Relaxed), before);
    let (_, stats) = measure(|| drop(black_box(vec![1u8; black_box(2048)])));
    assert_eq!(
        stats,
        Stats {
            peak_bytes: 2048,
            total_bytes: 2048,
            allocation_calls: 1,
            realloc_calls: 0,
            retained_bytes: 0,
        }
    );
    let (buffer, stats) = measure(|| {
        let mut buffer = black_box(vec![1u8; black_box(64)]);
        buffer.reserve_exact(black_box(64));
        black_box(buffer)
    });
    assert_eq!(
        stats,
        Stats {
            peak_bytes: 128,
            total_bytes: 192,
            allocation_calls: 2,
            realloc_calls: 1,
            retained_bytes: 128,
        }
    );
    drop(buffer);
    assert_eq!(LIVE.load(Relaxed), before);
}

struct BlobProof {
    leaf: u32,
    commitment: [u8; 48],
    merkle_path: Vec<u8>,
    z: [u8; 32],
    y: [u8; 32],
    opening: [u8; 48],
}

struct Fixture {
    root: [u8; 32],
    mdu_root: [u8; 32],
    root_table: Mdu0RootTableProof,
    proofs: Vec<BlobProof>,
    leaf_count: u64,
    mdu_index: u64,
}

const CONTEXT_HASH: [u8; 32] = [17; 32];
const ANCHOR_SEED: [u8; 32] = [29; 32];

fn nonidentity(bytes: &[u8; 48]) {
    let point = Option::<bls12_381::G1Affine>::from(bls12_381::G1Affine::from_compressed(bytes))
        .expect("valid subgroup point");
    assert!(
        !bool::from(point.is_identity()),
        "identity fixture would underexercise verification"
    );
}

fn fixture(
    ctx: &KzgContext,
    k: usize,
    m: usize,
    fresh: bool,
    mdu_index: u64,
    min_leaves: usize,
) -> Fixture {
    // Same canonical nonconstant field pattern as setupBenchRetrievalEnv in Go.
    let mut data = vec![0u8; MDU_SIZE];
    for (i, cell) in data.chunks_exact_mut(32).enumerate() {
        cell[31] = (1 + i % 251) as u8;
    }
    let expanded = expand_mdu_encoded(ctx, &data, k, m).expect("RS expansion");
    let mut commitments: Vec<[u8; 48]> = expanded
        .witness
        .iter()
        .map(|c| c.as_slice().try_into().unwrap())
        .collect();
    // The maximum-depth probe pads only the authenticated Merkle statement.
    // It does not claim a complete RS allocation or qualify that storage profile.
    if min_leaves > commitments.len() {
        commitments.resize(min_leaves, bls12_381::G1Affine::identity().to_compressed());
    }
    let leaves: Vec<_> = commitments
        .iter()
        .map(|c| Blake2s256Hasher::hash(c))
        .collect();
    let tree = MerkleTree::<Blake2s256Hasher>::from_leaves(&leaves);
    let mdu_root = tree.root().unwrap();
    let mut mdu0 = vec![0u8; MDU_SIZE];
    let offset = usize::try_from(mdu_index - 1).unwrap() * 32;
    mdu0[offset..offset + 32].copy_from_slice(&encode_mdu_root_for_root_table(&mdu_root).unwrap());
    let root = ctx
        .create_mdu_merkle_root(&ctx.mdu_to_kzg_commitments(&mdu0).unwrap())
        .unwrap();
    let root_table = ctx
        .compute_mdu0_root_table_proof(&mdu0, mdu_index, &mdu_root)
        .unwrap();
    nonidentity(&root_table.root_table_du_commitment);
    nonidentity(&root_table.root_table_opening_proof);
    let proofs = (0..64 / k)
        .map(|row| {
            let blob = &expanded.shards[0][row * BLOB_SIZE..(row + 1) * BLOB_SIZE];
            assert_ne!(&blob[..32], &blob[32..64]);
            let mut z = [0u8; 32];
            z[0] = 42;
            z[2..10].copy_from_slice(&(row as u64 + 1).to_be_bytes());
            if fresh {
                z = polystore_core::retrieval_challenge::derive_z(
                    &CONTEXT_HASH,
                    &ANCHOR_SEED,
                    row as u64,
                    mdu_index,
                    row as u32,
                )
                .unwrap();
            }
            let (opening, y) = ctx.compute_proof(blob, &z).unwrap();
            nonidentity(&commitments[row]);
            nonidentity(&opening);
            BlobProof {
                leaf: row as u32,
                commitment: commitments[row],
                merkle_path: tree.proof(&[row]).to_bytes(),
                z,
                y,
                opening,
            }
        })
        .collect();
    Fixture {
        root,
        mdu_root,
        root_table,
        proofs,
        leaf_count: commitments.len() as u64,
        mdu_index,
    }
}

impl Fixture {
    fn verify_root_table(&self) -> i32 {
        ffi::polystore_verify_mdu0_root_table_proof(
            self.root.as_ptr(),
            self.mdu_index,
            self.mdu_root.as_ptr(),
            self.root_table.root_table_du_commitment.as_ptr(),
            self.root_table.root_table_du_merkle_proof.as_ptr(),
            self.root_table.root_table_du_merkle_proof.len(),
            self.root_table.root_table_opening_proof.as_ptr(),
        )
    }

    fn verify_blob(&self, p: &BlobProof) -> i32 {
        ffi::polystore_verify_mdu_proof(
            self.mdu_root.as_ptr(),
            p.commitment.as_ptr(),
            p.merkle_path.as_ptr(),
            p.merkle_path.len(),
            p.leaf,
            self.leaf_count,
            p.z.as_ptr(),
            p.y.as_ptr(),
            p.opening.as_ptr(),
        )
    }

    fn verify_list(&self, count: usize) -> bool {
        self.proofs[..count]
            .iter()
            .all(|p| self.verify_root_table() == 1 && self.verify_blob(p) == 1)
    }

    fn session_batch(&self, count: usize) -> Vec<u8> {
        assert!(count > 0 && count <= self.proofs.len());
        let mut input = Vec::new();
        input.extend(b"PSB1");
        input.extend((count as u16).to_be_bytes());
        input.extend((self.leaf_count as u32).to_be_bytes());
        input.extend(self.root);
        input.extend(CONTEXT_HASH);
        input.extend(ANCHOR_SEED);
        for proof in &self.proofs[..count] {
            input.extend(self.mdu_index.to_be_bytes());
            input.extend(proof.leaf.to_be_bytes());
            input.extend(self.mdu_root);
            input.extend(self.root_table.root_table_du_commitment);
            input.extend(self.root_table.root_table_opening_proof);
            input.extend(proof.commitment);
            input.extend(proof.z);
            input.extend(proof.y);
            input.extend(proof.opening);
            input.extend(
                (self.root_table.root_table_du_merkle_proof.len() as u16 / 32).to_be_bytes(),
            );
            input.extend((proof.merkle_path.len() as u16 / 32).to_be_bytes());
            input.extend(&self.root_table.root_table_du_merkle_proof);
            input.extend(&proof.merkle_path);
        }
        input
    }
}

fn report(k: usize, m: usize, stage: &str, count: usize, f: impl Fn() -> bool) {
    let mut first = None;
    for pass in ["warm_first", "warm_repeat"] {
        let (valid, stats) = measure(&f);
        assert!(valid, "measured proof failed");
        assert_eq!(stats.retained_bytes, 0, "verifier retained Rust heap");
        if let Some(previous) = &first {
            assert_eq!(&stats, previous, "repeat allocations changed");
        }
        println!(
            "{k},{m},{stage},{count},{pass},{},{},{},{},{}",
            stats.peak_bytes,
            stats.total_bytes,
            stats.allocation_calls,
            stats.realloc_calls,
            stats.retained_bytes
        );
        first = Some(stats);
    }
}

fn report_generation(ctx: &KzgContext) {
    // The existing fixture's nonconstant canonical cell pattern, reduced to one
    // atomic blob: RS expansion and a storage profile are not needed here.
    let mut blob = vec![0u8; BLOB_SIZE];
    for (i, cell) in blob.chunks_exact_mut(32).enumerate() {
        cell[31] = (1 + i % 251) as u8;
    }
    let commitment = ctx.blob_to_commitment(&blob).unwrap();
    nonidentity(&commitment);
    let fresh_z =
        polystore_core::retrieval_challenge::derive_z(&CONTEXT_HASH, &ANCHOR_SEED, 0, 2, 0)
            .unwrap();
    // Prove this deterministic fresh challenge exercises the off-domain branch.
    let mut le = fresh_z;
    le.reverse();
    let scalar = bls12_381::Scalar::from_bytes(&le).unwrap();
    assert_ne!(
        scalar.pow_vartime(&[4096, 0, 0, 0]),
        bls12_381::Scalar::one()
    );
    for (stage, z) in [
        ("generation_off_domain", fresh_z),
        (
            "generation_interior_domain",
            polystore_core::utils::z_for_cell(3),
        ),
    ] {
        let expected = ctx.compute_proof(&blob, &z).unwrap();
        nonidentity(&expected.0);
        assert!(
            ctx.verify_proof(&commitment, &z, &expected.1, &expected.0)
                .unwrap()
        );
        let mut wrong_y = expected.1;
        wrong_y[31] ^= 1;
        assert!(
            !ctx.verify_proof(&commitment, &z, &wrong_y, &expected.0)
                .unwrap()
        );
        let mut first = None;
        for pass in ["warm_first", "warm_repeat"] {
            let (opening, stats) =
                measure(|| ctx.compute_proof(black_box(&blob), black_box(&z)).unwrap());
            // Pairing, comparisons and output do not enter producer accounting.
            assert_eq!(opening, expected, "fresh proof/y changed");
            assert!(
                ctx.verify_proof(&commitment, &z, &opening.1, &opening.0)
                    .unwrap()
            );
            assert_eq!(stats.retained_bytes, 0, "producer retained Rust heap");
            if let Some(previous) = &first {
                assert_eq!(&stats, previous, "repeat allocations changed");
            }
            println!(
                ",,{stage},1,{pass},{},{},{},{},{}",
                stats.peak_bytes,
                stats.total_bytes,
                stats.allocation_calls,
                stats.realloc_calls,
                stats.retained_bytes
            );
            first = Some(stats);
        }
    }
}

fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    assert!(
        args.is_empty() || args == ["--session-batch"] || args == ["--generation"],
        "usage: verifier_allocations [--session-batch | --generation]"
    );
    check_allocator();
    let setup = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../demos/kzg/trusted_setup.txt");
    let setup_path = CString::new(setup.to_str().unwrap()).unwrap();
    assert_eq!(ffi::polystore_init(setup_path.as_ptr()), 0);
    let ctx = KzgContext::load_from_file(&setup).expect("generation-only context");
    println!(
        "k,m,stage,proofs,pass,peak_requested_bytes,total_requested_bytes,allocation_calls,realloc_calls,retained_bytes"
    );
    if args == ["--generation"] {
        report_generation(&ctx);
        return;
    }
    if !args.is_empty() {
        for (mdu, leaves, stage) in [
            (2, 0, "session_batch"),
            (65536, 16384, "max_path_session_batch"),
        ] {
            eprintln!(
                "generating fresh nonconstant K1/M1 fixture, MDU{mdu}, minimum leaves{leaves}, outside measurement"
            );
            let fixture = fixture(&ctx, 1, 1, true, mdu, leaves);
            for count in [1, 2, 8, 32, 64] {
                let input = fixture.session_batch(count);
                assert!(fixture.verify_list(count));
                assert_eq!(
                    ffi::polystore_verify_polyfs_session_batch_v1(input.as_ptr(), input.len()),
                    1
                );
                let mut invalid = input.clone();
                invalid[106 + 220 + 31] ^= 1;
                assert_eq!(
                    ffi::polystore_verify_polyfs_session_batch_v1(invalid.as_ptr(), invalid.len()),
                    0
                );
                report(1, 1, stage, count, || {
                    ffi::polystore_verify_polyfs_session_batch_v1(input.as_ptr(), input.len()) == 1
                });
                if leaves == 0 {
                    report(1, 1, "fresh_sequential_list", count, || {
                        fixture.verify_list(count)
                    });
                }
            }
        }
        return;
    }
    for (k, m, counts) in [(8, 4, [1, 2, 8]), (2, 1, [1, 8, 32])] {
        eprintln!("generating nonconstant K{k}/M{m} fixture outside measurement");
        let mut input = fixture(&ctx, k, m, false, 2, 0);
        assert!(input.verify_list(input.proofs.len()));
        // A wrong value must reach KZG and fail with the same valid Merkle path.
        input.proofs[0].y[31] ^= 1;
        assert_eq!(input.verify_blob(&input.proofs[0]), 0);
        input.proofs[0].y[31] ^= 1;
        report(k, m, "root_table", 1, || input.verify_root_table() == 1);
        report(k, m, "blob", 1, || input.verify_blob(&input.proofs[0]) == 1);
        for count in counts {
            report(k, m, "sequential_list", count, || input.verify_list(count));
        }
    }
}

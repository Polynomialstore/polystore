use polystore_core::builder::{
    FAT_LEGACY_MAX_RECORDS, FAT_V2_LOGICAL_BYTES, FAT_V2_MAX_RECORDS, FILE_TABLE_START, MDU_SIZE,
    Mdu0Builder, validate_mdu0_v2,
};
use polystore_core::layout::{FileRecordV1, FileTableHeader, pack_length_and_flags};

fn record(path: &[u8], size: u64, start: u64) -> FileRecordV1 {
    let mut rec = FileRecordV1 {
        start_offset: start,
        length_and_flags: pack_length_and_flags(size, 0).unwrap(),
        ..Default::default()
    };
    rec.path[..path.len()].copy_from_slice(path);
    rec
}

// Independent byte mapping for hostile wire inputs; does not call builder encoding.
fn put_logical(data: &mut [u8], offset: usize, value: &[u8]) {
    for (i, b) in value.iter().enumerate() {
        let n = offset + i;
        data[FILE_TABLE_START + n / 31 * 32 + 1 + n % 31] = *b;
    }
}
fn legacy(records: &[FileRecordV1]) -> Vec<u8> {
    let mut raw = vec![0; MDU_SIZE];
    let header = FileTableHeader {
        version: 1,
        record_count: records.len() as u32,
        ..Default::default()
    };
    raw[FILE_TABLE_START..FILE_TABLE_START + 128].copy_from_slice(&header.to_bytes());
    for (i, rec) in records.iter().enumerate() {
        let start = FILE_TABLE_START + 128 + i * 256;
        raw[start..start + 256].copy_from_slice(&rec.to_bytes());
    }
    raw
}

#[test]
fn new_fat_uses_fixed_v2_packing() {
    assert_eq!(FAT_V2_LOGICAL_BYTES, 6_094_848);
    assert_eq!(FAT_V2_MAX_RECORDS, 23_807);
    assert_eq!(FAT_LEGACY_MAX_RECORDS, 24_575);
    let b = Mdu0Builder::new(65536); // Historical sizing hint remains supported.
    let bytes = b.bytes();
    assert_eq!(bytes.len(), MDU_SIZE);
    assert_eq!(
        &bytes[FILE_TABLE_START..FILE_TABLE_START + 6],
        &[0, b'N', b'I', b'L', b'F', 2]
    );
    assert!(
        bytes[FILE_TABLE_START..]
            .chunks_exact(32)
            .all(|cell| cell[0] == 0)
    );
    assert_eq!(validate_mdu0_v2(bytes).unwrap().record_count, 0);
    let loaded = Mdu0Builder::load(bytes, 65536).unwrap();
    assert!(loaded.bytes() == bytes); // Export never repairs or normalizes received bytes.
}

#[test]
fn ordinary_load_rejects_legacy_raw_fat() {
    let raw = legacy(&[]);
    assert!(Mdu0Builder::load(&raw, 1).is_err());
    assert!(Mdu0Builder::load_legacy_recovery(Mdu0Builder::new(1).bytes(), 1, 64).is_err());
}

#[test]
fn records_cross_scalar_boundaries_and_ranges_are_bounded() {
    let mut b = Mdu0Builder::new(65536);
    for (i, name) in ["dir/é.txt", "a//./b", "replacement�.txt"]
        .iter()
        .enumerate()
    {
        let rec = FileRecordV1::from_path(name, 31 + i as u64, i as u64 * 100, 0x81).unwrap();
        b.append_file_record(rec).unwrap();
        assert_eq!(b.get_file_record(i as u32).unwrap(), rec);
        let wire = rec.to_bytes();
        for (j, expected) in wire.iter().enumerate() {
            let n = 128 + i * 256 + j;
            assert_eq!(
                b.bytes()[FILE_TABLE_START + n / 31 * 32 + 1 + n % 31],
                *expected
            );
        }
        let mut range = [0; 32];
        b.read_fat_range(128 + i * 256 + 29, &mut range).unwrap();
        assert_eq!(range, wire[29..61]);
    }
    let mut untouched = [99; 4];
    for offset in [FAT_V2_LOGICAL_BYTES - 3, usize::MAX] {
        assert!(b.read_fat_range(offset, &mut untouched).is_err());
        assert_eq!(untouched, [99; 4]);
    }
    b.read_fat_range(FAT_V2_LOGICAL_BYTES, &mut []).unwrap();
    assert!(b.get_file_record(3).is_err());
    assert!(b.get_file_record(u32::MAX).is_err());
    validate_mdu0_v2(b.bytes()).unwrap();
}

#[test]
fn paths_and_extents_reject_before_mutation() {
    let mut b = Mdu0Builder::new(1);
    for name in ["é".repeat(116), "a".repeat(232)] {
        b.append_file_record(FileRecordV1::from_path(&name, 1, 0, 255).unwrap())
            .unwrap();
    }
    for name in [
        "".into(),
        "a".repeat(233),
        "é".repeat(117),
        " a".into(),
        "a\u{2003}".into(),
        "/a".into(),
        "a\\b".into(),
        "a/../b".into(),
        "a\0b".into(),
        "a\u{7f}".into(),
        "a\n".into(),
    ] {
        assert!(
            FileRecordV1::from_path(&name, 1, 0, 0).is_err(),
            "accepted {name:?}"
        );
    }
    assert!(FileRecordV1::from_path("x", 1 << 56, 0, 0).is_err());
    assert!(FileRecordV1::from_path("x", 1, u64::MAX, 0).is_err());
    assert!(FileRecordV1::from_path("x", (1 << 56) - 1, 0, 255).is_ok());
    let before = b.bytes().to_vec();
    for rec in [
        record(&[0xff], 1, 0),
        record(b"a\0b", 1, 0),
        record(b"\0deleted", 1, 0),
        record(b"x", 1, u64::MAX),
    ] {
        assert!(b.append_file_record(rec).is_err());
        assert!(b.update_file_record(0, rec).is_err());
        assert!(b.find_free_slot_and_insert(rec).is_err());
        assert!(b.bytes() == before);
    }
    assert!(b.update_file_record(u32::MAX, record(b"x", 1, 0)).is_err());
    assert!(FileTableHeader::from_bytes(&[0; 127]).is_err());
    assert!(FileRecordV1::from_bytes(&[0; 255]).is_err());
}

#[test]
fn duplicate_active_paths_reject_all_mutations_atomically() {
    let mut b = Mdu0Builder::new(1);
    b.append_file_record(record(b"", 100, 0)).unwrap();
    b.append_file_record(record("dir/é.txt".as_bytes(), 10, 100))
        .unwrap();
    b.append_file_record(record(b"other", 10, 110)).unwrap();
    let duplicate = record("dir/é.txt".as_bytes(), 30, 500);
    let before = b.bytes().to_vec();
    assert!(b.append_file_record(duplicate).is_err());
    assert!(b.bytes() == before);
    assert!(b.update_file_record(2, duplicate).is_err());
    assert!(b.bytes() == before);
    // The tombstone is before the conflicting live entry: do not mutate it
    // early or append its split remainder before checking the entire table.
    assert!(b.find_free_slot_and_insert(duplicate).is_err());
    assert!(b.bytes() == before);
    b.update_file_record(1, duplicate).unwrap(); // Same-index update is legal.
    b.update_file_record(1, record(b"", 30, 100)).unwrap();
    assert_eq!(b.find_free_slot_and_insert(duplicate).unwrap(), 0);
    assert_eq!(b.get_file_record(0).unwrap().start_offset, 0);
    // Exact stored UTF-8 identity, with no path normalization or case folding.
    for path in ["dir/e\u{301}.txt", "DIR/é.txt", "a/b", "a//b", "a/./b"] {
        b.append_file_record(record(path.as_bytes(), 1, 1000))
            .unwrap();
    }
    validate_mdu0_v2(b.bytes()).unwrap();
}

#[test]
fn duplicate_active_paths_reject_loaded_wire_and_legacy_staging() {
    let rec = record(b"same", 1, 0);
    let mut raw = Mdu0Builder::new(1).bytes().to_vec();
    put_logical(&mut raw, 8, &2u32.to_le_bytes());
    put_logical(&mut raw, 128, &rec.to_bytes());
    put_logical(&mut raw, 384, &record(b"same", 2, 100).to_bytes());
    assert!(validate_mdu0_v2(&raw).is_err());
    assert!(Mdu0Builder::load(&raw, 1).is_err());
    let source = legacy(&[rec, record(b"same", 2, 100)]);
    let before = source.clone();
    let recovery = Mdu0Builder::load_legacy_recovery(&source, 1, 64).unwrap();
    assert_eq!(recovery.record_count(), 2);
    assert!(Mdu0Builder::stage_v2_from_trusted_legacy(&source, 1, 64).is_err());
    assert!(source == before);
    assert!(recovery.bytes() == before);
}

#[test]
fn duplicate_active_paths_at_capacity_use_exact_full_path() {
    let mut raw = Mdu0Builder::new(1).bytes().to_vec();
    put_logical(&mut raw, 8, &(FAT_V2_MAX_RECORDS as u32).to_le_bytes());
    // Maximum paths differ only at the end, preventing prefix-only identity.
    let prefix = "a".repeat(227);
    for i in 0..FAT_V2_MAX_RECORDS {
        let rec = record(
            format!("{prefix}{:05}", FAT_V2_MAX_RECORDS - i).as_bytes(),
            1,
            i as u64,
        );
        put_logical(&mut raw, 128 + i * 256, &rec.to_bytes());
    }
    validate_mdu0_v2(&raw).unwrap();
    let last = record(
        format!("{prefix}{:05}", FAT_V2_MAX_RECORDS).as_bytes(),
        2,
        99999,
    );
    put_logical(
        &mut raw,
        128 + (FAT_V2_MAX_RECORDS - 1) * 256,
        &last.to_bytes(),
    );
    assert!(validate_mdu0_v2(&raw).is_err());
    // Deleted entries have no identity, even when several remain in the FAT.
    for i in [0, FAT_V2_MAX_RECORDS - 1] {
        put_logical(
            &mut raw,
            128 + i * 256,
            &record(b"", 1, i as u64).to_bytes(),
        );
    }
    validate_mdu0_v2(&raw).unwrap();
}

#[test]
fn strict_load_rejects_all_noncanonical_wire_components() {
    let mut b = Mdu0Builder::new(1);
    b.append_file_record(record(b"x", 1, 0)).unwrap();
    let good = b.bytes();
    for (offset, value) in [
        (0, b"NOPE".to_vec()),
        (4, vec![1]),
        (4, vec![8]),
        (5, vec![1]),
        (6, 64u16.to_le_bytes().to_vec()),
        (8, 23808u32.to_le_bytes().to_vec()),
        (8, u32::MAX.to_le_bytes().to_vec()),
        (12, vec![1]),
        (128, u64::MAX.to_le_bytes().to_vec()),
        (128 + 24, vec![0xff]),
        (128 + 26, vec![1]),
        (384, vec![1]),
        (FAT_V2_LOGICAL_BYTES - 1, vec![1]),
    ] {
        let mut raw = good.to_vec();
        put_logical(&mut raw, offset, &value);
        assert!(
            Mdu0Builder::load(&raw, 1).is_err(),
            "accepted offset {offset}"
        );
    }
    for offset in [FILE_TABLE_START, FILE_TABLE_START + 32, MDU_SIZE - 32] {
        let mut raw = good.to_vec();
        raw[offset] = 1;
        assert!(Mdu0Builder::load(&raw, 1).is_err());
    }
    for len in [0, 128, MDU_SIZE - 1] {
        assert!(Mdu0Builder::load(&good[..len], 1).is_err());
    }
    let mut oversized = good.to_vec();
    oversized.push(0);
    assert!(Mdu0Builder::load(&oversized, 1).is_err());
}

#[test]
fn root_cells_are_canonical_and_raw_digest_is_reduced_once() {
    let modulus: [u8; 32] =
        hex::decode("73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001")
            .unwrap()
            .try_into()
            .unwrap();
    let mut b = Mdu0Builder::new(1);
    let mut minus_one = modulus;
    minus_one[31] -= 1;
    let mut raw = b.bytes().to_vec();
    raw[..32].copy_from_slice(&minus_one);
    assert_eq!(
        Mdu0Builder::load(&raw, 1).unwrap().get_root(0).unwrap(),
        minus_one
    );
    for cell in [modulus, [255; 32]] {
        raw[..32].copy_from_slice(&cell);
        assert!(Mdu0Builder::load(&raw, 1).is_err());
    }
    b.set_root(0, modulus).unwrap();
    assert_eq!(b.get_root(0).unwrap(), [0; 32]);
    b.set_root(65535, [255; 32]).unwrap();
    assert_ne!(b.get_root(65535).unwrap(), [255; 32]);
    validate_mdu0_v2(b.bytes()).unwrap();
    let before = b.bytes().to_vec();
    for index in [65536, u64::MAX] {
        assert!(b.set_root(index, [0; 32]).is_err());
        assert!(b.get_root(index).is_err());
    }
    assert!(b.bytes() == before);
}

#[test]
fn failed_full_table_split_preserves_bytes() {
    // Build the hostile full inventory independently, without paying a bounded
    // linear mutation preflight for each fixture entry.
    let mut raw = Mdu0Builder::new(1).bytes().to_vec();
    put_logical(&mut raw, 8, &(FAT_V2_MAX_RECORDS as u32).to_le_bytes());
    put_logical(&mut raw, 128, &record(b"", 100, 0).to_bytes());
    for index in 1..FAT_V2_MAX_RECORDS {
        put_logical(
            &mut raw,
            128 + index * 256,
            &record(format!("x{index}").as_bytes(), 1, 100).to_bytes(),
        );
    }
    let mut b = Mdu0Builder::load(&raw, 1).unwrap();
    assert_eq!(b.record_count(), 23807);
    validate_mdu0_v2(b.bytes()).unwrap();
    let before = b.bytes().to_vec();
    assert!(b.append_file_record(record(b"overflow", 1, 0)).is_err());
    assert!(b.find_free_slot_and_insert(record(b"new", 30, 0)).is_err());
    assert!(
        b.bytes() == before,
        "failed operation changed original bytes"
    );
    b.update_file_record(23806, record(b"", 30, 500)).unwrap();
    assert_eq!(
        b.find_free_slot_and_insert(record(b"later-exact", 30, 0))
            .unwrap(),
        23806
    );
    assert_eq!(b.get_file_record(23806).unwrap().start_offset, 500);
    assert_eq!(
        b.find_free_slot_and_insert(record(b"exact", 100, 99))
            .unwrap(),
        0
    );
    assert_eq!(b.record_count(), 23807);
    assert_eq!(b.get_file_record(0).unwrap().start_offset, 0);
    validate_mdu0_v2(b.bytes()).unwrap();
}

#[test]
fn explicit_legacy_recovery_is_immutable_and_staging_is_separate() {
    let mut live = FileRecordV1::from_path("dir/é.txt", 31, 128, 0x81).unwrap();
    live.timestamp = 123;
    let tomb = record(b"\0stale-deleted-path", 70, 159);
    let mut raw = legacy(&[live, tomb]);
    raw[..32].fill(255);
    let before = raw.clone();
    let mut recovery = Mdu0Builder::load_legacy_recovery(&raw, 65536, 96).unwrap();
    assert!(recovery.is_legacy_recovery());
    assert_eq!(recovery.get_root(0).unwrap(), [255; 32]);
    assert_eq!(recovery.get_file_record(1).unwrap(), tomb);
    assert!(recovery.append_file_record(live).is_err());
    assert!(recovery.update_file_record(0, live).is_err());
    assert!(recovery.find_free_slot_and_insert(live).is_err());
    assert!(recovery.set_root(0, [0; 32]).is_err());
    assert!(recovery.bytes() == before);
    let staged = Mdu0Builder::stage_v2_from_trusted_legacy(&raw, 65536, 96).unwrap();
    assert!(!staged.is_legacy_recovery());
    assert_eq!(staged.get_file_record(0).unwrap(), live);
    let mut canonical_tomb = tomb;
    canonical_tomb.path.fill(0);
    assert_eq!(staged.get_file_record(1).unwrap(), canonical_tomb);
    assert_ne!(staged.get_root(0).unwrap(), [255; 32]);
    validate_mdu0_v2(staged.bytes()).unwrap();
    assert!(raw == before);
}

#[test]
fn migration_rejects_oversize_or_malformed_source_without_changing_it() {
    let records = vec![record(b"x", 1, 0); FAT_V2_MAX_RECORDS + 1];
    let raw = legacy(&records);
    let before = raw.clone();
    assert_eq!(
        Mdu0Builder::load_legacy_recovery(&raw, 65536, 64)
            .unwrap()
            .record_count(),
        23808
    );
    assert!(Mdu0Builder::stage_v2_from_trusted_legacy(&raw, 65536, 64).is_err());
    assert!(raw == before);
    for (offset, byte) in [
        (4, 2),
        (5, 1),
        (12, 1),
        (128 + 24, 255),
        (128 + 26, 1),
        (384, 1),
    ] {
        let mut bad = legacy(&[record(b"x", 1, 0)]);
        bad[FILE_TABLE_START + offset] = byte;
        assert!(Mdu0Builder::load_legacy_recovery(&bad, 1, 64).is_err());
        assert!(Mdu0Builder::stage_v2_from_trusted_legacy(&bad, 1, 64).is_err());
    }
}

#[test]
fn ffi_load_modes_and_failed_operations_preserve_outputs() {
    use polystore_core::ffi::*;
    use std::ffi::CString;
    let raw = legacy(&[record(b"legacy.txt", 1, 0)]);
    assert!(polystore_mdu0_builder_load(raw.as_ptr(), raw.len(), 1).is_null());
    assert!(
        polystore_mdu0_builder_load_legacy_recovery(std::ptr::null(), raw.len(), 1, 64).is_null()
    );
    assert!(
        polystore_mdu0_builder_stage_v2_from_trusted_legacy(raw.as_ptr(), raw.len() - 1, 1, 64)
            .is_null()
    );
    let recovery = polystore_mdu0_builder_load_legacy_recovery(raw.as_ptr(), raw.len(), 65536, 64);
    assert!(!recovery.is_null());
    let path = CString::new("new.txt").unwrap();
    assert!(polystore_mdu0_append_file(recovery, path.as_ptr(), 1, 0) < 0);
    assert!(polystore_mdu0_set_root(recovery, 0, [0u8; 32].as_ptr()) < 0);
    let mut output = vec![0; MDU_SIZE];
    assert_eq!(
        polystore_mdu0_builder_bytes(recovery, output.as_mut_ptr(), output.len()),
        0
    );
    assert!(output == raw);
    polystore_mdu0_builder_free(recovery);

    let staged =
        polystore_mdu0_builder_stage_v2_from_trusted_legacy(raw.as_ptr(), raw.len(), 65536, 64);
    assert!(!staged.is_null());
    assert_eq!(polystore_mdu0_get_record_count(staged), 1);
    for (name, size, offset) in [("../x", 1, 0), ("x", 1 << 56, 0), ("x", 1, u64::MAX)] {
        let name = CString::new(name).unwrap();
        assert!(polystore_mdu0_append_file(staged, name.as_ptr(), size, offset) < 0);
    }
    assert_eq!(polystore_mdu0_get_record_count(staged), 1);
    let mut root = [77; 32];
    assert!(polystore_mdu0_get_root(staged, u64::MAX, root.as_mut_ptr()) < 0);
    assert_eq!(root, [77; 32]);
    let mut rec = record(b"untouched", 99, 18);
    let before = rec;
    assert!(polystore_mdu0_get_record(staged, u32::MAX, &mut rec) < 0);
    assert_eq!(rec, before);
    assert_eq!(
        polystore_mdu0_builder_bytes(staged, output.as_mut_ptr(), output.len()),
        0
    );
    validate_mdu0_v2(&output).unwrap();
    assert!(
        polystore_mdu0_builder_load_legacy_recovery(output.as_ptr(), output.len(), 1, 64).is_null()
    );
    polystore_mdu0_builder_free(staged);
}

#[test]
fn independent_python_full_slab_golden() {
    use sha2::{Digest, Sha256};
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../testdata/polyfs_fat_v2.json")).unwrap();
    let mut builder = Mdu0Builder::new(65536);
    let digest: [u8; 32] = hex::decode(fixture["root_digest_hex"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    builder.set_root(0, digest).unwrap();
    for value in fixture["records"].as_array().unwrap() {
        let mut rec = FileRecordV1::from_path(
            value["path"].as_str().unwrap(),
            value["length"].as_str().unwrap().parse().unwrap(),
            value["start"].as_str().unwrap().parse().unwrap(),
            value["flags"].as_u64().unwrap() as u8,
        )
        .unwrap();
        rec.timestamp = value["timestamp"].as_str().unwrap().parse().unwrap();
        builder.append_file_record(rec).unwrap();
    }
    assert_eq!(
        hex::encode(builder.get_root(0).unwrap()),
        fixture["root_cell_hex"]
    );
    assert_eq!(
        hex::encode(Sha256::digest(builder.bytes())),
        fixture["mdu0_sha256"]
    );
    let loaded = Mdu0Builder::load(builder.bytes(), 65536).unwrap();
    assert!(loaded.bytes() == builder.bytes());
}

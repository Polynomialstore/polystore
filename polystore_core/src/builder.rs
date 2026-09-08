//! Canonical FAT v2 builder and explicit, immutable legacy recovery.
//!
//! Validation establishes representation correctness only. The caller must
//! authenticate metadata against its committed generation before using its map,
//! and must independently trust the original bytes passed to staged migration.
use crate::kzg::encode_mdu_root_for_root_table;
use crate::layout::{self, FileRecordV1, FileTableHeader, MAGIC_NILF};
use bls12_381::Scalar;

pub const MDU_SIZE: usize = 8 * 1024 * 1024;
pub const BLOB_SIZE: usize = 128 * 1024;
pub const ROOT_TABLE_START: usize = 0;
pub const ROOT_TABLE_END: usize = 16 * BLOB_SIZE;
pub const FILE_TABLE_START: usize = ROOT_TABLE_END;
pub const FILE_TABLE_END: usize = MDU_SIZE;
pub const FILE_TABLE_HEADER_SIZE: usize = FileTableHeader::SIZE;
pub const FILE_RECORD_SIZE: usize = layout::FILE_RECORD_SIZE;
pub const ROOT_SIZE: usize = 32;
pub const SCALAR_BYTES: usize = 32;
pub const SCALAR_PAYLOAD_BYTES: usize = 31;
pub const MDU_PAYLOAD_BYTES: usize = (MDU_SIZE / SCALAR_BYTES) * SCALAR_PAYLOAD_BYTES;
pub const COMMITMENT_SIZE: u64 = 48;
pub const FAT_V2_LOGICAL_BYTES: usize = ((FILE_TABLE_END - FILE_TABLE_START) / 32) * 31;
pub const FAT_V2_MAX_RECORDS: usize =
    (FAT_V2_LOGICAL_BYTES - FILE_TABLE_HEADER_SIZE) / FILE_RECORD_SIZE;
pub const FAT_LEGACY_MAX_RECORDS: usize =
    (FILE_TABLE_END - FILE_TABLE_START - FILE_TABLE_HEADER_SIZE) / FILE_RECORD_SIZE;

#[derive(Clone, Copy, PartialEq, Eq)]
enum FatFormat {
    V2,
    LegacyRecovery,
}

impl FatFormat {
    fn capacity(self) -> usize {
        match self {
            Self::V2 => FAT_V2_LOGICAL_BYTES,
            Self::LegacyRecovery => FILE_TABLE_END - FILE_TABLE_START,
        }
    }
    fn max_records(self) -> usize {
        (self.capacity() - FILE_TABLE_HEADER_SIZE) / FILE_RECORD_SIZE
    }
    fn version(self) -> u8 {
        match self {
            Self::V2 => 2,
            Self::LegacyRecovery => 1,
        }
    }
    fn physical_range(self, logical: usize, remaining: usize) -> (usize, usize) {
        match self {
            Self::V2 => (
                FILE_TABLE_START + (logical / 31) * 32 + 1 + logical % 31,
                remaining.min(31 - logical % 31),
            ),
            Self::LegacyRecovery => (FILE_TABLE_START + logical, remaining),
        }
    }
}

fn checked_range(format: FatFormat, offset: usize, len: usize) -> Result<(), String> {
    if offset
        .checked_add(len)
        .is_none_or(|end| end > format.capacity())
    {
        return Err("FAT range out of bounds".into());
    }
    Ok(())
}

fn read_fat(data: &[u8], format: FatFormat, offset: usize, out: &mut [u8]) -> Result<(), String> {
    checked_range(format, offset, out.len())?;
    let mut copied = 0;
    while copied < out.len() {
        let (physical, count) = format.physical_range(offset + copied, out.len() - copied);
        out[copied..copied + count].copy_from_slice(&data[physical..physical + count]);
        copied += count;
    }
    Ok(())
}

fn read_record(data: &[u8], format: FatFormat, index: u32) -> Result<FileRecordV1, String> {
    let mut raw = [0u8; FILE_RECORD_SIZE];
    read_fat(
        data,
        format,
        FILE_TABLE_HEADER_SIZE + index as usize * FILE_RECORD_SIZE,
        &mut raw,
    )?;
    FileRecordV1::from_bytes(&raw)
}

fn validate(data: &[u8], format: FatFormat) -> Result<FileTableHeader, String> {
    if data.len() != MDU_SIZE {
        return Err("invalid MDU size".into());
    }
    let mut raw = [0u8; FILE_TABLE_HEADER_SIZE];
    read_fat(data, format, 0, &mut raw)?;
    let header = FileTableHeader::from_bytes(&raw)?;
    if header.magic != MAGIC_NILF
        || header.version != format.version()
        || header.record_size as usize != FILE_RECORD_SIZE
    {
        return Err("invalid FAT magic, version or record size".into());
    }
    if header.pad1 != 0 || header.reserved.iter().any(|b| *b != 0) {
        return Err("nonzero FAT header reserved bytes".into());
    }
    if header.record_count as usize > format.max_records() {
        return Err("FAT record count exceeds capacity".into());
    }
    if format == FatFormat::V2 {
        // Fr - 1 comes from the pinned field implementation, avoiding another
        // modulus constant. These public BE metadata cells need only a range
        // check, not 65,536 field decodes or constant-time secret arithmetic.
        let mut max_scalar = (-Scalar::one()).to_bytes();
        max_scalar.reverse();
        if data[..ROOT_TABLE_END]
            .chunks_exact(32)
            .any(|cell| cell > max_scalar.as_slice())
        {
            return Err("noncanonical root-table scalar".into());
        }
        if data[FILE_TABLE_START..]
            .chunks_exact(32)
            .any(|cell| cell[0] != 0)
        {
            return Err("nonzero FAT scalar prefix".into());
        }
    }
    for index in 0..header.record_count {
        read_record(data, format, index)?.validate(format == FatFormat::LegacyRecovery)?;
    }
    let logical = FILE_TABLE_HEADER_SIZE + header.record_count as usize * FILE_RECORD_SIZE;
    // All inserted FAT prefixes were checked above. After the last record,
    // logical tail zeros and physical tail zeros are therefore equivalent.
    let (physical, _) = format.physical_range(logical, 0);
    if data[physical..].iter().any(|b| *b != 0) {
        return Err("nonzero unused FAT bytes".into());
    }
    Ok(header)
}

/// Validate without copying the slab or requiring a trusted setup. This does not
/// authenticate the bytes against a chain root or authorize paid retrieval.
pub fn validate_mdu0_v2(data: &[u8]) -> Result<FileTableHeader, String> {
    validate(data, FatFormat::V2)
}

fn witness_mdu_count_for(max_user_mdus: u64, commitments_per_mdu: u64) -> u64 {
    // These legacy constructor arguments are sizing hints, not authenticated
    // capacity. Preserve their saturating behavior; never derive file bounds
    // or chain allocation from this value.
    let bytes = max_user_mdus
        .saturating_mul(commitments_per_mdu)
        .saturating_mul(COMMITMENT_SIZE);
    if bytes == 0 {
        0
    } else {
        1 + (bytes - 1) / MDU_PAYLOAD_BYTES as u64
    }
}

pub struct Mdu0Builder {
    buffer: Vec<u8>,
    header: FileTableHeader,
    format: FatFormat,
    pub witness_mdu_count: u64,
    pub max_user_mdus: u64,
    pub commitments_per_mdu: u64,
}

impl Mdu0Builder {
    pub fn new(max_user_mdus: u64) -> Self {
        Self::new_with_commitments(max_user_mdus, 64)
    }
    pub fn new_with_commitments(max_user_mdus: u64, commitments_per_mdu: u64) -> Self {
        let commitments = if commitments_per_mdu == 0 {
            64
        } else {
            commitments_per_mdu
        };
        let mut b = Self {
            buffer: vec![0; MDU_SIZE],
            header: FileTableHeader::default(),
            format: FatFormat::V2,
            witness_mdu_count: witness_mdu_count_for(max_user_mdus, commitments),
            max_user_mdus,
            commitments_per_mdu: commitments,
        };
        b.flush_header();
        b
    }
    pub fn load(data: &[u8], max_user_mdus: u64) -> Result<Self, String> {
        Self::load_with_commitments(data, max_user_mdus, 64)
    }
    pub fn load_with_commitments(
        data: &[u8],
        max_user_mdus: u64,
        commitments_per_mdu: u64,
    ) -> Result<Self, String> {
        Self::load_format(data, max_user_mdus, commitments_per_mdu, FatFormat::V2)
    }
    pub fn load_legacy_recovery(
        data: &[u8],
        max_user_mdus: u64,
        commitments_per_mdu: u64,
    ) -> Result<Self, String> {
        Self::load_format(
            data,
            max_user_mdus,
            commitments_per_mdu,
            FatFormat::LegacyRecovery,
        )
    }
    fn load_format(
        data: &[u8],
        max_user_mdus: u64,
        commitments_per_mdu: u64,
        format: FatFormat,
    ) -> Result<Self, String> {
        let header = validate(data, format)?; // Validate fully before the owned 8 MiB allocation.
        let commitments = if commitments_per_mdu == 0 {
            64
        } else {
            commitments_per_mdu
        };
        Ok(Self {
            buffer: data.to_vec(),
            header,
            format,
            witness_mdu_count: witness_mdu_count_for(max_user_mdus, commitments),
            max_user_mdus,
            commitments_per_mdu: commitments,
        })
    }
    /// Stage a separate canonical generation from explicitly trusted original
    /// legacy bytes. A legacy KZG root alone cannot authenticate their raw FAT.
    /// The caller must commit/activate this result through the normal content
    /// generation transaction and retain referenced old generations.
    pub fn stage_v2_from_trusted_legacy(
        data: &[u8],
        max_user_mdus: u64,
        commitments_per_mdu: u64,
    ) -> Result<Self, String> {
        let header = validate(data, FatFormat::LegacyRecovery)?;
        if header.record_count as usize > FAT_V2_MAX_RECORDS {
            return Err("legacy FAT exceeds v2 record capacity".into());
        }
        let mut staged = Self::new_with_commitments(max_user_mdus, commitments_per_mdu);
        for (index, cell) in data[..ROOT_TABLE_END].chunks_exact(32).enumerate() {
            staged.set_root(index as u64, cell.try_into().unwrap())?;
        }
        for index in 0..header.record_count {
            let mut rec = read_record(data, FatFormat::LegacyRecovery, index)?;
            if rec.path[0] == 0 {
                rec.path.fill(0);
            }
            staged.append_file_record(rec)?;
        }
        Ok(staged)
    }
    pub fn is_legacy_recovery(&self) -> bool {
        self.format == FatFormat::LegacyRecovery
    }
    pub fn record_count(&self) -> u32 {
        self.header.record_count
    }
    pub fn fat_logical_capacity(&self) -> usize {
        self.format.capacity()
    }
    pub fn bytes(&self) -> &[u8] {
        &self.buffer
    }
    pub fn read_fat_range(&self, offset: usize, out: &mut [u8]) -> Result<(), String> {
        read_fat(&self.buffer, self.format, offset, out)
    }
    fn editable(&self) -> Result<(), String> {
        if self.is_legacy_recovery() {
            return Err("legacy recovery is read-only; stage an explicit trusted migration".into());
        }
        Ok(())
    }
    // All callers preflight the entire mutation; once writing starts these
    // bounded operations have no fallible branch or allocation.
    fn write_fat(&mut self, offset: usize, bytes: &[u8]) {
        debug_assert!(checked_range(self.format, offset, bytes.len()).is_ok());
        let mut copied = 0;
        while copied < bytes.len() {
            let (physical, count) = self
                .format
                .physical_range(offset + copied, bytes.len() - copied);
            self.buffer[physical..physical + count].copy_from_slice(&bytes[copied..copied + count]);
            copied += count;
        }
    }
    fn flush_header(&mut self) {
        self.write_fat(0, &self.header.to_bytes());
    }
    fn root_offset(index: u64) -> Result<usize, String> {
        if index >= (ROOT_TABLE_END / ROOT_SIZE) as u64 {
            return Err("root index out of bounds".into());
        }
        Ok(index as usize * ROOT_SIZE)
    }
    /// Returns the stored field cell, not the original MDU digest. Legacy
    /// recovery returns its original raw cell unchanged.
    pub fn get_root(&self, index: u64) -> Result<[u8; 32], String> {
        let offset = Self::root_offset(index)?;
        Ok(self.buffer[offset..offset + ROOT_SIZE].try_into().unwrap())
    }
    /// Accept a raw MDU digest and store its canonical Fr representative.
    pub fn set_root(&mut self, index: u64, root: [u8; 32]) -> Result<(), String> {
        self.editable()?;
        let offset = Self::root_offset(index)?;
        let encoded = encode_mdu_root_for_root_table(&root).map_err(|e| e.to_string())?;
        self.buffer[offset..offset + ROOT_SIZE].copy_from_slice(&encoded);
        Ok(())
    }
    pub fn get_file_record(&self, index: u32) -> Result<FileRecordV1, String> {
        if index >= self.header.record_count {
            return Err("record index out of bounds".into());
        }
        read_record(&self.buffer, self.format, index)
    }
    pub fn append_file_record(&mut self, rec: FileRecordV1) -> Result<(), String> {
        self.editable()?;
        rec.validate(false)?;
        if self.header.record_count as usize >= FAT_V2_MAX_RECORDS {
            return Err("file table full".into());
        }
        self.write_fat(
            FILE_TABLE_HEADER_SIZE + self.header.record_count as usize * FILE_RECORD_SIZE,
            &rec.to_bytes(),
        );
        self.header.record_count += 1;
        self.flush_header();
        Ok(())
    }
    pub fn update_file_record(&mut self, index: u32, rec: FileRecordV1) -> Result<(), String> {
        self.editable()?;
        if index >= self.header.record_count {
            return Err("record index out of bounds".into());
        }
        rec.validate(false)?;
        self.write_fat(
            FILE_TABLE_HEADER_SIZE + index as usize * FILE_RECORD_SIZE,
            &rec.to_bytes(),
        );
        Ok(())
    }
    pub fn find_free_slot_and_insert(&mut self, mut rec: FileRecordV1) -> Result<u32, String> {
        self.editable()?;
        rec.validate(false)?;
        let (required_len, _) = layout::unpack_length_and_flags(rec.length_and_flags);
        for i in 0..self.header.record_count {
            let existing = self.get_file_record(i)?;
            let (tomb_len, _) = layout::unpack_length_and_flags(existing.length_and_flags);
            if existing.path[0] == 0 && tomb_len >= required_len {
                rec.start_offset = existing.start_offset;
                rec.validate(false)?;
                let leftover = tomb_len - required_len;
                if leftover > 0 && self.header.record_count as usize >= FAT_V2_MAX_RECORDS {
                    // A later exact-fit tombstone may still be reusable.
                    continue;
                }
                let tomb = FileRecordV1 {
                    start_offset: existing
                        .start_offset
                        .checked_add(required_len)
                        .ok_or("file extent overflow")?,
                    length_and_flags: layout::pack_length_and_flags(leftover, 0)?,
                    ..Default::default()
                };
                tomb.validate(false)?;
                self.write_fat(
                    FILE_TABLE_HEADER_SIZE + i as usize * FILE_RECORD_SIZE,
                    &rec.to_bytes(),
                );
                if leftover > 0 {
                    self.write_fat(
                        FILE_TABLE_HEADER_SIZE
                            + self.header.record_count as usize * FILE_RECORD_SIZE,
                        &tomb.to_bytes(),
                    );
                    self.header.record_count += 1;
                    self.flush_header();
                }
                return Ok(i);
            }
        }
        self.append_file_record(rec)?;
        Ok(self.header.record_count - 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::{self, FileRecordV1};

    #[test]
    fn test_init_empty_mdu0() {
        let max_user_mdus = 65536u64;
        let b = Mdu0Builder::new(max_user_mdus);

        // 1. Verify Header
        assert_eq!(b.header.magic, MAGIC_NILF, "Magic mismatch");
        assert_eq!(b.header.record_count, 0, "Expected 0 records");

        // 2. Verify W Calculation
        // 65536 MDUs * 64 blobs/MDU * 48 bytes/blob = 201,326,592 bytes
        // Witness commitments are stored as raw payload bytes inside encoded MDUs:
        // 201,326,592 / 8,126,464 = 24.773... -> 25 MDUs
        let expected_w = 25u64;
        assert_eq!(
            b.witness_mdu_count, expected_w,
            "W calculation failed. Want {}, got {}",
            expected_w, b.witness_mdu_count
        );
    }

    #[test]
    fn test_witness_count_uses_raw_payload_capacity() {
        let commitments_per_mdu = 64u64;
        let witness_payload_capacity = MDU_PAYLOAD_BYTES as u64;
        let commitments_per_witness = witness_payload_capacity / (commitments_per_mdu * 48);

        let one_witness = Mdu0Builder::new(commitments_per_witness);
        assert_eq!(one_witness.witness_mdu_count, 1);

        let two_witness = Mdu0Builder::new(commitments_per_witness + 1);
        assert_eq!(two_witness.witness_mdu_count, 2);

        let codex_boundary = Mdu0Builder::new(2700);
        assert_eq!(codex_boundary.witness_mdu_count, 2);
    }

    #[test]
    fn public_root_range_and_tail_boundaries_remain_strict() {
        let mut builder = Mdu0Builder::new(1);
        let modulus: [u8; 32] = hex::decode(crate::utils::FR_MODULUS_HEX)
            .unwrap()
            .try_into()
            .unwrap();
        let mut max_scalar = modulus;
        max_scalar[31] -= 1;
        for index in [0, 32768, 65535] {
            let start = index * ROOT_SIZE;
            builder.buffer[start..start + ROOT_SIZE].copy_from_slice(&max_scalar);
            validate_mdu0_v2(builder.bytes()).unwrap();
            for invalid in [modulus, [0xff; 32]] {
                builder.buffer[start..start + ROOT_SIZE].copy_from_slice(&invalid);
                assert!(validate_mdu0_v2(builder.bytes()).is_err());
            }
            builder.buffer[start..start + ROOT_SIZE].fill(0);
        }
        // 256 and 31 are coprime: these record counts exercise every tail
        // alignment, including the transition to the next physical scalar.
        for _ in 0..31 {
            let logical =
                FILE_TABLE_HEADER_SIZE + builder.record_count() as usize * FILE_RECORD_SIZE;
            let (physical, _) = FatFormat::V2.physical_range(logical, 0);
            for offset in [physical, physical / 32 * 32, MDU_SIZE - 1] {
                builder.buffer[offset] = 1;
                assert!(validate_mdu0_v2(builder.bytes()).is_err());
                builder.buffer[offset] = 0;
            }
            validate_mdu0_v2(builder.bytes()).unwrap();
            builder
                .append_file_record(FileRecordV1::from_path("a", 1, 0, 0).unwrap())
                .unwrap();
        }
    }

    #[test]
    fn test_append_file_record() {
        let mut b = Mdu0Builder::new(100);

        // Add file 1
        let mut path = [0u8; layout::FILE_RECORD_PATH_BYTES];
        path[..9].copy_from_slice(b"file1.txt");
        let rec1 = FileRecordV1 {
            start_offset: 0,
            length_and_flags: layout::pack_length_and_flags(1024, 0).unwrap(),
            timestamp: 100,
            path,
        };

        b.append_file_record(rec1).expect("Append failed");

        assert_eq!(b.header.record_count, 1, "RecordCount mismatch. Want 1");

        // Verify it's in the File Table
        let fetched_rec = b.get_file_record(0).unwrap();
        assert_eq!(fetched_rec.start_offset, 0, "Fetched record mismatch");
    }

    #[test]
    fn test_add_root() {
        let mut b = Mdu0Builder::new(100);

        let mut dummy_root = [0u8; 32];
        dummy_root[0] = 0xAA; // Rest zero

        // Add root for MDU #1 (Index 0 in Root Table)
        b.set_root(0, dummy_root).expect("SetRoot failed");

        // Verify
        let fetched = b.get_root(0).unwrap();
        assert_eq!(
            fetched,
            encode_mdu_root_for_root_table(&dummy_root).unwrap(),
            "GetRoot mismatch"
        );
    }

    #[test]
    fn test_load_and_modify() {
        let mut b1 = Mdu0Builder::new(100);
        let rec = FileRecordV1 {
            timestamp: 555,
            ..Default::default()
        };
        b1.append_file_record(rec).unwrap();

        let data = b1.bytes();

        let b2 = Mdu0Builder::load(data, 100).expect("Load failed");

        assert_eq!(b2.header.record_count, 1, "Loaded RecordCount mismatch");

        let fetched = b2.get_file_record(0).unwrap();
        assert_eq!(fetched.timestamp, 555, "Loaded record content mismatch");
    }

    #[test]
    fn test_find_free_space_tombstone_splitting() {
        let mut b = Mdu0Builder::new(1000);

        // 1. Add 100KB file
        let mut path = [0u8; layout::FILE_RECORD_PATH_BYTES];
        path[..7].copy_from_slice(b"big.txt");
        let mut rec1 = FileRecordV1 {
            start_offset: 0,
            length_and_flags: layout::pack_length_and_flags(100000, 0).unwrap(),
            path,
            ..Default::default()
        };
        b.append_file_record(rec1).unwrap();

        // 2. Delete it (Tombstone)
        rec1.path.fill(0);
        b.update_file_record(0, rec1).unwrap();

        // 3. Add 30KB file. Should reuse slot 0.
        let mut path2 = [0u8; layout::FILE_RECORD_PATH_BYTES];
        path2[..9].copy_from_slice(b"small.txt");
        let rec2 = FileRecordV1 {
            length_and_flags: layout::pack_length_and_flags(30000, 0).unwrap(),
            path: path2,
            ..Default::default()
        };

        let idx = b
            .find_free_slot_and_insert(rec2)
            .expect("FindFreeSlot failed");

        assert_eq!(idx, 0, "Expected reuse of slot 0");

        // 4. Verify splitting
        // Slot 0 should be "small.txt" (30KB)
        let slot0 = b.get_file_record(0).unwrap();
        let (l, _) = layout::unpack_length_and_flags(slot0.length_and_flags);
        assert_eq!(l, 30000, "Slot 0 length wrong");

        // Slot 1 should be Tombstone (70KB)
        // RecordCount should be 2
        assert_eq!(
            b.header.record_count, 2,
            "Expected 2 records (1 active + 1 split tombstone)"
        );

        let slot1 = b.get_file_record(1).unwrap();
        assert_eq!(slot1.path[0], 0, "Slot 1 should be tombstone");

        let (l1, _) = layout::unpack_length_and_flags(slot1.length_and_flags);
        assert_eq!(l1, 70000, "Tombstone size wrong");
    }
}

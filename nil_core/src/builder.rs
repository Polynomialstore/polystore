use crate::layout::{self, FileRecordV1, FileTableHeader, MAGIC_NILF};

pub const MDU_SIZE: usize = 8 * 1024 * 1024; // 8 MiB
pub const BLOB_SIZE: usize = 128 * 1024;      // 128 KiB
pub const ROOT_TABLE_START: usize = 0;
pub const ROOT_TABLE_END: usize = 16 * BLOB_SIZE;
pub const FILE_TABLE_START: usize = 16 * BLOB_SIZE;
pub const FILE_TABLE_END: usize = 64 * BLOB_SIZE;
pub const FILE_TABLE_HEADER_SIZE: usize = 128;
pub const FILE_RECORD_SIZE: usize = 64;
pub const ROOT_SIZE: usize = 32;

pub struct Mdu0Builder {
    pub buffer: Vec<u8>,
    pub header: FileTableHeader,
    pub witness_mdu_count: u64,
    pub max_user_mdus: u64,
}

impl Mdu0Builder {
    pub fn new(max_user_mdus: u64) -> Self {
        // Calculate W
        let total_commitment_bytes = (max_user_mdus * 64 * 48) as f64;
        let w = (total_commitment_bytes / MDU_SIZE as f64).ceil() as u64;

        let mut header = FileTableHeader::default();
        header.record_size = FILE_RECORD_SIZE as u16;
        header.record_count = 0;
        
        let mut builder = Mdu0Builder {
            buffer: vec![0u8; MDU_SIZE],
            header,
            witness_mdu_count: w,
            max_user_mdus,
        };
        builder.flush_header();
        builder
    }

    pub fn load(data: &[u8], max_user_mdus: u64) -> Result<Self, String> {
        if data.len() != MDU_SIZE {
            return Err("invalid MDU size".to_string());
        }

        let total_commitment_bytes = (max_user_mdus * 64 * 48) as f64;
        let witness_mdu_count = (total_commitment_bytes / MDU_SIZE as f64).ceil() as u64;

        let header_slice = &data[FILE_TABLE_START..FILE_TABLE_START + FILE_TABLE_HEADER_SIZE];
        let header = FileTableHeader::from_bytes(header_slice);

        if header.magic != MAGIC_NILF {
            return Err("invalid magic".to_string());
        }

        Ok(Mdu0Builder {
            buffer: data.to_vec(),
            header,
            witness_mdu_count,
            max_user_mdus,
        })
    }

    pub fn flush_header(&mut self) {
        let bytes = self.header.to_bytes();
        self.buffer[FILE_TABLE_START..FILE_TABLE_START + FILE_TABLE_HEADER_SIZE].copy_from_slice(&bytes);
    }

    pub fn bytes(&mut self) -> &[u8] {
        self.flush_header();
        &self.buffer
    }

    pub fn get_root(&self, index: u64) -> [u8; 32] {
        let offset = ROOT_TABLE_START + (index as usize * ROOT_SIZE);
        let mut root = [0u8; 32];
        root.copy_from_slice(&self.buffer[offset..offset + ROOT_SIZE]);
        root
    }

    pub fn set_root(&mut self, index: u64, root: [u8; 32]) -> Result<(), String> {
        let offset = ROOT_TABLE_START + (index as usize * ROOT_SIZE);
        if offset + ROOT_SIZE > ROOT_TABLE_END {
            return Err("root index out of bounds".to_string());
        }
        self.buffer[offset..offset + ROOT_SIZE].copy_from_slice(&root);
        Ok(())
    }

    pub fn get_file_record(&self, index: u32) -> FileRecordV1 {
        let offset = FILE_TABLE_START + FILE_TABLE_HEADER_SIZE + (index as usize * FILE_RECORD_SIZE);
        FileRecordV1::from_bytes(&self.buffer[offset..offset + FILE_RECORD_SIZE])
    }

    pub fn append_file_record(&mut self, rec: FileRecordV1) -> Result<(), String> {
        let index = self.header.record_count;
        let offset = FILE_TABLE_START + FILE_TABLE_HEADER_SIZE + (index as usize * FILE_RECORD_SIZE);

        if offset + FILE_RECORD_SIZE > FILE_TABLE_END {
            return Err("file table full".to_string());
        }

        let bytes = rec.to_bytes();
        self.buffer[offset..offset + FILE_RECORD_SIZE].copy_from_slice(&bytes);

        self.header.record_count += 1;
        self.flush_header();
        Ok(())
    }

    pub fn update_file_record(&mut self, index: u32, rec: FileRecordV1) -> Result<(), String> {
        if index >= self.header.record_count {
            return Err("index out of bounds".to_string());
        }
        let offset = FILE_TABLE_START + FILE_TABLE_HEADER_SIZE + (index as usize * FILE_RECORD_SIZE);
        
        let bytes = rec.to_bytes();
        self.buffer[offset..offset + FILE_RECORD_SIZE].copy_from_slice(&bytes);
        Ok(())
    }

    pub fn find_free_slot_and_insert(&mut self, mut rec: FileRecordV1) -> Result<u32, String> {
        let (required_len, _) = layout::unpack_length_and_flags(rec.length_and_flags);

        for i in 0..self.header.record_count {
            let existing = self.get_file_record(i);
            // Check if Tombstone
            if existing.path[0] == 0 {
                let (tomb_len, _) = layout::unpack_length_and_flags(existing.length_and_flags);
                if tomb_len >= required_len {
                    // FOUND MATCH.
                    
                    // 1. Overwrite this slot with new record
                    // Preserve the original StartOffset of the slot!
                    rec.start_offset = existing.start_offset;
                    if let Err(e) = self.update_file_record(i, rec) {
                        return Err(e);
                    }

                    // 2. Handle Split (if leftover space > 0)
                    let leftover = tomb_len - required_len;
                    if leftover > 0 {
                        // Append a new tombstone at the end
                        let new_tomb = FileRecordV1 {
                            start_offset: existing.start_offset + required_len,
                            length_and_flags: layout::pack_length_and_flags(leftover, 0),
                            timestamp: 0,
                            path: [0; 40],
                        };
                        // Path is already all zeros
                        if let Err(e) = self.append_file_record(new_tomb) {
                            return Err(e);
                        }
                    }
                    return Ok(i);
                }
            }
        }

        // No suitable tombstone found. Append.
        if let Err(e) = self.append_file_record(rec) {
            return Err(e);
        }
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
        // 201,326,592 / 8,388,608 = 24.0000... -> 24 MDUs
        let expected_w = 24u64;
        assert_eq!(b.witness_mdu_count, expected_w, "W calculation failed. Want {}, got {}", expected_w, b.witness_mdu_count);
    }

    #[test]
    fn test_append_file_record() {
        let mut b = Mdu0Builder::new(100);

        // Add file 1
        let mut path = [0u8; 40];
        path[..9].copy_from_slice(b"file1.txt");
        let rec1 = FileRecordV1 {
            start_offset: 0,
            length_and_flags: layout::pack_length_and_flags(1024, 0),
            timestamp: 100,
            path,
        };

        b.append_file_record(rec1).expect("Append failed");

        assert_eq!(b.header.record_count, 1, "RecordCount mismatch. Want 1");

        // Verify it's in the File Table
        let fetched_rec = b.get_file_record(0);
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
        let fetched = b.get_root(0);
        assert_eq!(fetched, dummy_root, "GetRoot mismatch");
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

        let fetched = b2.get_file_record(0);
        assert_eq!(fetched.timestamp, 555, "Loaded record content mismatch");
    }

    #[test]
    fn test_find_free_space_tombstone_splitting() {
        let mut b = Mdu0Builder::new(1000);

        // 1. Add 100KB file
        let mut path = [0u8; 40];
        path[..7].copy_from_slice(b"big.txt");
        let mut rec1 = FileRecordV1 {
            start_offset: 0,
            length_and_flags: layout::pack_length_and_flags(100000, 0),
            path,
            ..Default::default()
        };
        b.append_file_record(rec1).unwrap();

        // 2. Delete it (Tombstone)
        rec1.path[0] = 0;
        b.update_file_record(0, rec1).unwrap();

        // 3. Add 30KB file. Should reuse slot 0.
        let mut path2 = [0u8; 40];
        path2[..9].copy_from_slice(b"small.txt");
        let rec2 = FileRecordV1 {
            length_and_flags: layout::pack_length_and_flags(30000, 0),
            path: path2,
            ..Default::default()
        };

        let idx = b.find_free_slot_and_insert(rec2).expect("FindFreeSlot failed");

        assert_eq!(idx, 0, "Expected reuse of slot 0");

        // 4. Verify splitting
        // Slot 0 should be "small.txt" (30KB)
        let slot0 = b.get_file_record(0);
        let (l, _) = layout::unpack_length_and_flags(slot0.length_and_flags);
        assert_eq!(l, 30000, "Slot 0 length wrong");

        // Slot 1 should be Tombstone (70KB)
        // RecordCount should be 2
        assert_eq!(b.header.record_count, 2, "Expected 2 records (1 active + 1 split tombstone)");
        
        let slot1 = b.get_file_record(1);
        assert_eq!(slot1.path[0], 0, "Slot 1 should be tombstone");
        
        let (l1, _) = layout::unpack_length_and_flags(slot1.length_and_flags);
        assert_eq!(l1, 70000, "Tombstone size wrong");
    }
}

pub const MAGIC_NILF: [u8; 4] = [0x4E, 0x49, 0x4C, 0x46]; // "NILF"
pub const FILE_RECORD_SIZE: usize = 256;
pub const FILE_RECORD_PATH_BYTES: usize = FILE_RECORD_SIZE - 24;

pub const FLAG_ENCRYPTED: u8 = 0x80; // Bit 7
pub const FLAG_HIDDEN: u8 = 0x40; // Bit 6
pub const FLAG_COMPRESSION_MASK: u8 = 0x0F; // Bits 0-3

pub const FLAG_COMPRESSION_NONE: u8 = 0x00;
pub const FLAG_COMPRESSION_GZIP: u8 = 0x01;
pub const FLAG_COMPRESSION_ZSTD: u8 = 0x02;
pub const FLAG_COMPRESSION_BROTLI: u8 = 0x03;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct FileTableHeader {
    pub magic: [u8; 4],      // 4 bytes
    pub version: u8,         // 1 byte
    pub pad1: u8,            // 1 byte (Explicit alignment padding)
    pub record_size: u16,    // 2 bytes
    pub record_count: u32,   // 4 bytes
    pub reserved: [u8; 116], // 116 bytes padding
}

impl Default for FileTableHeader {
    fn default() -> Self {
        Self {
            magic: MAGIC_NILF,
            version: 2,
            pad1: 0,
            record_size: FILE_RECORD_SIZE as u16,
            record_count: 0,
            reserved: [0; 116],
        }
    }
}

impl FileTableHeader {
    pub const SIZE: usize = 128;

    pub fn to_bytes(&self) -> [u8; Self::SIZE] {
        let mut bytes = [0u8; Self::SIZE];
        bytes[0..4].copy_from_slice(&self.magic);
        bytes[4] = self.version;
        bytes[5] = self.pad1;
        bytes[6..8].copy_from_slice(&self.record_size.to_le_bytes());
        bytes[8..12].copy_from_slice(&self.record_count.to_le_bytes());
        bytes[12..].copy_from_slice(&self.reserved);
        bytes
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() != Self::SIZE {
            return Err("invalid wire record size".into());
        }
        let mut magic = [0u8; 4];
        magic.copy_from_slice(&bytes[0..4]);
        let version = bytes[4];
        let pad1 = bytes[5];
        let record_size = u16::from_le_bytes(bytes[6..8].try_into().unwrap());
        let record_count = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
        let mut reserved = [0u8; 116];
        reserved.copy_from_slice(&bytes[12..128]);

        Ok(Self {
            magic,
            version,
            pad1,
            record_size,
            record_count,
            reserved,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct FileRecordV1 {
    pub start_offset: u64,                  // 8 bytes (Little Endian)
    pub length_and_flags: u64,              // 8 bytes (Little Endian)
    pub timestamp: u64,                     // 8 bytes (Little Endian)
    pub path: [u8; FILE_RECORD_PATH_BYTES], // UTF-8; zero-padded unless all 232 bytes are used
}

impl Default for FileRecordV1 {
    fn default() -> Self {
        Self {
            start_offset: 0,
            length_and_flags: 0,
            timestamp: 0,
            path: [0; FILE_RECORD_PATH_BYTES],
        }
    }
}

impl FileRecordV1 {
    pub const SIZE: usize = FILE_RECORD_SIZE;

    pub fn to_bytes(&self) -> [u8; Self::SIZE] {
        let mut bytes = [0u8; Self::SIZE];
        bytes[0..8].copy_from_slice(&self.start_offset.to_le_bytes());
        bytes[8..16].copy_from_slice(&self.length_and_flags.to_le_bytes());
        bytes[16..24].copy_from_slice(&self.timestamp.to_le_bytes());
        bytes[24..].copy_from_slice(&self.path);
        bytes
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() != Self::SIZE {
            return Err("invalid wire record size".into());
        }
        let start_offset = u64::from_le_bytes(bytes[0..8].try_into().unwrap());
        let length_and_flags = u64::from_le_bytes(bytes[8..16].try_into().unwrap());
        let timestamp = u64::from_le_bytes(bytes[16..24].try_into().unwrap());
        let mut path = [0u8; FILE_RECORD_PATH_BYTES];
        path.copy_from_slice(&bytes[24..Self::SIZE]);

        Ok(Self {
            start_offset,
            length_and_flags,
            timestamp,
            path,
        })
    }
}

/// Encode without silently dropping high length bits.
pub fn pack_length_and_flags(length: u64, flags: u8) -> Result<u64, String> {
    if length > 0x00FF_FFFF_FFFF_FFFF {
        return Err("file length exceeds 56-bit capacity".into());
    }
    Ok(((flags as u64) << 56) | length)
}

/// Existing PolyFS path policy, applied without changing the stored name.
pub fn validate_file_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.len() > FILE_RECORD_PATH_BYTES || path.trim() != path {
        return Err("path must contain 1..232 UTF-8 bytes without outer whitespace".into());
    }
    if path.starts_with('/')
        || path.contains('\\')
        || path.bytes().any(|b| b < 0x20 || b == 0x7f)
        || path.split('/').any(|part| part == "..")
    {
        return Err("invalid PolyFS path".into());
    }
    Ok(())
}

impl FileRecordV1 {
    pub fn from_path(
        path: &str,
        length: u64,
        start_offset: u64,
        flags: u8,
    ) -> Result<Self, String> {
        validate_file_path(path)?;
        let mut rec = Self {
            start_offset,
            length_and_flags: pack_length_and_flags(length, flags)?,
            ..Default::default()
        };
        rec.path[..path.len()].copy_from_slice(path.as_bytes());
        rec.validate(false)?;
        Ok(rec)
    }

    pub(crate) fn validate(&self, legacy_recovery: bool) -> Result<(), String> {
        let (length, _) = unpack_length_and_flags(self.length_and_flags);
        self.start_offset
            .checked_add(length)
            .ok_or("file extent overflow")?;
        let end = self
            .path
            .iter()
            .position(|b| *b == 0)
            .unwrap_or(self.path.len());
        if legacy_recovery && end == 0 {
            return Ok(());
        } // Historical deletion retained the suffix.
        if self.path[end..].iter().any(|b| *b != 0) {
            return Err("nonzero path padding".into());
        }
        if end == 0 {
            return Ok(());
        } // A canonical tombstone has an entirely zero path.
        let path = std::str::from_utf8(&self.path[..end]).map_err(|_| "invalid path UTF-8")?;
        validate_file_path(path)
    }
}

pub fn unpack_length_and_flags(val: u64) -> (u64, u8) {
    let length = val & 0x00FFFFFFFFFFFFFF;
    let flags = (val >> 56) as u8;
    (length, flags)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bit_packing() {
        let raw_length = 100u64;
        let flags = FLAG_ENCRYPTED | FLAG_COMPRESSION_GZIP;

        // Pack
        let packed = pack_length_and_flags(raw_length, flags).unwrap();

        // Verify Packing
        let expected_top_byte = 0x81u64;
        assert_eq!(
            packed >> 56,
            expected_top_byte,
            "Packing failed. Expected top byte {:x}, got {:x}",
            expected_top_byte,
            packed >> 56
        );
        assert_eq!(
            packed & 0x00FFFFFFFFFFFFFF,
            raw_length,
            "Packing corrupted length"
        );

        // Unpack
        let (l, f) = unpack_length_and_flags(packed);
        assert_eq!(l, raw_length, "Unpack length mismatch");
        assert_eq!(f, flags, "Unpack flags mismatch");
    }

    #[test]
    fn test_struct_alignment() {
        assert_eq!(
            std::mem::size_of::<FileRecordV1>(),
            FILE_RECORD_SIZE,
            "FileRecordV1 size mismatch"
        );
        assert_eq!(
            std::mem::size_of::<FileTableHeader>(),
            128,
            "FileTableHeader size mismatch"
        );
    }

    #[test]
    fn test_serialization() {
        // 1. FileRecordV1
        let mut path = [0u8; FILE_RECORD_PATH_BYTES];
        let path_bytes = b"test/file.txt";
        path[..path_bytes.len()].copy_from_slice(path_bytes);

        let original_rec = FileRecordV1 {
            start_offset: 123456,
            length_and_flags: pack_length_and_flags(500, FLAG_ENCRYPTED).unwrap(),
            timestamp: 1700000000,
            path,
        };

        let bytes = original_rec.to_bytes();
        let deserialized_rec = FileRecordV1::from_bytes(&bytes).unwrap();

        assert_eq!(
            original_rec, deserialized_rec,
            "Serialization roundtrip failed for FileRecordV1"
        );

        // 2. FileTableHeader
        let mut reserved = [0u8; 116];
        reserved[0] = 0xFF; // Set some non-zero padding to check it carries over

        let original_header = FileTableHeader {
            magic: MAGIC_NILF,
            version: 1,
            pad1: 0,
            record_size: FILE_RECORD_SIZE as u16,
            record_count: 5,
            reserved,
        };

        let bytes = original_header.to_bytes();
        let deserialized_header = FileTableHeader::from_bytes(&bytes).unwrap();

        assert_eq!(
            original_header, deserialized_header,
            "Serialization roundtrip failed for FileTableHeader"
        );
    }
}

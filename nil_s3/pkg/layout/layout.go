package layout

// MagicNILF is the magic bytes "NILF" (0x4E494C46)
var MagicNILF = []byte{0x4E, 0x49, 0x4C, 0x46}

// Flags for FileRecordV1
const (
	FlagEncrypted       = 0x80 // Bit 7
	FlagHidden          = 0x40 // Bit 6
	FlagCompressionMask = 0x0F // Bits 0-3

	FlagCompressionNone   = 0x00
	FlagCompressionGzip   = 0x01
	FlagCompressionZstd   = 0x02
	FlagCompressionBrotli = 0x03
)

// FileTableHeader is the 128-byte header at the start of the File Table region (MDU #0, Blob 16).
type FileTableHeader struct {
	Magic       [4]byte   // 4 bytes
	Version     uint8     // 1 byte
	Pad1        uint8     // 1 byte (Explicit alignment padding)
	RecordSize  uint16    // 2 bytes
	RecordCount uint32    // 4 bytes
	Reserved    [116]byte // 116 bytes padding
}

// FileRecordV1 is the 64-byte metadata record for a file.
type FileRecordV1 struct {
	StartOffset    uint64   // 8 bytes (Little Endian)
	LengthAndFlags uint64   // 8 bytes (Little Endian)
	Timestamp      uint64   // 8 bytes (Little Endian)
	Path           [40]byte // 40 bytes (Null-terminated)
}

// PackLengthAndFlags packs the length (lower 56 bits) and flags (top 8 bits) into a uint64.
func PackLengthAndFlags(length uint64, flags uint8) uint64 {
	// Clear top 8 bits of length just in case
	cleanLength := length & 0x00FFFFFFFFFFFFFF
	// Shift flags to top
	packedFlags := uint64(flags) << 56
	return packedFlags | cleanLength
}

// UnpackLengthAndFlags unpacks the uint64 into length and flags.
func UnpackLengthAndFlags(val uint64) (length uint64, flags uint8) {
	length = val & 0x00FFFFFFFFFFFFFF
	flags = uint8(val >> 56)
	return length, flags
}

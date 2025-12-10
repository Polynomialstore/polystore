package layout

import (
	"bytes"
	"encoding/binary"
	"testing"
	"unsafe"
)

func TestBitPacking(t *testing.T) {
	// Scenario: Length 100, Encrypted (0x80), Gzip (0x01)
	rawLength := uint64(100)
	flags := uint8(FlagEncrypted | FlagCompressionGzip)

	// Pack
	packed := PackLengthAndFlags(rawLength, flags)

	// Verify Packing
	// Top byte should be 0x81 (129), lower 7 bytes should be 100
	expectedTopByte := uint64(0x81)
	if (packed >> 56) != expectedTopByte {
		t.Errorf("Packing failed. Expected top byte %x, got %x", expectedTopByte, packed>>56)
	}
	if (packed & 0x00FFFFFFFFFFFFFF) != rawLength {
		t.Errorf("Packing corrupted length. Expected %d, got %d", rawLength, packed&0x00FFFFFFFFFFFFFF)
	}

	// Unpack
	l, f := UnpackLengthAndFlags(packed)
	if l != rawLength {
		t.Errorf("Unpack length mismatch. Want %d, got %d", rawLength, l)
	}
	if f != flags {
		t.Errorf("Unpack flags mismatch. Want %x, got %x", flags, f)
	}
}

func TestStructAlignment(t *testing.T) {
	var rec FileRecordV1
	if size := unsafe.Sizeof(rec); size != 64 {
		t.Errorf("FileRecordV1 size mismatch. Want 64, got %d", size)
	}

	var header FileTableHeader
	if size := unsafe.Sizeof(header); size != 128 {
		t.Errorf("FileTableHeader size mismatch. Want 128, got %d", size)
	}
}

func TestSerialization(t *testing.T) {
	// 1. FileRecordV1
	originalRec := FileRecordV1{
		StartOffset:    123456,
		LengthAndFlags: PackLengthAndFlags(500, uint8(FlagEncrypted)),
		Timestamp:      1700000000,
	}
	copy(originalRec.Path[:], "test/file.txt")

	var buf bytes.Buffer
	if err := binary.Write(&buf, binary.LittleEndian, &originalRec); err != nil {
		t.Fatalf("Binary write failed: %v", err)
	}

	var deserializedRec FileRecordV1
	if err := binary.Read(&buf, binary.LittleEndian, &deserializedRec); err != nil {
		t.Fatalf("Binary read failed: %v", err)
	}

	if originalRec != deserializedRec {
		t.Errorf("Serialization roundtrip failed for FileRecordV1.\nWant: %+v\nGot:  %+v", originalRec, deserializedRec)
	}

	// 2. FileTableHeader
	originalHeader := FileTableHeader{
		Version:     1,
		RecordSize:  64,
		RecordCount: 5,
	}
	copy(originalHeader.Magic[:], MagicNILF)

	buf.Reset()
	if err := binary.Write(&buf, binary.LittleEndian, &originalHeader); err != nil {
		t.Fatalf("Binary write failed: %v", err)
	}

	var deserializedHeader FileTableHeader
	if err := binary.Read(&buf, binary.LittleEndian, &deserializedHeader); err != nil {
		t.Fatalf("Binary read failed: %v", err)
	}

	if originalHeader != deserializedHeader {
		t.Errorf("Serialization roundtrip failed for FileTableHeader.\nWant: %+v\nGot:  %+v", originalHeader, deserializedHeader)
	}
}

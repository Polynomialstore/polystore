package builder

import (
	"bytes"
	"testing"

	"nil_s3/pkg/layout"
)

func TestInitEmptyMdu0(t *testing.T) {
	maxUserMdus := uint64(65536)
	b, err := NewMdu0Builder(maxUserMdus)
	if err != nil {
		t.Fatalf("Failed to create builder: %v", err)
	}

	// 1. Verify Header
	if !bytes.Equal(b.Header.Magic[:], layout.MagicNILF) {
		t.Errorf("Magic mismatch")
	}
	if b.Header.RecordCount != 0 {
		t.Errorf("Expected 0 records, got %d", b.Header.RecordCount)
	}

	// 2. Verify W Calculation
	// 65536 MDUs * 64 blobs/MDU * 48 bytes/blob = 201,326,592 bytes
	// 201,326,592 / 8,388,608 = 24 MDUs
	expectedW := uint64(24)
	if b.WitnessMduCount != expectedW {
		t.Errorf("W calculation failed. Want %d, got %d", expectedW, b.WitnessMduCount)
	}
}

func TestAppendFileRecord(t *testing.T) {
	b, _ := NewMdu0Builder(100)

	// Add file 1
	rec1 := layout.FileRecordV1{
		StartOffset: 0,
		LengthAndFlags: layout.PackLengthAndFlags(1024, 0),
		Timestamp: 100,
	}
	copy(rec1.Path[:], "file1.txt")
	
	err := b.AppendFileRecord(rec1)
	if err != nil {
		t.Fatalf("Append failed: %v", err)
	}

	if b.Header.RecordCount != 1 {
		t.Errorf("RecordCount mismatch. Want 1, got %d", b.Header.RecordCount)
	}
	
	// Verify it's in the File Table
	// File Table starts at Blob 16 (Offset 16 * 128KB = 2,097,152)
	// Header is 128 bytes. Record 0 is at 2,097,152 + 128.
	fetchedRec := b.GetFileRecord(0)
	if fetchedRec.StartOffset != 0 {
		t.Errorf("Fetched record mismatch")
	}
}

func TestAddRoot(t *testing.T) {
	b, _ := NewMdu0Builder(100)

	dummyRoot := [32]byte{0xAA} // Rest zero
	
	// Add root for MDU #1 (Index 0 in Root Table)
	// This should be a Witness MDU root.
	err := b.SetRoot(0, dummyRoot)
	if err != nil {
		t.Fatalf("SetRoot failed: %v", err)
	}

	// Verify
	fetched := b.GetRoot(0)
	if fetched != dummyRoot {
		t.Errorf("GetRoot mismatch")
	}
}

func TestLoadAndModify(t *testing.T) {
	b1, _ := NewMdu0Builder(100)
	rec := layout.FileRecordV1{Timestamp: 555}
	b1.AppendFileRecord(rec)

	data := b1.Bytes()

	b2, err := LoadMdu0Builder(data, 100)
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}

	if b2.Header.RecordCount != 1 {
		t.Errorf("Loaded RecordCount mismatch")
	}

	fetched := b2.GetFileRecord(0)
	if fetched.Timestamp != 555 {
		t.Errorf("Loaded record content mismatch")
	}
}

func TestFindFreeSpace_TombstoneSplitting(t *testing.T) {
	b, _ := NewMdu0Builder(1000)

	// 1. Add 100KB file
	rec1 := layout.FileRecordV1{
		StartOffset: 0,
		LengthAndFlags: layout.PackLengthAndFlags(100000, 0),
	}
	copy(rec1.Path[:], "big.txt")
	b.AppendFileRecord(rec1)

	// 2. Delete it (Tombstone)
	// We manually simulate deletion by setting path[0] = 0
	// In reality, a Delete() method would do this.
	// Let's implement Delete() or UpdateRecord()
	rec1.Path[0] = 0
	b.UpdateFileRecord(0, rec1)

	// 3. Add 30KB file. Should reuse slot 0.
	rec2 := layout.FileRecordV1{
		LengthAndFlags: layout.PackLengthAndFlags(30000, 0),
	}
	copy(rec2.Path[:], "small.txt")
	
	idx, err := b.FindFreeSlotAndInsert(rec2)
	if err != nil {
		t.Fatalf("FindFreeSlot failed: %v", err)
	}

	if idx != 0 {
		t.Errorf("Expected reuse of slot 0, got %d", idx)
	}

	// 4. Verify splitting
	// Slot 0 should be "small.txt" (30KB)
	slot0 := b.GetFileRecord(0)
	l, _ := layout.UnpackLengthAndFlags(slot0.LengthAndFlags)
	if l != 30000 {
		t.Errorf("Slot 0 length wrong. Want 30000, got %d", l)
	}

	// Slot 1 should be Tombstone (70KB)
	// RecordCount should be 2
	if b.Header.RecordCount != 2 {
		t.Errorf("Expected 2 records (1 active + 1 split tombstone), got %d", b.Header.RecordCount)
	}
	slot1 := b.GetFileRecord(1)
	if slot1.Path[0] != 0 {
		t.Errorf("Slot 1 should be tombstone")
	}
	l1, _ := layout.UnpackLengthAndFlags(slot1.LengthAndFlags)
	if l1 != 70000 {
		t.Errorf("Tombstone size wrong. Want 70000, got %d", l1)
	}
}

package crypto_ffi

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"os"
	"strconv"
	"testing"
)

// Identical logical workload also runs against the pre-v2 native library.
// Go allocations exclude native heap; fat_v2_allocations_test.rs covers that heap.
func BenchmarkMdu0Metadata(b *testing.B) {
	builder := NewMdu0Builder(65536)
	if builder == nil {
		b.Fatal("builder unavailable")
	}
	defer builder.Free()
	for i := uint64(0); i < 1000; i++ {
		if err := builder.AppendFile("entry", 31, i*31); err != nil {
			b.Fatal(err)
		}
	}
	data, err := builder.Bytes()
	if err != nil {
		b.Fatal(err)
	}
	b.Run("load_8MiB_1000_records", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			loaded, err := LoadMdu0Builder(data, 65536)
			if err != nil {
				b.Fatal(err)
			}
			loaded.Free()
		}
	})
	b.Run("read_1000_records", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			for j := uint32(0); j < 1000; j++ {
				record, err := builder.GetRecord(j)
				if err != nil || record.StartOffset != uint64(j)*31 {
					b.Fatalf("record %d: %v", j, err)
				}
			}
		}
	})
	b.Run("export_8MiB", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			if _, err := builder.Bytes(); err != nil {
				b.Fatal(err)
			}
		}
	})
}

func TestMetadataV2NativeGoldenAndAtomicAdmission(t *testing.T) {
	var golden struct {
		RootDigest string `json:"root_digest_hex"`
		RootCell   string `json:"root_cell_hex"`
		SHA        string `json:"mdu0_sha256"`
		Records    []struct {
			Path, Start, Length, Timestamp string
			Flags                          uint8
		}
	}
	raw, err := os.ReadFile("../../../polystore_core/testdata/polyfs_fat_v2.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &golden); err != nil {
		t.Fatal(err)
	}
	logical := make([]byte, 6094848)
	copy(logical, []byte{'N', 'I', 'L', 'F', 2, 0, 0, 1})
	binary.LittleEndian.PutUint32(logical[8:], uint32(len(golden.Records)))
	u64 := func(s string) uint64 {
		n, e := strconv.ParseUint(s, 10, 64)
		if e != nil {
			t.Fatal(e)
		}
		return n
	}
	for i, r := range golden.Records {
		at := 128 + i*256
		binary.LittleEndian.PutUint64(logical[at:], u64(r.Start))
		binary.LittleEndian.PutUint64(logical[at+8:], uint64(r.Flags)<<56|u64(r.Length))
		binary.LittleEndian.PutUint64(logical[at+16:], u64(r.Timestamp))
		copy(logical[at+24:at+256], r.Path)
	}
	wire := make([]byte, 8388608)
	cell, err := hex.DecodeString(golden.RootCell)
	if err != nil {
		t.Fatal(err)
	}
	copy(wire, cell)
	for at := 0; at < len(logical); at += 31 {
		copy(wire[2097152+at/31*32+1:2097152+at/31*32+32], logical[at:at+31])
	}
	sum := sha256.Sum256(wire)
	if hex.EncodeToString(sum[:]) != golden.SHA {
		t.Fatal("independent wire hash mismatch")
	}
	b, err := LoadMdu0Builder(wire, 65536)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Free()
	out, err := b.Bytes()
	if err != nil || !bytes.Equal(out, wire) {
		t.Fatalf("pure export changed bytes: %v", err)
	}
	for i, r := range golden.Records {
		rec, err := b.GetRecord(uint32(i))
		if err != nil || string(bytes.TrimRight(rec.Path[:], "\x00")) != r.Path || rec.StartOffset != u64(r.Start) {
			t.Fatalf("record %d: %v", i, err)
		}
	}
	root, err := b.GetRoot(0)
	if err != nil || !bytes.Equal(root, cell) {
		t.Fatalf("root cell: %v", err)
	}
	for _, name := range []string{"x\x00y", string([]byte{255}), " x", "/x", "a/../b", string(bytes.Repeat([]byte{'x'}, 233))} {
		if err := b.AppendFile(name, 1, 0); err == nil {
			t.Fatalf("accepted invalid path %q", name)
		}
	}
	if err := b.AppendFile("x", 1, ^uint64(0)); err == nil {
		t.Fatal("accepted extent overflow")
	}
	if err := b.AppendFile("x", 1<<56, 0); err == nil {
		t.Fatal("accepted length overflow")
	}
	out, err = b.Bytes()
	if err != nil || !bytes.Equal(out, wire) {
		t.Fatal("failed append mutated builder")
	}
	digest, err := hex.DecodeString(golden.RootDigest)
	if err != nil {
		t.Fatal(err)
	}
	if err := b.SetRoot(0, digest); err != nil {
		t.Fatal(err)
	}
	root, err = b.GetRoot(0)
	if err != nil || !bytes.Equal(root, cell) {
		t.Fatal("native producer did not reduce digest exactly once")
	}
	malformed := append([]byte(nil), wire...)
	malformed[len(malformed)-1] = 1
	if _, err := LoadMdu0Builder(malformed, 1); err == nil {
		t.Fatal("accepted corrupt padding")
	}
	legacy := make([]byte, 8388608)
	copy(legacy[2097152:], []byte{'N', 'I', 'L', 'F', 1, 0, 0, 1})
	if _, err := LoadMdu0Builder(legacy, 1); err == nil {
		t.Fatal("ordinary legacy fallback")
	}
	recovery, err := LoadLegacyMdu0ForRecovery(legacy, 1, 64)
	if err != nil {
		t.Fatal(err)
	}
	defer recovery.Free()
	if err := recovery.AppendFile("x", 1, 0); err == nil {
		t.Fatal("mutable recovery")
	}
	staged, err := StageMdu0V2FromTrustedLegacy(legacy, 1, 64)
	if err != nil {
		t.Fatal(err)
	}
	defer staged.Free()
	recovered, err := recovery.Bytes()
	if err != nil || !bytes.Equal(recovered, legacy) {
		t.Fatal("changed original legacy bytes")
	}
	stagedBytes, err := staged.Bytes()
	if err != nil || bytes.Equal(stagedBytes, legacy) {
		t.Fatal("migration did not produce separate v2")
	}
}

package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"nilchain/x/crypto_ffi"
)

func TestSlabMetadataReadWriteRoundTrip(t *testing.T) {
	dealDir := t.TempDir()
	dealID := uint64(42)
	validatedAt := time.Now().UTC().Round(time.Second)

	meta := &slabMetadataDocument{
		SchemaVersion: slabMetadataSchemaVersion,
		GenerationID:  "abc123",
		DealID:        &dealID,
		ManifestRoot:  "0x" + stringsRepeat("a", 96),
		Owner:         "nil1owner",
		Redundancy: &slabMetadataRedundancy{
			K: 8,
			M: 4,
			N: 12,
		},
		Source:      "gateway_test",
		CreatedAt:   time.Now().UTC().Format(time.RFC3339Nano),
		WitnessMdus: 2,
		UserMdus:    3,
		TotalMdus:   6,
		FileRecords: []slabMetadataFileRecord{{
			Path:        "hello.txt",
			StartOffset: 0,
			SizeBytes:   123,
			Flags:       1,
		}},
	}
	validated := validatedAt.Format(time.RFC3339Nano)
	meta.LastValidatedAt = &validated

	if err := writeSlabMetadataFile(dealDir, meta); err != nil {
		t.Fatalf("writeSlabMetadataFile failed: %v", err)
	}

	decoded, err := readSlabMetadataFile(dealDir)
	if err != nil {
		t.Fatalf("readSlabMetadataFile failed: %v", err)
	}
	if decoded.SchemaVersion != slabMetadataSchemaVersion {
		t.Fatalf("unexpected schema_version: %d", decoded.SchemaVersion)
	}
	if decoded.GenerationID != meta.GenerationID {
		t.Fatalf("unexpected generation_id: %q", decoded.GenerationID)
	}
	if decoded.DealID == nil || *decoded.DealID != dealID {
		t.Fatalf("unexpected deal_id: %v", decoded.DealID)
	}
	if decoded.ManifestRoot != meta.ManifestRoot {
		t.Fatalf("unexpected manifest_root: %q", decoded.ManifestRoot)
	}
	if decoded.Source != meta.Source {
		t.Fatalf("unexpected source: %q", decoded.Source)
	}
	if decoded.WitnessMdus != meta.WitnessMdus || decoded.UserMdus != meta.UserMdus || decoded.TotalMdus != meta.TotalMdus {
		t.Fatalf("unexpected mdu counts: witness=%d user=%d total=%d", decoded.WitnessMdus, decoded.UserMdus, decoded.TotalMdus)
	}
	if decoded.LastValidatedAt == nil || *decoded.LastValidatedAt != validated {
		t.Fatalf("unexpected last_validated_at: %v", decoded.LastValidatedAt)
	}
	if len(decoded.FileRecords) != 1 {
		t.Fatalf("unexpected file record count: %d", len(decoded.FileRecords))
	}
	if decoded.FileRecords[0].Path != "hello.txt" || decoded.FileRecords[0].StartOffset != 0 || decoded.FileRecords[0].SizeBytes != 123 || decoded.FileRecords[0].Flags != 1 {
		t.Fatalf("unexpected file record: %+v", decoded.FileRecords[0])
	}
}

func TestLoadSlabIndex_FallbackSynthesizesSlabMetadata(t *testing.T) {
	useTempUploadDir(t)

	manifestRoot := mustTestManifestRoot(t, "slab-metadata-fallback")
	dealDir := filepath.Join(uploadDir, manifestRoot.Key)
	if err := os.MkdirAll(dealDir, 0o755); err != nil {
		t.Fatalf("mkdir deal dir: %v", err)
	}
	defer os.RemoveAll(dealDir)

	builder := crypto_ffi.NewMdu0Builder(1)
	defer builder.Free()
	if err := builder.AppendFileWithFlags("a.txt", 5, 0, 3); err != nil {
		t.Fatalf("AppendFileWithFlags failed: %v", err)
	}
	mdu0, err := builder.Bytes()
	if err != nil {
		t.Fatalf("builder.Bytes failed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_0.bin"), mdu0, 0o644); err != nil {
		t.Fatalf("write mdu_0.bin: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_1.bin"), []byte{1}, 0o644); err != nil {
		t.Fatalf("write mdu_1.bin: %v", err)
	}

	if err := os.WriteFile(filepath.Join(dealDir, slabMetadataFileName), []byte("{corrupt"), 0o644); err != nil {
		t.Fatalf("seed corrupt slab metadata: %v", err)
	}

	entry, err := loadSlabIndex(dealDir)
	if err != nil {
		t.Fatalf("loadSlabIndex failed: %v", err)
	}
	if entry.witnessCount != 0 {
		t.Fatalf("unexpected witness count: %d", entry.witnessCount)
	}
	info, ok := entry.files["a.txt"]
	if !ok {
		t.Fatalf("expected file a.txt in slab index")
	}
	if info.StartOffset != 0 || info.Length != 5 {
		t.Fatalf("unexpected file info: %+v", info)
	}

	meta, err := readSlabMetadataFile(dealDir)
	if err != nil {
		t.Fatalf("expected synthesized slab metadata file, got error: %v", err)
	}
	if meta.Source != "gateway_fallback_mdu0" {
		t.Fatalf("unexpected source: %q", meta.Source)
	}
	if meta.ManifestRoot != manifestRoot.Canonical {
		t.Fatalf("unexpected manifest_root: %q", meta.ManifestRoot)
	}
	if meta.TotalMdus != 2 || meta.WitnessMdus != 0 || meta.UserMdus != 1 {
		t.Fatalf("unexpected mdu counts: witness=%d user=%d total=%d", meta.WitnessMdus, meta.UserMdus, meta.TotalMdus)
	}
	if len(meta.FileRecords) != 1 {
		t.Fatalf("unexpected file record count: %d", len(meta.FileRecords))
	}
	if meta.FileRecords[0].Path != "a.txt" || meta.FileRecords[0].Flags != 3 {
		t.Fatalf("unexpected synthesized file record: %+v", meta.FileRecords[0])
	}
}

func stringsRepeat(ch string, n int) string {
	if n <= 0 {
		return ""
	}
	out := make([]byte, n)
	for i := 0; i < n; i++ {
		out[i] = ch[0]
	}
	return string(out)
}

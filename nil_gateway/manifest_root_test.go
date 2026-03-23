package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"nilchain/x/crypto_ffi"
	"nilchain/x/nilchain/types"
)

func writeTestDealGeneration(t *testing.T, dealID uint64, root ManifestRoot, totalMdus uint64, omitLastMdu bool) string {
	t.Helper()
	if totalMdus < 1 {
		t.Fatalf("totalMdus must be >= 1")
	}
	dealDir := dealScopedDir(dealID, root)
	if err := os.MkdirAll(dealDir, 0o755); err != nil {
		t.Fatalf("mkdir generation dir: %v", err)
	}

	builder := crypto_ffi.NewMdu0Builder(1)
	defer builder.Free()
	if err := builder.AppendFileWithFlags("test.bin", 64, 0, 0); err != nil {
		t.Fatalf("append record: %v", err)
	}
	mdu0, err := builder.Bytes()
	if err != nil {
		t.Fatalf("builder bytes: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_0.bin"), mdu0, 0o644); err != nil {
		t.Fatalf("write mdu_0.bin: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dealDir, "manifest.bin"), []byte{0x01}, 0o644); err != nil {
		t.Fatalf("write manifest.bin: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dealDir, mode2SlabCompleteMarker), []byte("ok\n"), 0o644); err != nil {
		t.Fatalf("write complete marker: %v", err)
	}

	userMdus := totalMdus - 1
	meta := &slabMetadataDocument{
		SchemaVersion: slabMetadataSchemaVersion,
		GenerationID:  root.Key,
		DealID:        &dealID,
		ManifestRoot:  root.Canonical,
		Source:        "gateway_test",
		CreatedAt:     time.Now().UTC().Format(time.RFC3339Nano),
		WitnessMdus:   0,
		UserMdus:      userMdus,
		TotalMdus:     totalMdus,
		FileRecords: []slabMetadataFileRecord{
			{
				Path:        "test.bin",
				StartOffset: 0,
				SizeBytes:   64,
				Flags:       0,
			},
		},
	}
	if err := writeSlabMetadataFile(dealDir, meta); err != nil {
		t.Fatalf("write slab metadata: %v", err)
	}

	for i := uint64(1); i < totalMdus; i++ {
		if omitLastMdu && i == totalMdus-1 {
			continue
		}
		path := filepath.Join(dealDir, fmt.Sprintf("mdu_%d.bin", i))
		if err := os.WriteFile(path, make([]byte, types.MDU_SIZE), 0o644); err != nil {
			t.Fatalf("write %s: %v", path, err)
		}
	}

	return dealDir
}

func TestActiveDealGenerationPointerRoundTrip(t *testing.T) {
	useTempUploadDir(t)
	dealID := uint64(7)
	root := mustTestManifestRoot(t, "pointer-roundtrip")

	if err := writeActiveDealGeneration(dealID, root); err != nil {
		t.Fatalf("writeActiveDealGeneration failed: %v", err)
	}
	got, err := readActiveDealGeneration(dealID)
	if err != nil {
		t.Fatalf("readActiveDealGeneration failed: %v", err)
	}
	if got.Key != root.Key {
		t.Fatalf("pointer mismatch: got=%s want=%s", got.Key, root.Key)
	}
}

func TestResolveDealDirForDealRejectsIncompleteGeneration(t *testing.T) {
	useTempUploadDir(t)
	dealID := uint64(42)
	root := mustTestManifestRoot(t, "incomplete-generation")
	dealDir := writeTestDealGeneration(t, dealID, root, 3, false)

	meta, err := readSlabMetadataFile(dealDir)
	if err != nil {
		t.Fatalf("read metadata: %v", err)
	}
	meta.WitnessMdus = 1
	meta.UserMdus = 1
	meta.TotalMdus = 3
	if err := writeSlabMetadataFile(dealDir, meta); err != nil {
		t.Fatalf("rewrite metadata: %v", err)
	}
	if err := os.Remove(filepath.Join(dealDir, "mdu_1.bin")); err != nil {
		t.Fatalf("remove witness mdu: %v", err)
	}

	if err := writeActiveDealGeneration(dealID, root); err != nil {
		t.Fatalf("write pointer: %v", err)
	}
	if _, err := resolveDealDirForDeal(dealID, root, root.Canonical); !errors.Is(err, ErrDealGenerationNotReady) {
		t.Fatalf("expected ErrDealGenerationNotReady, got %v", err)
	}

	if err := os.WriteFile(filepath.Join(dealDir, "mdu_1.bin"), make([]byte, types.MDU_SIZE), 0o644); err != nil {
		t.Fatalf("write missing witness mdu: %v", err)
	}
	got, err := resolveDealDirForDeal(dealID, root, root.Canonical)
	if err != nil {
		t.Fatalf("resolveDealDirForDeal failed after completing generation: %v", err)
	}
	if got != dealDir {
		t.Fatalf("resolved deal dir mismatch: got=%s want=%s", got, dealDir)
	}
}

func TestCleanupInterruptedDealGenerationsRemovesStagingAndStaleLocks(t *testing.T) {
	useTempUploadDir(t)
	dealID := uint64(77)
	baseDir := dealScopedBaseDir(dealID)
	if err := os.MkdirAll(baseDir, 0o755); err != nil {
		t.Fatalf("mkdir base dir: %v", err)
	}

	stagingDir := filepath.Join(baseDir, "staging-deadbeef")
	if err := os.MkdirAll(stagingDir, 0o755); err != nil {
		t.Fatalf("mkdir staging: %v", err)
	}

	lockName := ".deadbeef.lock"
	lockPath := filepath.Join(baseDir, lockName)
	if err := os.WriteFile(lockPath, []byte("stale\n"), 0o644); err != nil {
		t.Fatalf("write lock: %v", err)
	}
	old := time.Now().Add(-5 * time.Minute)
	if err := os.Chtimes(lockPath, old, old); err != nil {
		t.Fatalf("chtimes lock: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(baseDir, "deadbeef"), 0o755); err != nil {
		t.Fatalf("mkdir lock target dir: %v", err)
	}

	cleanupInterruptedDealGenerations(dealID)

	if _, err := os.Stat(stagingDir); !os.IsNotExist(err) {
		t.Fatalf("expected staging dir removed, stat err=%v", err)
	}
	if _, err := os.Stat(lockPath); !os.IsNotExist(err) {
		t.Fatalf("expected stale lock removed, stat err=%v", err)
	}
}

func TestCleanupInterruptedDealGenerations_KeepsRecentProvisionalGeneration(t *testing.T) {
	useTempUploadDir(t)
	dealID := uint64(78)
	root := mustTestManifestRoot(t, "recent-provisional")
	dealDir := writeTestDealGeneration(t, dealID, root, 2, false)

	meta, err := readSlabMetadataFile(dealDir)
	if err != nil {
		t.Fatalf("read metadata: %v", err)
	}
	meta.GenerationState = slabGenerationStateProvisional
	meta.CreatedAt = time.Now().Add(-1 * time.Hour).UTC().Format(time.RFC3339Nano)
	if err := writeSlabMetadataFile(dealDir, meta); err != nil {
		t.Fatalf("rewrite metadata: %v", err)
	}

	cleanupInterruptedDealGenerations(dealID)

	if info, err := os.Stat(dealDir); err != nil || !info.IsDir() {
		t.Fatalf("expected recent provisional generation retained, stat err=%v", err)
	}
}

func TestCleanupInterruptedDealGenerations_RemovesExpiredProvisionalGeneration(t *testing.T) {
	useTempUploadDir(t)
	dealID := uint64(79)
	root := mustTestManifestRoot(t, "expired-provisional")
	dealDir := writeTestDealGeneration(t, dealID, root, 2, false)

	meta, err := readSlabMetadataFile(dealDir)
	if err != nil {
		t.Fatalf("read metadata: %v", err)
	}
	meta.GenerationState = slabGenerationStateProvisional
	meta.CreatedAt = time.Now().Add(-(provisionalGenerationRetentionTTL + 2*time.Hour)).UTC().Format(time.RFC3339Nano)
	if err := writeSlabMetadataFile(dealDir, meta); err != nil {
		t.Fatalf("rewrite metadata: %v", err)
	}

	cleanupInterruptedDealGenerations(dealID)

	if _, err := os.Stat(dealDir); !os.IsNotExist(err) {
		t.Fatalf("expected expired provisional generation removed, stat err=%v", err)
	}
}

func TestResolveDealDirForDealReconcilesPointerToRequestedGeneration(t *testing.T) {
	useTempUploadDir(t)
	dealID := uint64(91)
	oldRoot := mustTestManifestRoot(t, "old-generation")
	newRoot := mustTestManifestRoot(t, "new-generation")
	writeTestDealGeneration(t, dealID, oldRoot, 2, false)
	newDir := writeTestDealGeneration(t, dealID, newRoot, 2, false)

	if err := writeActiveDealGeneration(dealID, oldRoot); err != nil {
		t.Fatalf("write old pointer: %v", err)
	}

	gotDir, err := resolveDealDirForDeal(dealID, newRoot, newRoot.Canonical)
	if err != nil {
		t.Fatalf("resolveDealDirForDeal failed: %v", err)
	}
	if gotDir != newDir {
		t.Fatalf("resolved dir mismatch: got=%s want=%s", gotDir, newDir)
	}
	active, err := readActiveDealGeneration(dealID)
	if err != nil {
		t.Fatalf("read pointer after reconcile: %v", err)
	}
	if active.Key != newRoot.Key {
		t.Fatalf("active pointer mismatch after reconcile: got=%s want=%s", active.Key, newRoot.Key)
	}
}

func TestCleanupStaleDealGenerations_PromotesCommittedGenerationAndRemovesOld(t *testing.T) {
	useTempUploadDir(t)
	dealID := uint64(92)
	oldRoot := mustTestManifestRoot(t, "cleanup-promote-old")
	newRoot := mustTestManifestRoot(t, "cleanup-promote-new")

	oldDir := writeTestDealGeneration(t, dealID, oldRoot, 2, false)
	newDir := writeTestDealGeneration(t, dealID, newRoot, 2, false)

	if err := writeActiveDealGeneration(dealID, oldRoot); err != nil {
		t.Fatalf("write old pointer: %v", err)
	}

	cleanupStaleDealGenerations(dealID, newRoot)

	if _, err := os.Stat(oldDir); !os.IsNotExist(err) {
		t.Fatalf("expected old generation removed after cleanup, stat err=%v", err)
	}
	if info, err := os.Stat(newDir); err != nil || !info.IsDir() {
		t.Fatalf("expected new generation to remain, stat err=%v", err)
	}
	meta, err := readSlabMetadataFile(newDir)
	if err != nil {
		t.Fatalf("read promoted slab metadata: %v", err)
	}
	if meta.GenerationState != slabGenerationStateActive {
		t.Fatalf("expected promoted generation state active, got=%q", meta.GenerationState)
	}
	active, err := readActiveDealGeneration(dealID)
	if err != nil {
		t.Fatalf("read pointer after cleanup: %v", err)
	}
	if active.Key != newRoot.Key {
		t.Fatalf("active pointer mismatch after cleanup: got=%s want=%s", active.Key, newRoot.Key)
	}
}

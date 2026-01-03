package main

import (
	"os"
	"path/filepath"
	"testing"

	"nilchain/x/nilchain/types"
)

func TestMode2FinalizeStagingDir_MergesIntoExistingDir(t *testing.T) {
	base := t.TempDir()
	finalDir := filepath.Join(base, "final")
	if err := os.MkdirAll(finalDir, 0o755); err != nil {
		t.Fatalf("MkdirAll(finalDir) failed: %v", err)
	}

	// Simulate an incomplete prior attempt: destination dir exists, but is missing the marker
	// and does not have the required artifacts yet.
	if err := os.WriteFile(filepath.Join(finalDir, "manifest.bin"), []byte("partial"), 0o644); err != nil {
		t.Fatalf("WriteFile(partial manifest) failed: %v", err)
	}

	stagingDir, err := os.MkdirTemp(base, "staging-")
	if err != nil {
		t.Fatalf("MkdirTemp(staging) failed: %v", err)
	}

	mdu0Path := filepath.Join(stagingDir, "mdu_0.bin")
	mdu0, err := os.Create(mdu0Path)
	if err != nil {
		t.Fatalf("Create(mdu0) failed: %v", err)
	}
	if err := mdu0.Truncate(int64(types.MDU_SIZE)); err != nil {
		_ = mdu0.Close()
		t.Fatalf("Truncate(mdu0) failed: %v", err)
	}
	if err := mdu0.Close(); err != nil {
		t.Fatalf("Close(mdu0) failed: %v", err)
	}

	manifestPath := filepath.Join(stagingDir, "manifest.bin")
	manifest, err := os.Create(manifestPath)
	if err != nil {
		t.Fatalf("Create(manifest) failed: %v", err)
	}
	if err := manifest.Truncate(int64(types.BLOB_SIZE)); err != nil {
		_ = manifest.Close()
		t.Fatalf("Truncate(manifest) failed: %v", err)
	}
	if err := manifest.Close(); err != nil {
		t.Fatalf("Close(manifest) failed: %v", err)
	}

	if err := os.WriteFile(filepath.Join(stagingDir, mode2SlabCompleteMarker), []byte("ok\n"), 0o644); err != nil {
		t.Fatalf("WriteFile(marker) failed: %v", err)
	}

	if err := mode2FinalizeStagingDir(stagingDir, finalDir); err != nil {
		t.Fatalf("mode2FinalizeStagingDir failed: %v", err)
	}

	if _, err := os.Stat(stagingDir); !os.IsNotExist(err) {
		t.Fatalf("stagingDir should be removed, statErr=%v", err)
	}
	if _, err := os.Stat(filepath.Join(finalDir, mode2SlabCompleteMarker)); err != nil {
		t.Fatalf("marker missing in finalDir: %v", err)
	}
	if info, err := os.Stat(filepath.Join(finalDir, "mdu_0.bin")); err != nil {
		t.Fatalf("mdu_0.bin missing in finalDir: %v", err)
	} else if info.Size() != int64(types.MDU_SIZE) {
		t.Fatalf("mdu_0.bin size mismatch: got %d want %d", info.Size(), types.MDU_SIZE)
	}
	if info, err := os.Stat(filepath.Join(finalDir, "manifest.bin")); err != nil {
		t.Fatalf("manifest.bin missing in finalDir: %v", err)
	} else if info.Size() != int64(types.BLOB_SIZE) {
		t.Fatalf("manifest.bin size mismatch: got %d want %d", info.Size(), types.BLOB_SIZE)
	}
}

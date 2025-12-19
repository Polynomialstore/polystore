package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"nilchain/x/crypto_ffi"
	"nilchain/x/nilchain/types"
)

func TestBenchmarkProofGen(t *testing.T) {
	// Locate trusted setup relative to nil_gateway directory
	setupPath := "../nilchain/trusted_setup.txt"
	if _, err := os.Stat(setupPath); os.IsNotExist(err) {
		t.Skipf("trusted setup not found at %s", setupPath)
	}

	if err := crypto_ffi.Init(setupPath); err != nil {
		t.Fatalf("Init failed: %v", err)
	}

	tmpDir := t.TempDir()

	// Create a minimal slab layout:
	// - mdu_0.bin (valid NilFS header + one file record so userCount=1)
	// - mdu_1.bin (witness, zero-filled)
	// - mdu_2.bin (user, zero-filled)
	b := crypto_ffi.NewMdu0Builder(1)
	defer b.Free()

	if err := b.AppendFile("bench.bin", 1, 0); err != nil {
		t.Fatal(err)
	}
	mdu0Data, _ := b.Bytes()
	if err := os.WriteFile(filepath.Join(tmpDir, "mdu_0.bin"), mdu0Data, 0o644); err != nil {
		t.Fatal(err)
	}

	zeroMdu := make([]byte, types.MDU_SIZE)
	if err := os.WriteFile(filepath.Join(tmpDir, "mdu_1.bin"), zeroMdu, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tmpDir, "mdu_2.bin"), zeroMdu, 0o644); err != nil {
		t.Fatal(err)
	}

	manifestPath := filepath.Join(tmpDir, "manifest.bin")
	manifestData := make([]byte, types.BLOB_SIZE)
	if err := os.WriteFile(manifestPath, manifestData, 0o644); err != nil {
		t.Fatal(err)
	}
	mduPath := filepath.Join(tmpDir, "mdu_2.bin")

	start := time.Now()
	_, _, err := generateProofHeaderJSON(context.Background(), 1, 1, 2, mduPath, manifestPath, 0, 0, 64, 0)
	if err != nil {
		t.Fatalf("generateProofHeaderJSON failed: %v", err)
	}
	elapsed := time.Since(start)
	t.Logf("generateProofHeaderJSON took %s", elapsed)
}

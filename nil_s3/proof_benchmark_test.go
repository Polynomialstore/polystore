package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"nilchain/x/crypto_ffi"
	"nilchain/x/nilchain/types"

	"nil_s3/pkg/builder"
	"nil_s3/pkg/layout"
)

func TestBenchmarkProofGen(t *testing.T) {
	// Locate trusted setup relative to nil_s3 directory
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
	b, err := builder.NewMdu0Builder(1)
	if err != nil {
		t.Fatal(err)
	}
	var pathBuf [40]byte
	copy(pathBuf[:], []byte("bench.bin"))
	rec := layout.FileRecordV1{
		StartOffset:    0,
		LengthAndFlags: layout.PackLengthAndFlags(1, 0),
		Path:           pathBuf,
	}
	if err := b.AppendFileRecord(rec); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tmpDir, "mdu_0.bin"), b.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}

	zeroMdu := make([]byte, builder.MduSize)
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
	_, err = generateProofHeaderJSON(context.Background(), 1, 1, 2, mduPath, manifestPath)
	if err != nil {
		t.Fatalf("generateProofHeaderJSON failed: %v", err)
	}
	elapsed := time.Since(start)
	t.Logf("generateProofHeaderJSON took %s", elapsed)
}

package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/types"
)

func buildProofBenchmarkFixture(t testing.TB) (manifestPath string, mduPath string) {
	t.Helper()

	// Locate trusted setup relative to polystore_gateway directory.
	setupPath := "../polystorechain/trusted_setup.txt"
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
	builder := crypto_ffi.NewMdu0Builder(1)
	defer builder.Free()

	if err := builder.AppendFile("bench.bin", 1, 0); err != nil {
		t.Fatal(err)
	}
	mdu0Data, _ := builder.Bytes()
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

	manifestPath = filepath.Join(tmpDir, "manifest.bin")
	manifestData := make([]byte, types.BLOB_SIZE)
	if err := os.WriteFile(manifestPath, manifestData, 0o644); err != nil {
		t.Fatal(err)
	}

	mduPath = filepath.Join(tmpDir, "mdu_2.bin")
	return manifestPath, mduPath
}

func BenchmarkProofHeaderJSON(b *testing.B) {
	manifestPath, mduPath := buildProofBenchmarkFixture(b)

	// Stable timing for proof-header generation.
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _, err := generateProofHeaderJSON(context.Background(), 1, 1, 2, mduPath, manifestPath, 0, 0, 64, 0)
		if err != nil {
			b.Fatalf("generateProofHeaderJSON failed: %v", err)
		}
	}
}

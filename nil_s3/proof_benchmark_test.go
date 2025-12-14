package main

import (
	"context"
	"os"
	"testing"
	"time"

	"nilchain/x/crypto_ffi"
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

	// Create dummy files
	mduPath := "test_mdu.bin"
	manifestPath := "test_manifest.bin"
	defer os.Remove(mduPath)
	defer os.Remove(manifestPath)

	mduData := make([]byte, 8388608)
	if err := os.WriteFile(mduPath, mduData, 0644); err != nil {
		t.Fatal(err)
	}

	manifestData := make([]byte, 131072)
	if err := os.WriteFile(manifestPath, manifestData, 0644); err != nil {
		t.Fatal(err)
	}

	start := time.Now()
	_, err := generateProofJSON(context.Background(), 1, 1, 0, mduPath, manifestPath)
	if err != nil {
		t.Fatalf("generateProofJSON failed: %v", err)
	}
	elapsed := time.Since(start)
	t.Logf("generateProofJSON took %s", elapsed)
}

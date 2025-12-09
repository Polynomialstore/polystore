package crypto_ffi

import (
	"testing"
    "os"
    "path/filepath"
)

func TestInit(t *testing.T) {
    // Locate trusted setup relative to this test file
    // We are in nilchain/x/crypto_ffi
    // Trusted setup is in ../../../demos/kzg/trusted_setup.txt
    
    wd, _ := os.Getwd()
    path := filepath.Join(wd, "../../../demos/kzg/trusted_setup.txt")

    err := Init(path)
    if err != nil {
        t.Fatalf("Init failed: %v", err)
    }
}

func TestVerifyMduProof(t *testing.T) {
    // This test depends on Init being called (Global state).
    // Tests run in same process usually.
    
    // Dummy data (should fail verification but return false, not error)
    mduRoot := make([]byte, 32)
    comm := make([]byte, 48)
    merklePath := make([]byte, 32) // Minimal path
    z := make([]byte, 32)
    y := make([]byte, 32)
    proof := make([]byte, 48)

    valid, err := VerifyMduProof(mduRoot, comm, merklePath, 0, z, y, proof)
    if err != nil {
        // It might return error if internal check fails, but here we expect false
        // Actually invalid points (all zeros) might cause C-KZG error?
        t.Logf("Verification returned: %v, err: %v", valid, err)
    }
    
    if valid {
        t.Fatal("Proof of zeros should not be valid")
    }
}

func TestVerifyChainedProof(t *testing.T) {
    manifestComm := make([]byte, 48)
    manifestProof := make([]byte, 48)
    mduRoot := make([]byte, 32)
    blobComm := make([]byte, 48)
    blobProof := make([]byte, 48)
    z := make([]byte, 32)
    y := make([]byte, 32)
    merklePath := make([]byte, 32)

    valid, err := VerifyChainedProof(
        manifestComm, 0, manifestProof, mduRoot, 
        blobComm, 0, merklePath, 
        z, y, blobProof,
    )
    
    if err != nil {
        t.Logf("Chained Verification returned: %v, err: %v", valid, err)
    }
    if valid {
         t.Fatal("Proof of zeros should not be valid")
    }
}

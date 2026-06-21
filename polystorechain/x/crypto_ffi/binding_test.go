package crypto_ffi

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"polystorechain/x/polystorechain/types"
)

func TestInit(t *testing.T) {
	// Locate trusted setup relative to this test file
	// We are in polystorechain/x/crypto_ffi
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

	valid, err := VerifyMduProof(mduRoot, comm, merklePath, 0, 64, z, y, proof)
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
		blobComm, 0, 64, merklePath,
		z, y, blobProof,
	)

	if err != nil {
		t.Logf("Chained Verification returned: %v, err: %v", valid, err)
	}
	if valid {
		t.Fatal("Proof of zeros should not be valid")
	}
}

func TestEncodeDecodePayloadToMduRoundtrip(t *testing.T) {
	payload := make([]byte, 1000)
	for i := range payload {
		payload[i] = byte(i % 251)
	}

	mdu, err := EncodePayloadToMdu(payload)
	if err != nil {
		t.Fatalf("EncodePayloadToMdu failed: %v", err)
	}
	if len(mdu) != 8*1024*1024 {
		t.Fatalf("unexpected MDU length: %d", len(mdu))
	}

	decoded, err := DecodePayloadFromMdu(mdu, uint64(len(payload)))
	if err != nil {
		t.Fatalf("DecodePayloadFromMdu failed: %v", err)
	}
	if !bytes.Equal(decoded, payload) {
		t.Fatalf("decoded payload mismatch: got %d bytes", len(decoded))
	}
}

func TestDecodePayloadFromMduZeroLen(t *testing.T) {
	mdu := make([]byte, 8*1024*1024)
	decoded, err := DecodePayloadFromMdu(mdu, 0)
	if err != nil {
		t.Fatalf("DecodePayloadFromMdu failed: %v", err)
	}
	if len(decoded) != 0 {
		t.Fatalf("expected empty payload, got %d bytes", len(decoded))
	}
}

func BenchmarkVerifyMdu0RootTableProof(b *testing.B) {
	path := mustFindTrustedSetup(b)
	if err := Init(path); err != nil {
		b.Fatalf("Init failed: %v", err)
	}

	for _, tc := range []struct {
		name     string
		mduIndex uint64
	}{
		{name: "small_index", mduIndex: 2},
		{name: "high_index", mduIndex: 4097},
	} {
		b.Run(tc.name, func(b *testing.B) {
			targetRoot := deterministicRoot(tc.mduIndex)
			polyfsRoot, mdu0 := buildBenchmarkMdu0(b, tc.mduIndex, targetRoot)
			rootTableDuCommitment, rootTableDuMerkleProof, rootTableOpeningProof, _, err := ComputeMdu0RootTableProof(mdu0, tc.mduIndex, targetRoot)
			if err != nil {
				b.Fatalf("ComputeMdu0RootTableProof failed: %v", err)
			}

			proofBytes := len(rootTableDuCommitment) + len(rootTableDuMerkleProof) + len(rootTableOpeningProof)

			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				ok, err := VerifyMdu0RootTableProof(polyfsRoot, tc.mduIndex, targetRoot, rootTableDuCommitment, rootTableDuMerkleProof, rootTableOpeningProof)
				if err != nil {
					b.Fatalf("VerifyMdu0RootTableProof failed: %v", err)
				}
				if !ok {
					b.Fatal("VerifyMdu0RootTableProof returned false")
				}
			}
			b.ReportMetric(float64(proofBytes), "root_table_proof_B")
			b.ReportMetric(float64(len(rootTableDuMerkleProof)), "root_table_merkle_B")
		})
	}
}

func mustFindTrustedSetup(tb testing.TB) string {
	tb.Helper()
	wd, err := os.Getwd()
	if err != nil {
		tb.Fatalf("Getwd failed: %v", err)
	}
	for _, path := range []string{
		filepath.Join(wd, "..", "..", "trusted_setup.txt"),
		filepath.Join(wd, "..", "..", "..", "demos", "kzg", "trusted_setup.txt"),
	} {
		if _, err := os.Stat(path); err == nil {
			return path
		}
	}
	tb.Skip("trusted setup not found")
	return ""
}

func deterministicRoot(seed uint64) []byte {
	root := make([]byte, 32)
	for i := range root {
		root[i] = byte(seed + uint64(i*17) + 1)
	}
	return root
}

func buildBenchmarkMdu0(tb testing.TB, mduIndex uint64, targetRoot []byte) (polyfsRoot []byte, mdu0 []byte) {
	tb.Helper()
	if mduIndex == 0 {
		tb.Fatal("mduIndex 0 is MDU #0 and is not represented in its root table")
	}
	if len(targetRoot) != 32 {
		tb.Fatalf("target root length = %d, want 32", len(targetRoot))
	}

	rootTableIndex := mduIndex - 1
	du := rootTableIndex / 4096
	cell := rootTableIndex % 4096
	if du >= 16 {
		tb.Fatalf("root-table DU index = %d, want < 16", du)
	}

	roots := make([][]byte, cell+1)
	for i := range roots {
		roots[i] = make([]byte, 32)
	}
	roots[cell] = targetRoot

	_, rootTableBlob, err := ComputeManifestCommitment(roots)
	if err != nil {
		tb.Fatalf("ComputeManifestCommitment failed: %v", err)
	}
	mdu0 = make([]byte, types.MDU_SIZE)
	copy(mdu0[int(du)*types.BLOB_SIZE:], rootTableBlob)

	polyfsRoot, err = ComputeMduMerkleRoot(mdu0)
	if err != nil {
		tb.Fatalf("ComputeMduMerkleRoot failed: %v", err)
	}
	return polyfsRoot, mdu0
}

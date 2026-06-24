package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/types"
)

func buildProofBenchmarkFixture(t testing.TB, userMdus uint64, targetUserOrdinal uint64) (mdu0Path string, mduPath string, mduIndex uint64) {
	t.Helper()

	// Locate trusted setup relative to polystore_gateway directory.
	setupPath := "../polystorechain/trusted_setup.txt"
	if _, err := os.Stat(setupPath); os.IsNotExist(err) {
		t.Skipf("trusted setup not found at %s", setupPath)
	}

	if err := crypto_ffi.Init(setupPath); err != nil {
		t.Fatalf("Init failed: %v", err)
	}

	tmpParent := t.TempDir()

	// Create a sparse slab layout:
	// - mdu_0.bin (valid PolyFS header + root-table DU materialized as KZG blobs)
	// - mdu_1..mdu_W.bin (encoded witness payload, including the target user's commitments)
	// - mdu_N.bin (target user MDU only; intermediate user MDUs are intentionally absent)
	if userMdus == 0 {
		userMdus = 1
	}
	if targetUserOrdinal >= userMdus {
		t.Fatalf("targetUserOrdinal %d >= userMdus %d", targetUserOrdinal, userMdus)
	}
	builder := crypto_ffi.NewMdu0BuilderWithCommitments(userMdus, types.BLOBS_PER_MDU)
	defer builder.Free()

	if err := builder.AppendFile("bench.bin", 1, targetUserOrdinal*RawMduCapacity); err != nil {
		t.Fatal(err)
	}

	targetMdu := make([]byte, types.MDU_SIZE)
	targetWitnessFlat := make([]byte, 0, types.BLOBS_PER_MDU*48)
	for leaf := uint32(0); leaf < types.BLOBS_PER_MDU; leaf++ {
		commitment, _, _, _, _, err := crypto_ffi.ComputeMduProofTest(targetMdu, leaf)
		if err != nil {
			t.Fatalf("ComputeMduProofTest leaf %d failed: %v", leaf, err)
		}
		targetWitnessFlat = append(targetWitnessFlat, commitment...)
	}
	targetRoot, err := crypto_ffi.ComputeMduRootFromWitnessFlat(targetWitnessFlat)
	if err != nil {
		t.Fatal(err)
	}

	witnessCount := builder.GetWitnessCount()
	if err := builder.SetRoot(witnessCount+targetUserOrdinal, targetRoot); err != nil {
		t.Fatal(err)
	}
	mdu0Data, _ := builder.Bytes()
	if err := materializeMdu0RootTable(mdu0Data, map[uint64][]byte{uint64(1) + witnessCount + targetUserOrdinal: targetRoot}); err != nil {
		t.Fatal(err)
	}
	mdu0Root, err := crypto_ffi.ComputeMduMerkleRoot(mdu0Data)
	if err != nil {
		t.Fatal(err)
	}
	dealDir := filepath.Join(tmpParent, hex.EncodeToString(mdu0Root))
	if err := os.MkdirAll(dealDir, 0o755); err != nil {
		t.Fatal(err)
	}

	mdu0Path = filepath.Join(dealDir, "mdu_0.bin")
	if err := os.WriteFile(mdu0Path, mdu0Data, 0o644); err != nil {
		t.Fatal(err)
	}

	targetMduIndex := uint64(1) + witnessCount + targetUserOrdinal

	commitmentSpan := uint64(types.BLOBS_PER_MDU * 48)
	witnessPayload := make([]byte, userMdus*commitmentSpan)
	copy(witnessPayload[targetUserOrdinal*commitmentSpan:], targetWitnessFlat)
	for i := uint64(0); i < witnessCount; i++ {
		start := i * RawMduCapacity
		end := start + RawMduCapacity
		if end > uint64(len(witnessPayload)) {
			end = uint64(len(witnessPayload))
		}
		var chunk []byte
		if start < uint64(len(witnessPayload)) {
			chunk = witnessPayload[start:end]
		}
		encodedWitness, err := crypto_ffi.EncodePayloadToMdu(chunk)
		if err != nil {
			t.Fatalf("EncodePayloadToMdu witness %d failed: %v", i, err)
		}
		witnessPath := filepath.Join(dealDir, "mdu_"+strconv.FormatUint(1+i, 10)+".bin")
		if err := os.WriteFile(witnessPath, encodedWitness, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	mduPath = filepath.Join(dealDir, "mdu_"+strconv.FormatUint(targetMduIndex, 10)+".bin")
	if err := os.WriteFile(mduPath, targetMdu, 0o644); err != nil {
		t.Fatal(err)
	}

	totalMdus := uint64(1) + witnessCount + userMdus
	meta, err := newSlabMetadataDocument(slabMetadataBuildOptions{
		GenerationID: hex.EncodeToString(mdu0Root),
		ManifestRoot: "0x" + hex.EncodeToString(mdu0Root),
		Source:       "proof_benchmark_fixture",
		WitnessMdus:  &witnessCount,
		UserMdus:     &userMdus,
		TotalMdus:    &totalMdus,
		FileRecords:  slabMetadataFileRecordsFromBuilder(builder),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := writeSlabMetadataFile(dealDir, meta); err != nil {
		t.Fatal(err)
	}

	return mdu0Path, mduPath, targetMduIndex
}

func TestProofHeaderJSONHighIndexNoManifestBinVerifies(t *testing.T) {
	mdu0Path, mduPath, mduIndex := buildProofBenchmarkFixture(t, 4096, 4095)
	if mduIndex <= 4095 {
		t.Fatalf("expected high-index target, got mdu index %d", mduIndex)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(mdu0Path), "manifest.bin")); !os.IsNotExist(err) {
		t.Fatalf("proof fixture must not depend on canonical manifest.bin, stat err=%v", err)
	}

	payload, _, err := generateProofHeaderJSON(context.Background(), 1, 1, mduIndex, mduPath, mdu0Path, 0, 0, types.BLOBS_PER_MDU, 0)
	if err != nil {
		t.Fatalf("generateProofHeaderJSON failed: %v", err)
	}
	var decoded struct {
		ProofDetails types.ChainedProof `json:"proof_details"`
	}
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("unmarshal proof payload: %v", err)
	}

	mdu0Bytes, err := os.ReadFile(mdu0Path)
	if err != nil {
		t.Fatalf("read MDU #0: %v", err)
	}
	polyfsRoot, err := crypto_ffi.ComputeMduMerkleRoot(mdu0Bytes)
	if err != nil {
		t.Fatalf("ComputeMduMerkleRoot failed: %v", err)
	}
	requirePolyFSProofVerifies(t, polyfsRoot, &decoded.ProofDetails, types.BLOBS_PER_MDU)
}

func TestProofHeaderJSONRejectsStaleMdu0RootTable(t *testing.T) {
	mdu0Path, mduPath, mduIndex := buildProofBenchmarkFixture(t, 1, 0)

	mdu0Bytes, err := os.ReadFile(mdu0Path)
	if err != nil {
		t.Fatalf("read MDU #0: %v", err)
	}
	rootTableDu := (mduIndex - 1) / 4096
	rootTableCell := (mduIndex - 1) % 4096
	corruptOffset := rootTableDu*types.BLOB_SIZE + rootTableCell*32
	if corruptOffset >= uint64(len(mdu0Bytes)) {
		t.Fatalf("corrupt offset %d out of MDU #0 bounds", corruptOffset)
	}
	mdu0Bytes[corruptOffset] ^= 0xff
	if err := os.WriteFile(mdu0Path, mdu0Bytes, 0o644); err != nil {
		t.Fatalf("write corrupted MDU #0: %v", err)
	}

	_, _, err = generateProofHeaderJSON(context.Background(), 1, 1, mduIndex, mduPath, mdu0Path, 0, 0, types.BLOBS_PER_MDU, 0)
	if err == nil {
		t.Fatalf("expected stale MDU #0 root table to be rejected")
	}
	if !strings.Contains(err.Error(), "ComputeMdu0RootTableProof") {
		t.Fatalf("expected MDU #0 proof error, got %v", err)
	}
}

func BenchmarkProofHeaderJSONSmallIndex(b *testing.B) {
	mdu0Path, mduPath, mduIndex := buildProofBenchmarkFixture(b, 1, 0)

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _, err := generateProofHeaderJSON(context.Background(), 1, 1, mduIndex, mduPath, mdu0Path, 0, 0, types.BLOBS_PER_MDU, 0)
		if err != nil {
			b.Fatalf("generateProofHeaderJSON failed: %v", err)
		}
	}
}

func BenchmarkProofHeaderJSONHighIndex(b *testing.B) {
	mdu0Path, mduPath, mduIndex := buildProofBenchmarkFixture(b, 4096, 4095)

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _, err := generateProofHeaderJSON(context.Background(), 1, 1, mduIndex, mduPath, mdu0Path, 0, 0, types.BLOBS_PER_MDU, 0)
		if err != nil {
			b.Fatalf("generateProofHeaderJSON failed: %v", err)
		}
	}
}

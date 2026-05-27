package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/types"
)

func TestSystemLivenessKzgChallengeIsProofable(t *testing.T) {
	if err := crypto_ffi.Init(trustedSetup); err != nil {
		t.Fatalf("crypto_ffi.Init failed: %v", err)
	}

	var seed [32]byte
	z := deriveKzgZ(seed, 1, 2, 0)
	if _, _, err := crypto_ffi.ComputeBlobProof(make([]byte, types.BLOB_SIZE), z); err != nil {
		t.Fatalf("system liveness KZG challenge must be a proofable scalar: %v", err)
	}
}

func TestSystemLivenessGeneratesProofFromMode2SlotShard(t *testing.T) {
	useTempUploadDir(t)
	if err := crypto_ffi.Init(trustedSetup); err != nil {
		t.Fatalf("crypto_ffi.Init failed: %v", err)
	}

	payloadPath := filepath.Join(t.TempDir(), "payload.txt")
	if err := os.WriteFile(payloadPath, []byte("mode2 system liveness proof fixture"), 0o644); err != nil {
		t.Fatalf("write payload: %v", err)
	}

	const dealID = uint64(1)
	const serviceHint = "General:rs=8+4"
	result, _, err := mode2BuildArtifacts(context.Background(), payloadPath, dealID, serviceHint, "payload.txt", 0)
	if err != nil {
		t.Fatalf("mode2BuildArtifacts failed: %v", err)
	}

	stripe, err := stripeParamsFromHint(serviceHint)
	if err != nil {
		t.Fatalf("stripeParamsFromHint failed: %v", err)
	}
	mduIndex := uint64(1) + result.witnessMdus
	blobIndex := uint32(0) // slot 0, row 0 in Mode 2 slot-major witness layout.
	dealDir := dealScopedDir(dealID, result.manifestRoot)
	manifestPath := filepath.Join(dealDir, "manifest.bin")

	var seed [32]byte
	proof, err := generateSystemChainedProof(context.Background(), seed, dealID, dealDir, manifestPath, stripe, mduIndex, blobIndex)
	if err != nil {
		t.Fatalf("generateSystemChainedProof failed: %v", err)
	}

	flatMerklePath := make([]byte, 0, len(proof.MerklePath)*32)
	for _, node := range proof.MerklePath {
		flatMerklePath = append(flatMerklePath, node...)
	}
	ok, err := crypto_ffi.VerifyChainedProof(
		result.manifestRoot.Bytes[:],
		proof.MduIndex,
		proof.ManifestOpening,
		proof.MduRootFr,
		proof.BlobCommitment,
		uint64(proof.BlobIndex),
		stripe.leafCount,
		flatMerklePath,
		proof.ZValue,
		proof.YValue,
		proof.KzgOpeningProof,
	)
	if err != nil {
		t.Fatalf("VerifyChainedProof failed: %v", err)
	}
	if !ok {
		t.Fatalf("generated system liveness proof did not verify")
	}
}

func TestSystemLivenessPendingRepairRequiresLocalShardReadiness(t *testing.T) {
	slot := mode2SlotAssignment{
		Provider:        "nil1assigned",
		PendingProvider: "nil1pending",
		Status:          1,
	}
	if got := classifySystemLivenessLocalRole("nil1assigned", slot); got != systemLivenessRoleAssigned {
		t.Fatalf("assigned provider role mismatch: got %d", got)
	}
	if got := classifySystemLivenessLocalRole("nil1pending", slot); got != systemLivenessRolePendingRepair {
		t.Fatalf("pending provider role mismatch: got %d", got)
	}

	dealDir := t.TempDir()
	if mode2ShardBlobReadyForSystemProof(dealDir, 2, 0, 0) {
		t.Fatalf("pending repair shard must not be ready before local catch-up data exists")
	}
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_2_slot_1.bin"), make([]byte, types.BLOB_SIZE), 0o644); err != nil {
		t.Fatalf("write wrong slot shard: %v", err)
	}
	if mode2ShardBlobReadyForSystemProof(dealDir, 2, 0, 0) {
		t.Fatalf("pending repair shard readiness must be slot-specific")
	}
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_2_slot_0.bin"), make([]byte, types.BLOB_SIZE), 0o644); err != nil {
		t.Fatalf("write pending slot shard: %v", err)
	}
	if !mode2ShardBlobReadyForSystemProof(dealDir, 2, 0, 0) {
		t.Fatalf("pending repair shard should be ready after the target slot blob exists")
	}
	if mode2ShardBlobReadyForSystemProof(dealDir, 2, 0, 1) {
		t.Fatalf("pending repair shard row readiness must require the challenged row")
	}
}

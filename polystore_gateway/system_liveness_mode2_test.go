package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strconv"
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
	mdu0Path := filepath.Join(dealDir, "mdu_0.bin")

	var seed [32]byte
	proof, err := generateSystemChainedProof(context.Background(), seed, dealID, dealDir, mdu0Path, stripe, mduIndex, blobIndex)
	if err != nil {
		t.Fatalf("generateSystemChainedProof failed: %v", err)
	}

	requirePolyFSProofVerifies(t, result.manifestRoot.Bytes[:], proof, stripe.leafCount)
}

func TestSystemLivenessGeneratesProofForEveryMode2Slot(t *testing.T) {
	useTempUploadDir(t)
	if err := crypto_ffi.Init(trustedSetup); err != nil {
		t.Fatalf("crypto_ffi.Init failed: %v", err)
	}

	payloadPath := filepath.Join(t.TempDir(), "payload.bin")
	payload := bytes.Repeat([]byte("mode2 slot-major proof fixture"), 16<<10)
	if err := os.WriteFile(payloadPath, payload, 0o644); err != nil {
		t.Fatalf("write payload: %v", err)
	}

	const dealID = uint64(1)
	const serviceHint = "General:rs=2+1"
	result, _, err := mode2BuildArtifacts(context.Background(), payloadPath, dealID, serviceHint, "payload.bin", 0)
	if err != nil {
		t.Fatalf("mode2BuildArtifacts failed: %v", err)
	}

	stripe, err := stripeParamsFromHint(serviceHint)
	if err != nil {
		t.Fatalf("stripeParamsFromHint failed: %v", err)
	}
	mduIndex := uint64(1) + result.witnessMdus
	dealDir := dealScopedDir(dealID, result.manifestRoot)
	mdu0Path := filepath.Join(dealDir, "mdu_0.bin")

	var seed [32]byte
	for slot := uint64(0); slot < stripe.slotCount; slot++ {
		blobIndex := uint32(slot * stripe.rows)
		proof, err := generateSystemChainedProof(context.Background(), seed, dealID, dealDir, mdu0Path, stripe, mduIndex, blobIndex)
		if err != nil {
			t.Fatalf("generateSystemChainedProof slot %d failed: %v", slot, err)
		}

		requirePolyFSProofVerifies(t, result.manifestRoot.Bytes[:], proof, stripe.leafCount)
	}
}

func TestSystemLivenessGeneratesProofAfterMode2Append(t *testing.T) {
	useTempUploadDir(t)
	if err := crypto_ffi.Init(trustedSetup); err != nil {
		t.Fatalf("crypto_ffi.Init failed: %v", err)
	}

	dir := t.TempDir()
	firstPath := filepath.Join(dir, "first.bin")
	secondPath := filepath.Join(dir, "second.bin")
	if err := os.WriteFile(firstPath, bytes.Repeat([]byte("first append proof fixture"), 16<<10), 0o644); err != nil {
		t.Fatalf("write first payload: %v", err)
	}
	if err := os.WriteFile(secondPath, bytes.Repeat([]byte("second append proof fixture"), 16<<10), 0o644); err != nil {
		t.Fatalf("write second payload: %v", err)
	}

	const dealID = uint64(1)
	const serviceHint = "General:rs=2+1"
	initial, _, err := mode2BuildArtifacts(context.Background(), firstPath, dealID, serviceHint, "first.bin", 0)
	if err != nil {
		t.Fatalf("mode2BuildArtifacts failed: %v", err)
	}
	appended, finalDir, err := mode2BuildArtifactsAppend(context.Background(), secondPath, dealID, serviceHint, initial.manifestRoot.Canonical, "second.bin", 0)
	if err != nil {
		t.Fatalf("mode2BuildArtifactsAppend failed: %v", err)
	}

	stripe, err := stripeParamsFromHint(serviceHint)
	if err != nil {
		t.Fatalf("stripeParamsFromHint failed: %v", err)
	}
	mdu0Path := filepath.Join(finalDir, "mdu_0.bin")

	var seed [32]byte
	for userOrdinal := uint64(0); userOrdinal < appended.userMdus; userOrdinal++ {
		mduIndex := uint64(1) + appended.witnessMdus + userOrdinal
		for slot := uint64(0); slot < stripe.slotCount; slot++ {
			blobIndex := uint32(slot * stripe.rows)
			proof, err := generateSystemChainedProof(context.Background(), seed, dealID, finalDir, mdu0Path, stripe, mduIndex, blobIndex)
			if err != nil {
				t.Fatalf("generateSystemChainedProof user_mdu=%d slot=%d failed: %v", userOrdinal, slot, err)
			}

			requirePolyFSProofVerifies(t, appended.manifestRoot.Bytes[:], proof, stripe.leafCount)
		}
	}
}

func TestSystemLivenessLiveArtifactProofs(t *testing.T) {
	dealDir := os.Getenv("POLYSTORE_TEST_LIVE_DEAL_DIR")
	if dealDir == "" {
		t.Skip("set POLYSTORE_TEST_LIVE_DEAL_DIR to verify a live provider artifact directory")
	}
	if err := crypto_ffi.Init(trustedSetup); err != nil {
		t.Fatalf("crypto_ffi.Init failed: %v", err)
	}

	manifestRoot, err := parseManifestRoot("0x" + filepath.Base(dealDir))
	if err != nil {
		t.Fatalf("parse manifest root from deal dir: %v", err)
	}
	stripe, err := stripeParamsFromHint(envDefault("POLYSTORE_TEST_LIVE_SERVICE_HINT", "General:rs=2+1"))
	if err != nil {
		t.Fatalf("stripeParamsFromHint failed: %v", err)
	}
	dealID := uint64(0)
	mdu0Path := filepath.Join(dealDir, "mdu_0.bin")

	var seed [32]byte
	for slot := uint64(0); slot < stripe.slotCount; slot++ {
		shardPath := filepath.Join(dealDir, "mdu_2_slot_"+strconv.FormatUint(slot, 10)+".bin")
		if _, err := os.Stat(shardPath); err != nil {
			continue
		}
		blobIndex := uint32(slot * stripe.rows)
		proof, err := generateSystemChainedProof(context.Background(), seed, dealID, dealDir, mdu0Path, stripe, 2, blobIndex)
		if err != nil {
			t.Fatalf("generateSystemChainedProof slot %d failed: %v", slot, err)
		}

		requirePolyFSProofVerifies(t, manifestRoot.Bytes[:], proof, stripe.leafCount)
	}
}

func requirePolyFSProofVerifies(t *testing.T, polyfsRoot []byte, proof *types.ChainedProof, leafCount uint64) {
	t.Helper()

	rootTablePath, err := flattenMerkleProof32(proof.RootTableDuMerklePath)
	if err != nil {
		t.Fatalf("flatten root-table proof: %v", err)
	}
	ok, err := crypto_ffi.VerifyMdu0RootTableProof(
		polyfsRoot,
		proof.MduIndex,
		proof.MduRootFr,
		proof.RootTableDuCommitment,
		rootTablePath,
		proof.ManifestOpening,
	)
	if err != nil {
		t.Fatalf("VerifyMdu0RootTableProof failed: %v", err)
	}
	if !ok {
		t.Fatalf("MDU #0 root-table proof did not verify")
	}

	blobPath, err := flattenMerkleProof32(proof.MerklePath)
	if err != nil {
		t.Fatalf("flatten blob Merkle proof: %v", err)
	}
	ok, err = crypto_ffi.VerifyMduProof(
		proof.MduRootFr,
		proof.BlobCommitment,
		blobPath,
		proof.BlobIndex,
		leafCount,
		proof.ZValue,
		proof.YValue,
		proof.KzgOpeningProof,
	)
	if err != nil {
		t.Fatalf("VerifyMduProof failed: %v", err)
	}
	if !ok {
		t.Fatalf("target MDU blob proof did not verify")
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

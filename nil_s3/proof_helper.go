package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"

	"nilchain/x/crypto_ffi"
	"nilchain/x/nilchain/types"
)

// submitRetrievalProofNew submits a retrieval proof for a specific MDU.
// mduIndex is the index in the Deal Slab (0=Manifest, 1..W=Witness, W+1..=Data).
// mduPath must point to the encoded 8 MiB MDU bytes stored on disk.
func submitRetrievalProofNew(ctx context.Context, dealID uint64, epoch uint64, mduIndex uint64, mduPath string, manifestPath string) (string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if abs, err := filepath.Abs(mduPath); err == nil {
		mduPath = abs
	}
	if abs, err := filepath.Abs(manifestPath); err == nil {
		manifestPath = abs
	}
	providerKeyName := envDefault("NIL_PROVIDER_KEY", "faucet")
	providerAddr, err := resolveKeyAddress(ctx, providerKeyName)
	if err != nil {
		return "", fmt.Errorf("resolveKeyAddress failed: %w", err)
	}

	dealIDStr := strconv.FormatUint(dealID, 10)
	if epoch == 0 {
		epoch = 1
	}
	epochStr := strconv.FormatUint(epoch, 10)
	mduIndexStr := strconv.FormatUint(mduIndex, 10)

	// 1. Compute KZG commitments/roots for the already-encoded MDU.
	prefix := mduPath + ".proof"
	_, err = shardFile(ctx, mduPath, true, prefix)
	if err != nil {
		return "", fmt.Errorf("failed to encode MDU for proof: %w", err)
	}
	encodedMduPath := fmt.Sprintf("%s.mdu.0.bin", prefix)
	defer os.Remove(encodedMduPath)
	defer os.Remove(prefix + ".json")

	// 2. Encode Manifest (MDU #0)
	// manifestPath points to "manifest.bin", which is the Encoded Manifest Blob.
	// So we don't need to encode or extract it. It IS the blob.

	manifestBlobPath := manifestPath

	// 4. Sign Receipt
	signCtx, cancel := context.WithTimeout(ctx, cmdTimeout)
	defer cancel()
	signCmd := execNilchaind(
		signCtx,
		"tx", "nilchain", "sign-retrieval-receipt",
		dealIDStr,
		providerAddr,
		epochStr,
		encodedMduPath,
		trustedSetup,
		manifestBlobPath, // Pass the specific 128KB Blob
		mduIndexStr,
		"--from", providerKeyName,
		"--home", homeDir,
		"--keyring-backend", "test",
		"--offline",
	)

	signOut, err := signCmd.Output()
	if errors.Is(signCtx.Err(), context.DeadlineExceeded) {
		return "", fmt.Errorf("sign-retrieval-receipt timed out after %s", cmdTimeout)
	}
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			return "", fmt.Errorf("sign-retrieval-receipt failed: %w (stderr: %s)", err, string(ee.Stderr))
		}
		return "", fmt.Errorf("sign-retrieval-receipt failed: %w", err)
	}

	tmpFile, err := os.CreateTemp(uploadDir, "receipt-*.json")
	if err != nil {
		return "", fmt.Errorf("CreateTemp failed: %w", err)
	}
	tmpPath := tmpFile.Name()
	if _, err := tmpFile.Write(signOut); err != nil {
		tmpFile.Close()
		os.Remove(tmpPath)
		return "", fmt.Errorf("writing receipt file failed: %w", err)
	}
	if err := tmpFile.Close(); err != nil {
		os.Remove(tmpPath)
		return "", fmt.Errorf("closing receipt file failed: %w", err)
	}
	defer os.Remove(tmpPath)

	// 5. Submit Proof
	submitOut, err := runTxWithRetry(
		ctx,
		"tx", "nilchain", "submit-retrieval-proof",
		tmpPath,
		"--from", providerKeyName,
		"--chain-id", chainID,
		"--home", homeDir,
		"--keyring-backend", "test",
		"--yes",
		"--gas-prices", gasPrices,
	)
	outStr := string(submitOut)
	if err != nil {
		return "", fmt.Errorf("submit-retrieval-proof failed: %w (%s)", err, outStr)
	}

	return extractTxHash(outStr), nil
}

// generateProofJSON generates the RetrievalReceipt JSON (with proof details) using in-process crypto.
func generateProofJSON(ctx context.Context, dealID uint64, epoch uint64, mduIndex uint64, mduPath string, manifestPath string) ([]byte, error) {
	if abs, err := filepath.Abs(mduPath); err == nil {
		mduPath = abs
	}
	mduBytes, err := os.ReadFile(mduPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read MDU: %w", err)
	}
	if len(mduBytes) != 8388608 {
		return nil, fmt.Errorf("invalid MDU size: %d", len(mduBytes))
	}

	if abs, err := filepath.Abs(manifestPath); err == nil {
		manifestPath = abs
	}
	manifestBlob, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read manifest: %w", err)
	}
	if len(manifestBlob) != 131072 {
		return nil, fmt.Errorf("invalid Manifest size: %d", len(manifestBlob))
	}

	// 3. Compute MDU Root
	root, err := crypto_ffi.ComputeMduMerkleRoot(mduBytes)
	if err != nil {
		return nil, err
	}

	// 4. Compute MDU Proof (Chunk 0)
	chunkIndex := uint32(0)
	commitment, merkleProof, z, y, kzgProofBytes, err := crypto_ffi.ComputeMduProofTest(mduBytes, chunkIndex)
	if err != nil {
		return nil, err
	}

	// Unflatten Merkle Proof
	merklePath := make([][]byte, 0)
	for i := 0; i < len(merkleProof); i += 32 {
		merklePath = append(merklePath, merkleProof[i:i+32])
	}

	// 5. Compute Manifest Proof
	manifestProof, _, err := crypto_ffi.ComputeManifestProof(manifestBlob, mduIndex)
	if err != nil {
		return nil, err
	}

	// 6. Construct ChainedProof
	chainedProof := types.ChainedProof{
		MduIndex:        mduIndex,
		MduRootFr:       root,
		ManifestOpening: manifestProof,
		BlobCommitment:  commitment,
		MerklePath:      merklePath,
		BlobIndex:       chunkIndex,
		ZValue:          z,
		YValue:          y,
		KzgOpeningProof: kzgProofBytes,
	}

	proofBytes, err := json.Marshal(chainedProof)
	if err != nil {
		return nil, err
	}

	receipt := RetrievalReceipt{
		DealId:       dealID,
		EpochId:      epoch,
		BytesServed:  uint64(len(mduBytes)),
		ProofDetails: json.RawMessage(proofBytes),
		Nonce:        uint64(time.Now().UnixNano()),
	}

	return json.Marshal(receipt)
}

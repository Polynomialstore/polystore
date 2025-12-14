package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"nilchain/x/crypto_ffi"
	"nilchain/x/nilchain/types"

	"golang.org/x/crypto/blake2s"
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

type proofCacheKey struct {
	dealID        uint64
	mduIndex      uint64
	mduPath       string
	manifestPath  string
	blobIndex     uint32
	manifestEpoch uint64
}

type cachedProof struct {
	mduModTime      int64
	manifestModTime int64
	payload         []byte
}

var proofHeaderCache sync.Map // map[proofCacheKey]*cachedProof

// generateProofHeaderJSON generates the JSON payload expected by the browser header
// `X-Nil-Proof-JSON`. The payload is a small wrapper object:
//
//	{ "proof_details": <ChainedProof> }
//
// This function is performance critical and caches results keyed by (mduIndex,mduPath,manifestPath,blobIndex,epoch).
func generateProofHeaderJSON(ctx context.Context, dealID uint64, epoch uint64, mduIndex uint64, mduPath string, manifestPath string) ([]byte, error) {
	if abs, err := filepath.Abs(mduPath); err == nil {
		mduPath = abs
	}
	if abs, err := filepath.Abs(manifestPath); err == nil {
		manifestPath = abs
	}
	if epoch == 0 {
		epoch = 1
	}

	mduStat, err := os.Stat(mduPath)
	if err != nil {
		return nil, fmt.Errorf("failed to stat MDU: %w", err)
	}
	manifestStat, err := os.Stat(manifestPath)
	if err != nil {
		return nil, fmt.Errorf("failed to stat manifest: %w", err)
	}

	key := proofCacheKey{
		dealID:        dealID,
		mduIndex:      mduIndex,
		mduPath:       mduPath,
		manifestPath:  manifestPath,
		blobIndex:     0,
		manifestEpoch: epoch,
	}

	if cachedAny, ok := proofHeaderCache.Load(key); ok {
		cached := cachedAny.(*cachedProof)
		if cached.mduModTime == mduStat.ModTime().UnixNano() && cached.manifestModTime == manifestStat.ModTime().UnixNano() {
			return cached.payload, nil
		}
	}

	manifestBlob, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read manifest: %w", err)
	}
	if len(manifestBlob) != types.BLOB_SIZE {
		return nil, fmt.Errorf("invalid Manifest size: %d", len(manifestBlob))
	}

	dealDir := filepath.Dir(mduPath)
	meta, err := loadSlabIndex(dealDir)
	if err != nil {
		return nil, fmt.Errorf("failed to load slab index: %w", err)
	}

	// Derive the user-MDU ordinal from the physical slab index.
	// Layout: mdu_0 (manifest), mdu_1..mdu_W (witness), mdu_(W+1).. (user).
	if mduIndex <= meta.witnessCount {
		return nil, fmt.Errorf("invalid mdu index %d for user data (witness=%d)", mduIndex, meta.witnessCount)
	}
	if mduIndex < 1+meta.witnessCount {
		return nil, fmt.Errorf("invalid slab layout for mdu index %d (witness=%d)", mduIndex, meta.witnessCount)
	}
	userOrdinal := mduIndex - (1 + meta.witnessCount)

	// Hop 2: derive blob commitments from Witness MDUs (fast; avoids recomputing KZG commitments).
	const commitmentBytes = 48
	commitmentSpan := uint64(types.BLOBS_PER_MDU * commitmentBytes)
	startOffset := userOrdinal * commitmentSpan

	witnessReader, err := newNilfsDecodedReader(dealDir, 1, startOffset, commitmentSpan)
	if err != nil {
		return nil, fmt.Errorf("failed to open witness reader: %w", err)
	}
	witnessRaw, err := io.ReadAll(witnessReader)
	_ = witnessReader.Close()
	if err != nil {
		return nil, fmt.Errorf("failed to read witness commitments: %w", err)
	}
	if uint64(len(witnessRaw)) != commitmentSpan {
		return nil, fmt.Errorf("invalid witness commitments length: got %d want %d", len(witnessRaw), commitmentSpan)
	}

	blobIndex := uint32(0)
	blobCommitment := witnessRaw[:commitmentBytes]

	leafHashes := make([][32]byte, 0, types.BLOBS_PER_MDU)
	for i := 0; i < len(witnessRaw); i += commitmentBytes {
		sum := blake2s.Sum256(witnessRaw[i : i+commitmentBytes])
		leafHashes = append(leafHashes, sum)
	}
	root, merklePath := merkleRootAndPath(leafHashes, int(blobIndex))

	// Hop 3: compute a single blob opening proof without recomputing commitments.
	blobBytes, err := readMduBlob(mduPath, uint64(blobIndex))
	if err != nil {
		return nil, fmt.Errorf("failed to read blob bytes: %w", err)
	}
	z := make([]byte, 32)
	z[0] = 42
	z[1] = byte(blobIndex)
	kzgProofBytes, y, err := crypto_ffi.ComputeBlobProof(blobBytes, z)
	if err != nil {
		return nil, fmt.Errorf("ComputeBlobProof failed: %w", err)
	}

	manifestProof, _, err := crypto_ffi.ComputeManifestProof(manifestBlob, mduIndex)
	if err != nil {
		return nil, err
	}

	chainedProof := types.ChainedProof{
		MduIndex:        mduIndex,
		MduRootFr:       root,
		ManifestOpening: manifestProof,
		BlobCommitment:  blobCommitment,
		MerklePath:      merklePath,
		BlobIndex:       blobIndex,
		ZValue:          z,
		YValue:          y,
		KzgOpeningProof: kzgProofBytes,
	}

	proofBytes, err := json.Marshal(chainedProof)
	if err != nil {
		return nil, err
	}

	headerPayload, err := json.Marshal(struct {
		DealId      uint64          `json:"deal_id"`
		EpochId     uint64          `json:"epoch_id"`
		ProofDetail json.RawMessage `json:"proof_details"`
		Nonce       uint64          `json:"nonce"`
	}{
		DealId:      dealID,
		EpochId:     epoch,
		ProofDetail: json.RawMessage(proofBytes),
		Nonce:       uint64(time.Now().UnixNano()),
	})
	if err != nil {
		return nil, err
	}

	proofHeaderCache.Store(key, &cachedProof{
		mduModTime:      mduStat.ModTime().UnixNano(),
		manifestModTime: manifestStat.ModTime().UnixNano(),
		payload:         headerPayload,
	})

	return headerPayload, nil
}

func readMduBlob(mduPath string, blobIndex uint64) ([]byte, error) {
	if blobIndex >= types.BLOBS_PER_MDU {
		return nil, fmt.Errorf("blobIndex out of range: %d", blobIndex)
	}
	f, err := os.Open(mduPath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	offset := int64(blobIndex) * int64(types.BLOB_SIZE)
	buf := make([]byte, types.BLOB_SIZE)
	n, err := f.ReadAt(buf, offset)
	if err != nil && n != len(buf) {
		return nil, err
	}
	return buf, nil
}

func merkleRootAndPath(leaves [][32]byte, leafIndex int) ([]byte, [][]byte) {
	if len(leaves) == 0 {
		return make([]byte, 32), nil
	}
	if leafIndex < 0 || leafIndex >= len(leaves) {
		return make([]byte, 32), nil
	}

	level := make([][32]byte, len(leaves))
	copy(level, leaves)
	idx := leafIndex
	path := make([][]byte, 0, 10)

	for len(level) > 1 {
		sibling := idx ^ 1
		if sibling >= 0 && sibling < len(level) {
			h := make([]byte, 32)
			copy(h, level[sibling][:])
			path = append(path, h)
		}

		next := make([][32]byte, 0, (len(level)+1)/2)
		for i := 0; i < len(level); i += 2 {
			left := level[i]
			right := left
			if i+1 < len(level) {
				right = level[i+1]
			}
			var pair [64]byte
			copy(pair[:32], left[:])
			copy(pair[32:], right[:])
			next = append(next, blake2s.Sum256(pair[:]))
		}
		level = next
		idx /= 2
	}

	root := make([]byte, 32)
	copy(root, level[0][:])
	return root, path
}

package main

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/types"

	"golang.org/x/crypto/blake2s"
)

// submitRetrievalProofNew submits a retrieval proof for a specific MDU.
// mduIndex is the index in the Deal Slab (0=MDU #0, 1..W=Witness, W+1..=Data).
// mduPath must point to the encoded 8 MiB MDU bytes stored on disk.
//
// providerKeyName is the local keyring name used to submit the proof (MsgSubmitRetrievalProof).
func submitRetrievalProofNew(ctx context.Context, dealID uint64, epoch uint64, mduIndex uint64, mduPath string, mdu0Path string, providerKeyName string, ownerAddr string) (string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if abs, err := filepath.Abs(mduPath); err == nil {
		mduPath = abs
	}
	if abs, err := filepath.Abs(mdu0Path); err == nil {
		mdu0Path = abs
	}
	if strings.TrimSpace(providerKeyName) == "" {
		providerKeyName = envDefault("POLYSTORE_PROVIDER_KEY", "faucet")
	}
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

	// 4. Sign Receipt (Must be signed by Deal Owner)
	signCtx, cancel := context.WithTimeout(ctx, cmdTimeout)
	defer cancel()

	// Use provided ownerAddr if available, otherwise fallback to provider (legacy behavior)
	signer := ownerAddr
	if signer == "" {
		signer = providerKeyName
	} else {
		// e2e passes a bech32 address; polystorechaind expects a local key name for --from.
		name, err := resolveKeyNameForAddress(ctx, signer)
		if err != nil {
			return "", fmt.Errorf("resolveKeyNameForAddress failed: %w", err)
		}
		signer = name
	}

	signOut, err := execPolystorechaind(
		signCtx,
		"tx", "polystorechain", "sign-retrieval-receipt",
		dealIDStr,
		providerAddr,
		epochStr,
		encodedMduPath,
		trustedSetup,
		mdu0Path,
		mduIndexStr,
		"--from", signer,
		"--home", homeDir,
		"--keyring-backend", "test",
		"--offline",
	)

	if errors.Is(signCtx.Err(), context.DeadlineExceeded) {
		return "", fmt.Errorf("sign-retrieval-receipt timed out after %s", cmdTimeout)
	}
	if err != nil {
		return "", fmt.Errorf("sign-retrieval-receipt failed: %w (output: %s)", err, string(signOut))
	}

	cleanSignOut := extractJSONBody(signOut)
	if len(cleanSignOut) == 0 {
		// Fallback if extraction failed (maybe no logs?) or empty
		cleanSignOut = signOut
	}

	tmpFile, err := os.CreateTemp(uploadDir, "receipt-*.json")
	if err != nil {
		return "", fmt.Errorf("CreateTemp failed: %w", err)
	}
	tmpPath := tmpFile.Name()
	if _, err := tmpFile.Write(cleanSignOut); err != nil {
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
		"tx", "polystorechain", "submit-retrieval-proof",
		tmpPath,
		"--from", providerKeyName,
		"--chain-id", chainID,
		"--home", homeDir,
		"--keyring-backend", "test",
		"--yes",
		"--gas", "auto",
		"--gas-adjustment", "1.6",
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
	mdu0Path      string
	encodedBlob   uint32
	leafIndex     uint64
	leafCount     uint64
	manifestEpoch uint64
}

type cachedProof struct {
	mduModTime   int64
	mdu0ModTime  int64
	payload      []byte
	proofHashHex string
}

var proofHeaderCache sync.Map // map[proofCacheKey]*cachedProof

// generateProofHeaderJSON generates the JSON payload expected by the browser header
// `X-PolyStore-Proof-JSON`. The payload is a small wrapper object:
//
//	{ "proof_details": <ChainedProof> }
//
// This function is performance critical and caches results keyed by (mduIndex,mduPath,mdu0Path,blobIndex,epoch).
func generateProofHeaderJSON(ctx context.Context, dealID uint64, epoch uint64, mduIndex uint64, mduPath string, mdu0Path string, encodedBlobIndex uint32, leafIndex uint64, leafCount uint64, zHint uint64) ([]byte, string, error) {
	if abs, err := filepath.Abs(mduPath); err == nil {
		mduPath = abs
	}
	if abs, err := filepath.Abs(mdu0Path); err == nil {
		mdu0Path = abs
	}
	if epoch == 0 {
		epoch = 1
	}

	mduStat, err := os.Stat(mduPath)
	if err != nil {
		return nil, "", fmt.Errorf("failed to stat MDU: %w", err)
	}
	mdu0Stat, err := os.Stat(mdu0Path)
	if err != nil {
		return nil, "", fmt.Errorf("failed to stat MDU #0: %w", err)
	}

	key := proofCacheKey{
		dealID:        dealID,
		mduIndex:      mduIndex,
		mduPath:       mduPath,
		mdu0Path:      mdu0Path,
		encodedBlob:   encodedBlobIndex,
		leafIndex:     leafIndex,
		leafCount:     leafCount,
		manifestEpoch: epoch,
	}

	if cachedAny, ok := proofHeaderCache.Load(key); ok {
		cached := cachedAny.(*cachedProof)
		if cached.mduModTime == mduStat.ModTime().UnixNano() && cached.mdu0ModTime == mdu0Stat.ModTime().UnixNano() {
			return cached.payload, cached.proofHashHex, nil
		}
	}

	mdu0Bytes, err := os.ReadFile(mdu0Path)
	if err != nil {
		return nil, "", fmt.Errorf("failed to read MDU #0: %w", err)
	}
	if len(mdu0Bytes) != types.MDU_SIZE {
		return nil, "", fmt.Errorf("invalid MDU #0 size: %d", len(mdu0Bytes))
	}

	dealDir := filepath.Dir(mduPath)
	meta, err := loadSlabIndex(dealDir)
	if err != nil {
		return nil, "", fmt.Errorf("failed to load slab index: %w", err)
	}

	// Derive the user-MDU ordinal from the physical slab index.
	// Layout: mdu_0 (manifest), mdu_1..mdu_W (witness), mdu_(W+1).. (user).
	if mduIndex <= meta.witnessCount {
		return nil, "", fmt.Errorf("invalid mdu index %d for user data (witness=%d)", mduIndex, meta.witnessCount)
	}
	if mduIndex < 1+meta.witnessCount {
		return nil, "", fmt.Errorf("invalid slab layout for mdu index %d (witness=%d)", mduIndex, meta.witnessCount)
	}
	userOrdinal := mduIndex - (1 + meta.witnessCount)

	// Hop 2: derive blob commitments from Witness MDUs (fast; avoids recomputing KZG commitments).
	const commitmentBytes = 48
	if leafCount == 0 {
		return nil, "", fmt.Errorf("leaf_count must be > 0")
	}
	commitmentSpan := leafCount * commitmentBytes
	witnessRaw, err := readWitnessCommitmentsForUserMdu(dealDir, userOrdinal, commitmentSpan)
	if err != nil {
		return nil, "", fmt.Errorf("failed to read witness commitments: %w", err)
	}

	if uint64(leafIndex) >= leafCount {
		return nil, "", fmt.Errorf("leaf_index out of range: %d", leafIndex)
	}
	commitmentOffset := int(leafIndex) * commitmentBytes
	blobCommitment := witnessRaw[commitmentOffset : commitmentOffset+commitmentBytes]

	leafHashes := make([][32]byte, 0, int(leafCount))
	for i := 0; i < len(witnessRaw); i += commitmentBytes {
		sum := blake2s.Sum256(witnessRaw[i : i+commitmentBytes])
		leafHashes = append(leafHashes, sum)
	}
	if len(leafHashes) == 0 || uint64(len(leafHashes)) != leafCount {
		return nil, "", fmt.Errorf("invalid witness length: got %d expected %d", len(leafHashes), leafCount)
	}
	root, merklePath := merkleRootAndPath(leafHashes, int(leafIndex))

	// Hop 3: compute a single blob opening proof without recomputing commitments.
	blobBytes, err := readMduBlob(mduPath, uint64(encodedBlobIndex))
	if err != nil {
		return nil, "", fmt.Errorf("failed to read blob bytes: %w", err)
	}
	z := make([]byte, 32)
	z[0] = 42
	z[1] = byte(encodedBlobIndex)
	var b [8]byte
	binary.BigEndian.PutUint64(b[:], zHint)
	copy(z[2:10], b[:])
	kzgProofBytes, y, err := crypto_ffi.ComputeBlobProof(blobBytes, z)
	if err != nil {
		return nil, "", fmt.Errorf("ComputeBlobProof failed: %w", err)
	}

	rootTableDuCommitment, rootTableDuMerkleFlat, rootTableOpening, _, err := crypto_ffi.ComputeMdu0RootTableProof(mdu0Bytes, mduIndex, root)
	if err != nil {
		return nil, "", fmt.Errorf("ComputeMdu0RootTableProof failed: %w", err)
	}
	rootTableDuMerklePath, err := splitMerkleProof32(rootTableDuMerkleFlat)
	if err != nil {
		return nil, "", fmt.Errorf("invalid root-table Merkle proof: %w", err)
	}

	chainedProof := types.ChainedProof{
		MduIndex:              mduIndex,
		MduRootFr:             root,
		ManifestOpening:       rootTableOpening,
		RootTableDuCommitment: rootTableDuCommitment,
		RootTableDuMerklePath: rootTableDuMerklePath,
		BlobCommitment:        blobCommitment,
		MerklePath:            merklePath,
		BlobIndex:             uint32(leafIndex),
		ZValue:                z,
		YValue:                y,
		KzgOpeningProof:       kzgProofBytes,
	}

	proofHash, err := types.HashChainedProof(&chainedProof)
	if err != nil {
		return nil, "", err
	}
	proofHashHex := "0x" + hex.EncodeToString(proofHash.Bytes())

	proofBytes, err := json.Marshal(chainedProof)
	if err != nil {
		return nil, "", err
	}

	headerPayload, err := json.Marshal(struct {
		DealId      uint64          `json:"deal_id"`
		EpochId     uint64          `json:"epoch_id"`
		ProofDetail json.RawMessage `json:"proof_details"`
		ProofHash   string          `json:"proof_hash"`
	}{
		DealId:      dealID,
		EpochId:     epoch,
		ProofDetail: json.RawMessage(proofBytes),
		ProofHash:   proofHashHex,
	})
	if err != nil {
		return nil, "", err
	}

	proofHeaderCache.Store(key, &cachedProof{
		mduModTime:   mduStat.ModTime().UnixNano(),
		mdu0ModTime:  mdu0Stat.ModTime().UnixNano(),
		payload:      headerPayload,
		proofHashHex: proofHashHex,
	})

	return headerPayload, proofHashHex, nil
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
		if idx%2 == 0 {
			if idx+1 < len(level) {
				h := make([]byte, 32)
				copy(h, level[idx+1][:])
				path = append(path, h)
			}
		} else {
			h := make([]byte, 32)
			copy(h, level[idx-1][:])
			path = append(path, h)
		}

		next := make([][32]byte, 0, (len(level)+1)/2)
		for i := 0; i < len(level); i += 2 {
			left := level[i]
			if i+1 < len(level) {
				right := level[i+1]
				var pair [64]byte
				copy(pair[:32], left[:])
				copy(pair[32:], right[:])
				next = append(next, blake2s.Sum256(pair[:]))
				continue
			}
			// rs_merkle propagates the left node when no sibling exists.
			next = append(next, left)
		}
		level = next
		idx /= 2
	}

	root := make([]byte, 32)
	copy(root, level[0][:])
	return root, path
}

func splitMerkleProof32(flat []byte) ([][]byte, error) {
	if len(flat) == 0 {
		return nil, fmt.Errorf("empty proof")
	}
	if len(flat)%32 != 0 {
		return nil, fmt.Errorf("length %d is not a multiple of 32", len(flat))
	}
	path := make([][]byte, 0, len(flat)/32)
	for i := 0; i < len(flat); i += 32 {
		node := make([]byte, 32)
		copy(node, flat[i:i+32])
		path = append(path, node)
	}
	return path, nil
}

func flattenMerkleProof32(path [][]byte) ([]byte, error) {
	flat := make([]byte, 0, len(path)*32)
	for i, node := range path {
		if len(node) != 32 {
			return nil, fmt.Errorf("node %d length %d", i, len(node))
		}
		flat = append(flat, node...)
	}
	return flat, nil
}

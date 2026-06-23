package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"

	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/types"
)

// IngestNewDealFast creates a simplified Deal Slab for testing.
// ...
func IngestNewDealFast(ctx context.Context, filePath string, maxUserMdus uint64, recordPath string, fileFlags uint8) (*crypto_ffi.Mdu0Builder, string, uint64, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, "", 0, err
	}

	// 1. Shard User File
	userMduPrefix := filePath + ".data"
	shardOut, err := shardFile(ctx, filePath, false, userMduPrefix)
	if err != nil {
		return nil, "", 0, fmt.Errorf("shardFile failed: %w", err)
	}

	// 2. Initialize Builder (Allocates 8MB buffer in memory)
	b := crypto_ffi.NewMdu0Builder(maxUserMdus)
	// Pointer return, check null? Wrapper panics or returns nil? Wrapper returns valid ptr or nil?
	// C wrapper returns ptr. Go wrapper returns struct with ptr.
	// Actually Go wrapper `NewMdu0Builder` returns `*Mdu0Builder` with `ptr`. `ptr` might be nil if allocation failed in C? C code uses Box, unlikely to fail unless OOM.

	// 3. Set User Roots in MDU #0
	// We skip Witness generation completely. Witness roots (indices 0..W-1) remain zero.
	witnessMduCount := b.GetWitnessCount()
	baseIdx := witnessMduCount
	rootsByMduIndex := make(map[uint64][]byte, len(shardOut.Mdus))
	orderedSlabRoots := make([][]byte, 0, int(witnessMduCount)+len(shardOut.Mdus))
	zeroRoot := make([]byte, types.POLYFS_ROOT_SIZE)
	for i := uint64(0); i < witnessMduCount; i++ {
		orderedSlabRoots = append(orderedSlabRoots, zeroRoot)
	}
	for _, mdu := range shardOut.Mdus {
		if mdu.Index < 0 {
			b.Free()
			return nil, "", 0, fmt.Errorf("invalid user MDU index %d", mdu.Index)
		}
		rootBytes, err := decodeMduRootHex(fmt.Sprintf("user MDU %d", mdu.Index), mdu.RootHex)
		if err != nil {
			b.Free()
			return nil, "", 0, err
		}
		userOrdinal := uint64(mdu.Index)
		if err := b.SetRoot(baseIdx+userOrdinal, rootBytes); err != nil {
			b.Free()
			return nil, "", 0, err
		}
		slabMduIndex := uint64(1) + witnessMduCount + userOrdinal
		rootsByMduIndex[slabMduIndex] = rootBytes
		orderedSlabRoots = append(orderedSlabRoots, rootBytes)
	}

	// 4. Append File Record
	baseName := normalizePolyfsRecordBasename(recordPath, filePath)
	if err := b.AppendFileWithFlags(baseName, shardOut.FileSize, 0, fileFlags); err != nil {
		b.Free()
		return nil, "", 0, err
	}

	// 5. Materialize MDU #0 and derive PolyFS root artifacts.
	mdu0Bytes, err := b.Bytes()
	if err != nil {
		b.Free()
		return nil, "", 0, err
	}

	parsedRoot, manifestBlob, err := computePolyfsManifestArtifacts(mdu0Bytes, rootsByMduIndex, orderedSlabRoots)
	if err != nil {
		b.Free()
		return nil, "", 0, err
	}

	// 6. Commit to Storage (Minimal)
	dealDir := filepath.Join(uploadDir, parsedRoot.Key)
	if err := os.MkdirAll(dealDir, 0755); err != nil {
		b.Free()
		return nil, "", 0, err
	}

	// Store MDU #0 (Raw)
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_0.bin"), mdu0Bytes, 0644); err != nil {
		b.Free()
		return nil, "", 0, err
	}
	// Store Manifest Blob (from shard output)
	if err := os.WriteFile(filepath.Join(dealDir, "manifest.bin"), manifestBlob, 0644); err != nil {
		b.Free()
		return nil, "", 0, err
	}

	// Move User Data MDUs (so fetch works)
	for _, mdu := range shardOut.Mdus {
		src := fmt.Sprintf("%s.mdu.%d.bin", userMduPrefix, mdu.Index)
		// We map them to the same layout logic: 1 + W + Index
		dest := filepath.Join(dealDir, fmt.Sprintf("mdu_%d.bin", 1+witnessMduCount+uint64(mdu.Index)))
		if err := os.Rename(src, dest); err != nil {
			b.Free()
			return nil, "", 0, fmt.Errorf("failed to move User MDU %d: %w", mdu.Index, err)
		}
	}

	witnessMdus := witnessMduCount
	userMdus := uint64(len(shardOut.Mdus))
	totalMdus := uint64(1) + witnessMdus + userMdus
	meta, err := buildSlabMetadataFromBuilder(b, slabMetadataBuildOptions{
		GenerationID: parsedRoot.Key,
		ManifestRoot: parsedRoot.Canonical,
		Source:       "gateway_mode1_new_fast",
		WitnessMdus:  &witnessMdus,
		UserMdus:     &userMdus,
		TotalMdus:    &totalMdus,
	})
	if err != nil {
		log.Printf("IngestNewDealFast: warning: failed to build slab metadata for manifest_root=%s: %v", parsedRoot.Canonical, err)
	} else if err := writeSlabMetadataFile(dealDir, meta); err != nil {
		log.Printf("IngestNewDealFast: warning: failed to write slab metadata for manifest_root=%s: %v", parsedRoot.Canonical, err)
	}

	allocatedLength := totalMdus
	return b, parsedRoot.Canonical, allocatedLength, nil
}

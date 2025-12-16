package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"nilchain/x/crypto_ffi"
)

// IngestNewDealFast creates a simplified Deal Slab for testing.
// ...
func IngestNewDealFast(ctx context.Context, filePath string, maxUserMdus uint64) (*crypto_ffi.Mdu0Builder, string, uint64, error) {
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
	for _, mdu := range shardOut.Mdus {
		rootBytes, _ := decodeHex(mdu.RootHex)
		var root [32]byte
		copy(root[:], rootBytes)
		if err := b.SetRoot(baseIdx+uint64(mdu.Index), root[:]); err != nil {
			b.Free()
			return nil, "", 0, err
		}
	}

	// 4. Append File Record
	baseName := filepath.Base(filePath)
	if len(baseName) > 40 {
		baseName = baseName[:40]
	}
	if err := b.AppendFile(baseName, shardOut.FileSize, 0); err != nil {
		b.Free()
		return nil, "", 0, err
	}

	// 5. Shard MDU #0 (To get the Manifest Root)
	mdu0Bytes, err := b.Bytes()
	if err != nil {
		b.Free()
		return nil, "", 0, err
	}
	tmp0, _ := os.CreateTemp(uploadDir, "mdu0-fast-*.bin")
	tmp0.Write(mdu0Bytes)
	tmp0Name := tmp0.Name()
	tmp0.Close()

	mdu0Prefix := tmp0Name + ".shard"
	mdu0Out, err := shardFile(ctx, tmp0Name, true, mdu0Prefix)
	if err != nil {
		b.Free()
		return nil, "", 0, fmt.Errorf("failed to shard MDU #0: %w", err)
	}
	os.Remove(tmp0Name)

	if len(mdu0Out.Mdus) == 0 {
		b.Free()
		return nil, "", 0, fmt.Errorf("MDU #0 produced no MDUs")
	}

	// For Fast Mode, we assume the MDU #0 Root IS the Manifest Root.
	// (Technically incorrect for Triple Proof, but sufficient for visual verification)
	// Wait, shardFile returns a "ManifestRoot" which is the commitment of the MDU roots.
	// Since we only sharded MDU #0 here, `mdu0Out.ManifestRootHex` is just Commit(Root_MDU0).
	// This is consistent enough for a single-file view.
	manifestRoot := mdu0Out.ManifestRootHex

	parsedRoot, err := parseManifestRoot(manifestRoot)
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
	os.WriteFile(filepath.Join(dealDir, "mdu_0.bin"), mdu0Bytes, 0644)
	// Store Manifest Blob (from shard output)
	manifestBlob, _ := decodeHex(mdu0Out.ManifestBlobHex)
	os.WriteFile(filepath.Join(dealDir, "manifest.bin"), manifestBlob, 0644)

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

	allocatedLength := uint64(len(mdu0Out.Mdus)) // Dummy length
	return b, parsedRoot.Canonical, allocatedLength, nil
}

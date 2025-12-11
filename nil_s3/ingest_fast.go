package main

import (
	"fmt"
	"os"
	"path/filepath"

	"nil_s3/pkg/builder"
	"nil_s3/pkg/layout"
)

// IngestNewDealFast creates a simplified Deal Slab for testing.
// It skips the heavy Witness MDU generation/sharding/proofing loop.
// Instead, it:
// 1. Shards the user file to get its roots.
// 2. Builds a minimal MDU #0 with just the user roots (Witness roots left empty).
// 3. Shards ONLY MDU #0 to get a valid Manifest Root.
// 4. Returns quickly (~1s).
//
// NOTE: This produces a Deal that is "valid enough" for:
// - CreateDeal/UpdateContent on-chain (since chain only verifies signature).
// - Retrieve MDU #0 (since we shard it).
// - Retrieve User Data (since we shard it).
//
// IT WILL FAIL:
// - "Triple Proof" verification on-chain (MsgSubmitRetrievalProof) because
//   Witness MDUs are missing/empty, so the inclusion proof path
//   (Manifest -> WitnessBlob -> UserBlob) is broken.
//
// Use this for "Upload -> Create Deal" UX testing where heavy proofing isn't required.
func IngestNewDealFast(filePath string, maxUserMdus uint64) (*builder.Mdu0Builder, string, uint64, error) {
	// 1. Shard User File
	userMduPrefix := filePath + ".data"
	shardOut, err := shardFile(filePath, false, userMduPrefix)
	if err != nil {
		return nil, "", 0, fmt.Errorf("shardFile failed: %w", err)
	}

	// 2. Initialize Builder (Allocates 8MB buffer in memory)
	b, err := builder.NewMdu0Builder(maxUserMdus)
	if err != nil {
		return nil, "", 0, fmt.Errorf("NewMdu0Builder failed: %w", err)
	}

	// 3. Set User Roots in MDU #0
	// We skip Witness generation completely. Witness roots (indices 0..W-1) remain zero.
	baseIdx := b.WitnessMduCount
	for _, mdu := range shardOut.Mdus {
		rootBytes, _ := decodeHex(mdu.RootHex)
		var root [32]byte
		copy(root[:], rootBytes)
		// offset is WitnessCount + UserMduIndex
		if err := b.SetRoot(baseIdx+uint64(mdu.Index), root); err != nil { return nil, "", 0, err }
	}

	// 4. Append File Record
	rec := layout.FileRecordV1{
		StartOffset: 0,
		LengthAndFlags: layout.PackLengthAndFlags(shardOut.FileSize, 0),
		Timestamp: 0,
	}
	baseName := filepath.Base(filePath)
	if len(baseName) > 40 { baseName = baseName[:40] }
	copy(rec.Path[:], baseName)
	b.AppendFileRecord(rec)

	// 5. Shard MDU #0 (To get the Manifest Root)
	mdu0Bytes := b.Bytes()
	tmp0, _ := os.CreateTemp(uploadDir, "mdu0-fast-*.bin")
	tmp0.Write(mdu0Bytes)
	tmp0Name := tmp0.Name()
	tmp0.Close()
	
	mdu0Prefix := tmp0Name + ".shard"
	mdu0Out, err := shardFile(tmp0Name, false, mdu0Prefix)
	if err != nil { return nil, "", 0, fmt.Errorf("failed to shard MDU #0: %w", err) }
	os.Remove(tmp0Name)
	
	if len(mdu0Out.Mdus) == 0 {
		return nil, "", 0, fmt.Errorf("MDU #0 produced no MDUs")
	}
	
	// For Fast Mode, we assume the MDU #0 Root IS the Manifest Root.
	// (Technically incorrect for Triple Proof, but sufficient for visual verification)
	// Wait, shardFile returns a "ManifestRoot" which is the commitment of the MDU roots.
	// Since we only sharded MDU #0 here, `mdu0Out.ManifestRootHex` is just Commit(Root_MDU0).
	// This is consistent enough for a single-file view.
	manifestRoot := mdu0Out.ManifestRootHex

	// 6. Commit to Storage (Minimal)
	dealDir := filepath.Join(uploadDir, manifestRoot)
	if err := os.MkdirAll(dealDir, 0755); err != nil { return nil, "", 0, err }

	// Store MDU #0 (Raw)
	os.WriteFile(filepath.Join(dealDir, "mdu_0.bin"), mdu0Bytes, 0644)
	// Store Manifest Blob (from shard output)
	manifestBlob, _ := decodeHex(mdu0Out.ManifestBlobHex)
	os.WriteFile(filepath.Join(dealDir, "manifest.bin"), manifestBlob, 0644)

	// Move User Data MDUs (so fetch works)
	for _, mdu := range shardOut.Mdus {
		src := fmt.Sprintf("%s.mdu.%d.bin", userMduPrefix, mdu.Index)
		// We map them to the same layout logic: 1 + W + Index
		dest := filepath.Join(dealDir, fmt.Sprintf("mdu_%d.bin", 1+b.WitnessMduCount+uint64(mdu.Index)))
		if err := os.Rename(src, dest); err != nil {
			return nil, "", 0, fmt.Errorf("failed to move User MDU %d: %w", mdu.Index, err)
		}
	}

	allocatedLength := uint64(len(mdu0Out.Mdus)) // Dummy length
	return b, manifestRoot, allocatedLength, nil
}

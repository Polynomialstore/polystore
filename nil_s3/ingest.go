package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"

	"nil_s3/pkg/builder"
	"nil_s3/pkg/layout"
)

// IngestNewDeal creates a new MDU #0 and Witness MDUs from a source file.
func IngestNewDeal(filePath string, maxUserMdus uint64) (*builder.Mdu0Builder, string, uint64, error) {
	// 1. Shard the user file to get Data MDU roots and commitments
	shardOut, err := shardFile(filePath)
	if err != nil {
		return nil, "", 0, fmt.Errorf("shardFile failed: %w", err)
	}

	// 2. Initialize Builder
	b, err := builder.NewMdu0Builder(maxUserMdus)
	if err != nil {
		return nil, "", 0, fmt.Errorf("NewMdu0Builder failed: %w", err)
	}

	// 3. Build Witness Data Buffer
	witnessBuf := new(bytes.Buffer)
	for _, mdu := range shardOut.Mdus {
		for _, blobHex := range mdu.Blobs {
			blobBytes, err := decodeHex(blobHex)
			if err != nil {
				return nil, "", 0, err
			}
			witnessBuf.Write(blobBytes)
		}
	}

	// 4. Create and Shard Witness MDUs
	witnessData := witnessBuf.Bytes()
	witnessMduSize := 8 * 1024 * 1024
	
	// We expect b.WitnessMduCount Witness MDUs.
	// Current implementation: One big witness buffer. We must slice it.
	// Note: If the file is small, we have less data than W*8MB.
	// We just process what we have. Empty space in Witness MDUs is zeros.
	
	for i := uint64(0); i < b.WitnessMduCount; i++ {
		start := int(i) * witnessMduSize
		end := start + witnessMduSize
		
		var chunk []byte
		if start >= len(witnessData) {
			chunk = make([]byte, witnessMduSize) // All zeros
		} else {
			if end > len(witnessData) {
				end = len(witnessData)
			}
			chunk = make([]byte, witnessMduSize)
			copy(chunk, witnessData[start:end])
		}

		// Save Witness MDU to temp file for sharding
		tmp, _ := os.CreateTemp(uploadDir, fmt.Sprintf("witness-%d-*.bin", i))
		tmp.Write(chunk)
		tmpName := tmp.Name()
		tmp.Close()
		defer os.Remove(tmpName)

		// Shard Witness MDU to get its Root
		wOut, err := shardFile(tmpName)
		if err != nil {
			return nil, "", 0, fmt.Errorf("failed to shard witness MDU %d: %w", i, err)
		}

		// Set Root in MDU #0 (Index 0..W-1)
		rootBytes, _ := decodeHex(wOut.ManifestRootHex) // MDU Root is ManifestRoot of 1 MDU
		var root [32]byte
		copy(root[:], rootBytes)
		if err := b.SetRoot(i, root); err != nil {
			return nil, "", 0, err
		}
		
		// TODO: Persist the Witness MDU properly?
		// For now, we are just calculating Roots. 
		// Real implementation must save `chunk` to `uploads/deals/<id>/mdu_<i+1>.bin`.
	}

	// 5. Set User Data Roots
	// User Data MDUs start at index W (RootTable[W] -> MDU #W+1)
	baseIdx := b.WitnessMduCount
	for _, mdu := range shardOut.Mdus {
		rootBytes, _ := decodeHex(mdu.RootHex)
		var root [32]byte
		copy(root[:], rootBytes)
		if err := b.SetRoot(baseIdx+uint64(mdu.Index), root); err != nil {
			return nil, "", 0, err
		}
	}

	// 6. Append File Record
	rec := layout.FileRecordV1{
		StartOffset:    0, // First file
		LengthAndFlags: layout.PackLengthAndFlags(shardOut.FileSize, 0), // Default flags
		Timestamp:      uint64(0), // TODO: Time
	}
	// Filename
	baseName := filepath.Base(filePath)
	if len(baseName) > 40 {
		baseName = baseName[:40]
	}
	copy(rec.Path[:], baseName)

	if err := b.AppendFileRecord(rec); err != nil {
		return nil, "", 0, err
	}

	// 7. Shard MDU #0 to get Deal Manifest Root
	mdu0Bytes := b.Bytes()
	tmp0, _ := os.CreateTemp(uploadDir, "mdu0-*.bin")
	tmp0.Write(mdu0Bytes)
	tmp0Name := tmp0.Name()
	tmp0.Close()
	defer os.Remove(tmp0Name)

	finalOut, err := shardFile(tmp0Name)
	if err != nil {
		return nil, "", 0, fmt.Errorf("failed to shard MDU #0: %w", err)
	}

	allocatedLength := 1 + b.WitnessMduCount + uint64(len(shardOut.Mdus))
	return b, finalOut.ManifestRootHex, allocatedLength, nil
}

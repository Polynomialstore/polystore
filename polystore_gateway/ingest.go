package main

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"

	"polystorechain/x/crypto_ffi"
)

const RawMduCapacity = 8126464

// IngestNewDeal creates a new Deal Slab.
func IngestNewDeal(ctx context.Context, filePath string, maxUserMdus uint64, recordPath string, fileFlags uint8) (*crypto_ffi.Mdu0Builder, string, uint64, error) {
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

	// 2. Initialize Builder
	b := crypto_ffi.NewMdu0Builder(maxUserMdus)
	// No error check for NewMdu0Builder as it returns pointer

	rootsByMduIndex := make(map[uint64][]byte)
	orderedSlabRoots := make([][]byte, 0)

	// 3. Build Witness Data Buffer
	witnessBuf := new(bytes.Buffer)
	for _, mdu := range shardOut.Mdus {
		for _, blobHex := range mdu.Blobs {
			blobBytes, err := decodeHex(blobHex)
			if err != nil {
				b.Free()
				return nil, "", 0, err
			}
			witnessBuf.Write(blobBytes)
		}
	}
	witnessData := witnessBuf.Bytes()

	// 4. Create and Shard Witness MDUs
	witnessMduCount := b.GetWitnessCount()
	// We need to track paths for moving
	witnessMduPaths := make([]string, witnessMduCount)

	for i := uint64(0); i < witnessMduCount; i++ {
		if err := ctx.Err(); err != nil {
			b.Free()
			return nil, "", 0, err
		}

		start := int(i) * RawMduCapacity
		end := start + RawMduCapacity
		var chunk []byte
		if start >= len(witnessData) {
			chunk = []byte{0}
		} else {
			if end > len(witnessData) {
				end = len(witnessData)
			}
			chunk = witnessData[start:end]
		}

		tmp, _ := os.CreateTemp(uploadDir, fmt.Sprintf("witness-%d-*.bin", i))
		tmp.Write(chunk)
		tmpName := tmp.Name()
		tmp.Close()

		witnessPrefix := tmpName + ".shard"
		wOut, err := shardFile(ctx, tmpName, false, witnessPrefix)
		if err != nil {
			b.Free()
			return nil, "", 0, fmt.Errorf("failed to shard witness MDU %d: %w", i, err)
		}
		os.Remove(tmpName)

		generatedMdu := fmt.Sprintf("%s.mdu.0.bin", witnessPrefix)
		if _, err := os.Stat(generatedMdu); err == nil {
			witnessMduPaths[i] = generatedMdu
		} else {
			b.Free()
			return nil, "", 0, fmt.Errorf("witness MDU file not found: %s", generatedMdu)
		}

		// Store Root
		if len(wOut.Mdus) == 0 {
			b.Free()
			return nil, "", 0, fmt.Errorf("witness MDU %d produced no MDUs", i)
		}
		wRoot := wOut.Mdus[0].RootHex

		// Set in MDU #0
		rootBytes, err := decodeMduRootHex(fmt.Sprintf("witness MDU %d", i), wRoot)
		if err != nil {
			b.Free()
			return nil, "", 0, err
		}
		if err := b.SetRoot(i, rootBytes); err != nil {
			b.Free()
			return nil, "", 0, err
		}
		slabMduIndex := uint64(1) + i
		rootsByMduIndex[slabMduIndex] = rootBytes
		orderedSlabRoots = append(orderedSlabRoots, rootBytes)
	}

	// 5. Set User Roots in MDU #0
	baseIdx := witnessMduCount
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

	// 6. Append File Record
	baseName := normalizePolyfsRecordBasename(recordPath, filePath)
	if err := b.AppendFileWithFlags(baseName, shardOut.FileSize, 0, fileFlags); err != nil {
		b.Free()
		return nil, "", 0, err
	}

	// 7. Materialize MDU #0 and derive PolyFS root artifacts.
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

	// 8. Commit to Storage
	dealDir := filepath.Join(uploadDir, parsedRoot.Key)
	if err := os.MkdirAll(dealDir, 0755); err != nil {
		b.Free()
		return nil, "", 0, err
	}

	// Store Manifest Blob
	if err := os.WriteFile(filepath.Join(dealDir, "manifest.bin"), manifestBlob, 0644); err != nil {
		b.Free()
		return nil, "", 0, err
	}

	// Store MDU #0 (Raw)
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_0.bin"), mdu0Bytes, 0644); err != nil {
		b.Free()
		return nil, "", 0, err
	}

	// Move Witness MDUs
	for i, path := range witnessMduPaths {
		dest := filepath.Join(dealDir, fmt.Sprintf("mdu_%d.bin", 1+i))
		if err := os.Rename(path, dest); err != nil {
			b.Free()
			return nil, "", 0, fmt.Errorf("failed to move Witness MDU %d: %w", i, err)
		}
	}

	// Move User Data MDUs
	for _, mdu := range shardOut.Mdus {
		src := fmt.Sprintf("%s.mdu.%d.bin", userMduPrefix, mdu.Index)
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
		Source:       "gateway_mode1_new",
		WitnessMdus:  &witnessMdus,
		UserMdus:     &userMdus,
		TotalMdus:    &totalMdus,
	})
	if err != nil {
		log.Printf("IngestNewDeal: warning: failed to build slab metadata for manifest_root=%s: %v", parsedRoot.Canonical, err)
	} else if err := writeSlabMetadataFile(dealDir, meta); err != nil {
		log.Printf("IngestNewDeal: warning: failed to write slab metadata for manifest_root=%s: %v", parsedRoot.Canonical, err)
	}

	allocatedLength := totalMdus
	// b is returned, caller must Free it?
	// The original code returned b.
	// But in Rust FFI, b needs explicit Free.
	// If I return it, caller owns it.
	return b, parsedRoot.Canonical, allocatedLength, nil
}

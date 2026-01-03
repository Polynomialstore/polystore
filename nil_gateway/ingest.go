package main

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"nilchain/x/crypto_ffi"
)

const RawMduCapacity = 8126464

// IngestNewDeal creates a new Deal Slab.
func IngestNewDeal(ctx context.Context, filePath string, maxUserMdus uint64, recordPath string) (*crypto_ffi.Mdu0Builder, string, uint64, error) {
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

	// 3. Collect ALL Roots for Aggregation
	var allRoots []string

	// 3a. Process User Roots (Wait, MDU #0 comes first, then Witness, then User)
	// But we need MDU #0 roots to aggregate.
	// Circular dependency: MDU #0 contains Witness+User roots.
	// But MDU #0 root is needed for Manifest.
	// Manifest is Commitment([Root_MDU0, Root_W1...Root_WN, Root_U1...Root_UM]).

	// So:
	// 1. Calculate Witness Roots.
	// 2. Calculate User Roots.
	// 3. Populate MDU #0 with these.
	// 4. Calculate MDU #0 Root.
	// 5. Aggregate [Root_MDU0, Witness..., User...] -> Manifest.

	// 4. Build Witness Data Buffer
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

	// 5. Create and Shard Witness MDUs
	witnessRoots := []string{}
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
		witnessRoots = append(witnessRoots, wRoot)

		// Set in MDU #0
		rootBytes, _ := decodeHex(wRoot)
		var root [32]byte
		copy(root[:], rootBytes)
		if err := b.SetRoot(i, root[:]); err != nil {
			b.Free()
			return nil, "", 0, err
		}
	}

	// 6. Set User Roots in MDU #0
	userRoots := []string{}
	baseIdx := witnessMduCount
	for _, mdu := range shardOut.Mdus {
		userRoots = append(userRoots, mdu.RootHex)
		rootBytes, _ := decodeHex(mdu.RootHex)
		var root [32]byte
		copy(root[:], rootBytes)
		if err := b.SetRoot(baseIdx+uint64(mdu.Index), root[:]); err != nil {
			b.Free()
			return nil, "", 0, err
		}
	}

	// 7. Append File Record
	baseName := strings.TrimSpace(recordPath)
	if baseName == "" {
		baseName = filepath.Base(filePath)
	}
	if len(baseName) > 40 {
		baseName = baseName[:40]
	}
	if err := b.AppendFile(baseName, shardOut.FileSize, 0); err != nil {
		b.Free()
		return nil, "", 0, err
	}

	// 8. Shard MDU #0
	mdu0Bytes, err := b.Bytes()
	if err != nil {
		b.Free()
		return nil, "", 0, err
	}
	
	tmp0, _ := os.CreateTemp(uploadDir, "mdu0-*.bin")
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

	// 9. Aggregate Roots -> Manifest
	if len(mdu0Out.Mdus) == 0 {
		b.Free()
		return nil, "", 0, fmt.Errorf("MDU #0 produced no MDUs")
	}
	allRoots = append(allRoots, mdu0Out.Mdus[0].RootHex) // MDU #0 is Index 0
	allRoots = append(allRoots, witnessRoots...)
	allRoots = append(allRoots, userRoots...)

	manifestRoot, manifestBlobHex, err := aggregateRootsWithContext(ctx, allRoots)
	if err != nil {
		b.Free()
		return nil, "", 0, fmt.Errorf("aggregateRoots failed: %w", err)
	}

	parsedRoot, err := parseManifestRoot(manifestRoot)
	if err != nil {
		b.Free()
		return nil, "", 0, err
	}

	// 10. Commit to Storage
	dealDir := filepath.Join(uploadDir, parsedRoot.Key)
	if err := os.MkdirAll(dealDir, 0755); err != nil {
		b.Free()
		return nil, "", 0, err
	}

	// Store Manifest Blob
	manifestBlob, _ := decodeHex(manifestBlobHex)
	os.WriteFile(filepath.Join(dealDir, "manifest.bin"), manifestBlob, 0644)

	// Store MDU #0 (Raw)
	os.WriteFile(filepath.Join(dealDir, "mdu_0.bin"), mdu0Bytes, 0644)

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

	allocatedLength := uint64(len(allRoots))
	// b is returned, caller must Free it?
	// The original code returned b.
	// But in Rust FFI, b needs explicit Free.
	// If I return it, caller owns it.
	return b, parsedRoot.Canonical, allocatedLength, nil
}

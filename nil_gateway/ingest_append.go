package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"

	"nilchain/x/crypto_ffi"
	"nilchain/x/nilchain/types"
)

// IngestAppendToDeal appends a new file into an existing deal slab.
// It loads the prior slab from uploads/<existingManifestRoot>/, adds new User Data MDUs,
// rebuilds Witness MDUs, updates MDU #0, and writes a new slab under uploads/<newManifestRoot>/.
//
// NOTE: Mode 1 append currently uses naive MDU-boundary packing:
// each appended file starts at the next 8 MiB User-Data MDU boundary.
func IngestAppendToDeal(ctx context.Context, filePath, existingManifestRoot string, maxUserMdus uint64) (*crypto_ffi.Mdu0Builder, string, uint64, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, "", 0, err
	}

	parsedExisting, err := parseManifestRoot(existingManifestRoot)
	if err != nil {
		return nil, "", 0, err
	}
	oldDir, err := resolveDealDir(parsedExisting, existingManifestRoot)
	if err != nil {
		return nil, "", 0, fmt.Errorf("failed to resolve existing slab dir: %w", err)
	}
	mdu0Path := filepath.Join(oldDir, "mdu_0.bin")
	mdu0Data, err := os.ReadFile(mdu0Path)
	if err != nil {
		return nil, "", 0, fmt.Errorf("failed to read existing MDU #0: %w", err)
	}

	// Parse existing MDU #0.
	b, err := crypto_ffi.LoadMdu0Builder(mdu0Data, maxUserMdus)
	if err != nil {
		return nil, "", 0, fmt.Errorf("failed to parse existing MDU #0: %w", err)
	}

	// Determine current high-water mark for User Data (in raw NilFS bytes).
	var maxEnd uint64
	recordCount := b.GetRecordCount()
	for i := uint32(0); i < recordCount; i++ {
		rec, err := b.GetRecord(i)
		if err != nil {
			continue
		}
		length, _ := crypto_ffi.UnpackLengthAndFlags(rec.LengthAndFlags)
		end := rec.StartOffset + length
		if end > maxEnd {
			maxEnd = end
		}
	}
	oldUserCount := uint64(0)
	if maxEnd > 0 {
		oldUserCount = (maxEnd + RawMduCapacity - 1) / RawMduCapacity
	}

	// Shard new file to produce new User Data MDUs.
	userMduPrefix := filePath + ".data"
	shardOut, err := shardFile(ctx, filePath, false, userMduPrefix)
	if err != nil {
		b.Free()
		return nil, "", 0, fmt.Errorf("shardFile failed: %w", err)
	}

	// Append a new file record starting at next MDU boundary.
	baseName := filepath.Base(filePath)
	if len(baseName) > 40 {
		baseName = baseName[:40]
	}
	if err := b.AppendFile(baseName, shardOut.FileSize, oldUserCount*RawMduCapacity); err != nil {
		b.Free()
		return nil, "", 0, fmt.Errorf("AppendFileRecord failed: %w", err)
	}

	// Collect existing + new user MDU paths in slab order.
	witnessMduCount := b.GetWitnessCount()
	userMduPaths := make([]string, 0, oldUserCount+uint64(len(shardOut.Mdus)))
	for i := uint64(0); i < oldUserCount; i++ {
		slabIdx := 1 + witnessMduCount + i
		userMduPaths = append(userMduPaths, filepath.Join(oldDir, fmt.Sprintf("mdu_%d.bin", slabIdx)))
	}
	for _, mdu := range shardOut.Mdus {
		src := fmt.Sprintf("%s.mdu.%d.bin", userMduPrefix, mdu.Index)
		userMduPaths = append(userMduPaths, src)
	}

	// Recompute User roots + Witness data (blob commitments) from the encoded User MDUs.
	userRoots, witnessData, err := computeUserRootsAndWitnessData(ctx, userMduPaths)
	if err != nil {
		b.Free()
		return nil, "", 0, err
	}

	// Rebuild Witness MDUs from full witnessData.
	witnessRoots, witnessMduPaths, err := buildWitnessMdusFromData(ctx, witnessData, witnessMduCount)
	if err != nil {
		b.Free()
		return nil, "", 0, err
	}

	// Update Witness roots in MDU #0 (indices 0..W-1).
	for i, wRoot := range witnessRoots {
		rootBytes, err := decodeHex(wRoot)
		if err != nil {
			b.Free()
			return nil, "", 0, fmt.Errorf("invalid witness root %q: %w", wRoot, err)
		}
		var root [32]byte
		copy(root[:], rootBytes)
		if err := b.SetRoot(uint64(i), root[:]); err != nil {
			b.Free()
			return nil, "", 0, fmt.Errorf("SetRoot (witness %d) failed: %w", i, err)
		}
	}

	// Update User roots in MDU #0 (starting at index W).
	baseIdx := witnessMduCount
	for i, uRoot := range userRoots {
		rootBytes, err := decodeHex(uRoot)
		if err != nil {
			b.Free()
			return nil, "", 0, fmt.Errorf("invalid user root %q: %w", uRoot, err)
		}
		var root [32]byte
		copy(root[:], rootBytes)
		if err := b.SetRoot(baseIdx+uint64(i), root[:]); err != nil {
			b.Free()
			return nil, "", 0, fmt.Errorf("SetRoot (user %d) failed: %w", i, err)
		}
	}

	// Shard MDU #0 to derive its root for manifest aggregation.
	mdu0Bytes, err := b.Bytes()
	if err != nil {
		b.Free()
		return nil, "", 0, err
	}

	tmp0, err := os.CreateTemp(uploadDir, "mdu0-append-*.bin")
	if err != nil {
		b.Free()
		return nil, "", 0, err
	}
	if _, err := tmp0.Write(mdu0Bytes); err != nil {
		tmp0.Close()
		b.Free()
		return nil, "", 0, err
	}
	tmp0Name := tmp0.Name()
	tmp0.Close()

	mdu0Prefix := tmp0Name + ".shard"
	mdu0Out, err := shardFile(ctx, tmp0Name, true, mdu0Prefix)
	os.Remove(tmp0Name)
	if err != nil {
		b.Free()
		return nil, "", 0, fmt.Errorf("failed to shard MDU #0: %w", err)
	}
	if len(mdu0Out.Mdus) == 0 {
		b.Free()
		return nil, "", 0, fmt.Errorf("MDU #0 produced no MDUs")
	}

	// Aggregate [Root_MDU0, Witness..., User...] -> ManifestRoot.
	allRoots := []string{mdu0Out.Mdus[0].RootHex}
	allRoots = append(allRoots, witnessRoots...)
	allRoots = append(allRoots, userRoots...)

	manifestRoot, manifestBlobHex, err := aggregateRootsWithContext(ctx, allRoots)
	if err != nil {
		b.Free()
		return nil, "", 0, fmt.Errorf("aggregateRoots failed: %w", err)
	}

	parsedNewRoot, err := parseManifestRoot(manifestRoot)
	if err != nil {
		b.Free()
		return nil, "", 0, err
	}

	// Commit new slab to storage under uploads/<manifestRoot>.
	newDir := filepath.Join(uploadDir, parsedNewRoot.Key)
	if err := os.MkdirAll(newDir, 0o755); err != nil {
		b.Free()
		return nil, "", 0, err
	}

	manifestBlob, err := decodeHex(manifestBlobHex)
	if err != nil {
		b.Free()
		return nil, "", 0, err
	}
	if err := os.WriteFile(filepath.Join(newDir, "manifest.bin"), manifestBlob, 0o644); err != nil {
		b.Free()
		return nil, "", 0, err
	}
	if err := os.WriteFile(filepath.Join(newDir, "mdu_0.bin"), mdu0Bytes, 0o644); err != nil {
		b.Free()
		return nil, "", 0, err
	}

	// Move new Witness MDUs into place (mdu_1..mdu_W).
	for i, path := range witnessMduPaths {
		dest := filepath.Join(newDir, fmt.Sprintf("mdu_%d.bin", 1+i))
		if err := os.Rename(path, dest); err != nil {
			b.Free()
			return nil, "", 0, fmt.Errorf("failed to move Witness MDU %d: %w", i, err)
		}
	}

	// Copy old User MDUs into new slab directory.
	for i := uint64(0); i < oldUserCount; i++ {
		slabIdx := 1 + witnessMduCount + i
		src := filepath.Join(oldDir, fmt.Sprintf("mdu_%d.bin", slabIdx))
		dest := filepath.Join(newDir, fmt.Sprintf("mdu_%d.bin", slabIdx))
		if err := copyFile(src, dest); err != nil {
			b.Free()
			return nil, "", 0, fmt.Errorf("failed to copy User MDU %d: %w", i, err)
		}
	}

	// Move new User Data MDUs into new slab directory after oldUserCount.
	for _, mdu := range shardOut.Mdus {
		src := fmt.Sprintf("%s.mdu.%d.bin", userMduPrefix, mdu.Index)
		destIdx := 1 + witnessMduCount + oldUserCount + uint64(mdu.Index)
		dest := filepath.Join(newDir, fmt.Sprintf("mdu_%d.bin", destIdx))
		if err := os.Rename(src, dest); err != nil {
			b.Free()
			return nil, "", 0, fmt.Errorf("failed to move new User MDU %d: %w", mdu.Index, err)
		}
	}

	allocatedLength := uint64(len(allRoots))
	return b, parsedNewRoot.Canonical, allocatedLength, nil
}

// computeUserRootsAndWitnessData recomputes User MDU roots and the concatenated
// blob commitments (Witness data) from a list of encoded User MDU files.
func computeUserRootsAndWitnessData(ctx context.Context, userMduPaths []string) ([]string, []byte, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}

	tmp, err := os.CreateTemp(uploadDir, "user-mdus-*.bin")
	if err != nil {
		return nil, nil, err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	for _, p := range userMduPaths {
		data, err := os.ReadFile(p)
		if err != nil {
			tmp.Close()
			return nil, nil, fmt.Errorf("failed to read user mdu %s: %w", p, err)
		}
		if len(data) != types.MDU_SIZE { // Was builder.MduSize
			// Keep going but surface a clear error.
			tmp.Close()
			return nil, nil, fmt.Errorf("user mdu %s has unexpected size %d", p, len(data))
		}
		if _, err := tmp.Write(data); err != nil {
			tmp.Close()
			return nil, nil, err
		}
	}
	if err := tmp.Close(); err != nil {
		return nil, nil, err
	}

	out, err := shardFile(ctx, tmpName, true, "")
	if err != nil {
		return nil, nil, fmt.Errorf("failed to recompute user roots: %w", err)
	}
	if len(out.Mdus) != len(userMduPaths) {
		return nil, nil, fmt.Errorf("user root recompute mismatch: expected %d mdus, got %d", len(userMduPaths), len(out.Mdus))
	}

	// Sort by index to be safe.
	sort.Slice(out.Mdus, func(i, j int) bool { return out.Mdus[i].Index < out.Mdus[j].Index })

	roots := make([]string, len(out.Mdus))
	witnessBuf := new(bytes.Buffer)

	for _, mdu := range out.Mdus {
		if mdu.Index < 0 || mdu.Index >= len(roots) {
			return nil, nil, fmt.Errorf("invalid mdu index %d in recompute output", mdu.Index)
		}
		roots[mdu.Index] = mdu.RootHex
		for _, blobHex := range mdu.Blobs {
			blobBytes, err := decodeHex(blobHex)
			if err != nil {
				return nil, nil, fmt.Errorf("invalid blob commitment %q: %w", blobHex, err)
			}
			witnessBuf.Write(blobBytes)
		}
	}

	return roots, witnessBuf.Bytes(), nil
}

// buildWitnessMdusFromData shards witnessData into W witness MDUs, returning their roots and paths.
func buildWitnessMdusFromData(ctx context.Context, witnessData []byte, witnessCount uint64) ([]string, []string, error) {
	if ctx == nil {
		ctx = context.Background()
	}

	witnessRoots := make([]string, 0, witnessCount)
	witnessPaths := make([]string, witnessCount)

	for i := uint64(0); i < witnessCount; i++ {
		if err := ctx.Err(); err != nil {
			return nil, nil, err
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

		tmp, err := os.CreateTemp(uploadDir, fmt.Sprintf("witness-%d-*.bin", i))
		if err != nil {
			return nil, nil, err
		}
		if _, err := tmp.Write(chunk); err != nil {
			tmp.Close()
			return nil, nil, err
		}
		tmpName := tmp.Name()
		tmp.Close()

		prefix := tmpName + ".shard"
		wOut, err := shardFile(ctx, tmpName, false, prefix)
		os.Remove(tmpName)
		if err != nil {
			return nil, nil, fmt.Errorf("failed to shard witness MDU %d: %w", i, err)
		}
		if len(wOut.Mdus) == 0 {
			return nil, nil, fmt.Errorf("witness MDU %d produced no MDUs", i)
		}

		generated := fmt.Sprintf("%s.mdu.0.bin", prefix)
		if _, err := os.Stat(generated); err != nil {
			return nil, nil, fmt.Errorf("witness MDU file not found: %s", generated)
		}

		witnessPaths[i] = generated
		witnessRoots = append(witnessRoots, wOut.Mdus[0].RootHex)
	}

	return witnessRoots, witnessPaths, nil
}

func copyFile(src, dst string) error {
	if err := os.Link(src, dst); err == nil {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

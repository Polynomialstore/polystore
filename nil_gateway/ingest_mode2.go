package main

import (
	"context"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"golang.org/x/sync/errgroup"

	"nilchain/x/crypto_ffi"
	"nilchain/x/nilchain/types"
)

type mode2IngestResult struct {
	manifestRoot    ManifestRoot
	manifestBlob    []byte
	allocatedLength uint64
	fileSize        uint64
	sizeBytes       uint64
	witnessMdus     uint64
	userMdus        uint64
}

func encodePayloadToMdu(raw []byte) []byte {
	if len(raw) > RawMduCapacity {
		raw = raw[:RawMduCapacity]
	}
	encoded := make([]byte, types.MDU_SIZE)
	scalarIdx := 0
	for i := 0; i < len(raw) && scalarIdx < nilfsScalarsPerMdu; i += nilfsScalarPayloadBytes {
		end := i + nilfsScalarPayloadBytes
		if end > len(raw) {
			end = len(raw)
		}
		chunk := raw[i:end]
		pad := nilfsScalarBytes - len(chunk)
		offset := scalarIdx*nilfsScalarBytes + pad
		copy(encoded[offset:offset+len(chunk)], chunk)
		scalarIdx++
	}
	return encoded
}

func decodePayloadFromMdu(encoded []byte, rawLen uint64) ([]byte, error) {
	if rawLen > RawMduCapacity {
		rawLen = RawMduCapacity
	}
	if rawLen == 0 {
		return []byte{}, nil
	}
	if len(encoded) != types.MDU_SIZE {
		return nil, fmt.Errorf("invalid MDU size: %d", len(encoded))
	}

	scalarsUsed := (rawLen + nilfsScalarPayloadBytes - 1) / nilfsScalarPayloadBytes
	out := make([]byte, rawLen)
	var outOff uint64
	for scalarIdx := uint64(0); scalarIdx < scalarsUsed; scalarIdx++ {
		remaining := rawLen - scalarIdx*nilfsScalarPayloadBytes
		chunkLen := uint64(nilfsScalarPayloadBytes)
		base := uint64(1)
		if remaining < chunkLen {
			chunkLen = remaining
			base = uint64(nilfsScalarBytes) - chunkLen
		}
		start := scalarIdx*nilfsScalarBytes + base
		end := start + chunkLen
		if end > uint64(len(encoded)) {
			return nil, fmt.Errorf("encoded payload out of bounds: scalar=%d end=%d", scalarIdx, end)
		}
		copy(out[outOff:outOff+chunkLen], encoded[start:end])
		outOff += chunkLen
	}
	return out, nil
}

func mode2BuildArtifacts(ctx context.Context, filePath string, dealID uint64, hint string, fileRecordPath string) (*mode2IngestResult, string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	stripe, err := stripeParamsFromHint(hint)
	if err != nil {
		return nil, "", fmt.Errorf("parse service_hint: %w", err)
	}
	if stripe.mode != 2 || stripe.k == 0 || stripe.m == 0 || stripe.rows == 0 {
		return nil, "", fmt.Errorf("deal is not Mode 2")
	}

	fi, err := os.Stat(filePath)
	if err != nil {
		return nil, "", err
	}
	fileSize := uint64(fi.Size())
	userMdus := uint64(1)
	if fileSize > 0 {
		userMdus = (fileSize + RawMduCapacity - 1) / RawMduCapacity
		if userMdus == 0 {
			userMdus = 1
		}
	}

	if fileRecordPath == "" {
		fileRecordPath = filepath.Base(filePath)
	}
	if len(fileRecordPath) > 40 {
		fileRecordPath = fileRecordPath[:40]
	}

	commitmentsPerMdu := stripe.leafCount
	builder := crypto_ffi.NewMdu0BuilderWithCommitments(userMdus, commitmentsPerMdu)
	if builder == nil {
		return nil, "", fmt.Errorf("failed to create MDU0 builder")
	}
	defer builder.Free()
	witnessCount := builder.GetWitnessCount()
	totalSteps := userMdus + witnessCount + 2
	job := uploadJobFromContext(ctx)
	if job != nil {
		job.setPhase(uploadJobPhaseEncoding, "Gateway Mode 2: encoding stripes...")
		job.setSteps(0, totalSteps)
	}

	// Stage artifacts under uploads/deals/<dealID>/.staging-<ts>/, then atomically rename to the manifest-root key.
	baseDealDir := filepath.Join(uploadDir, "deals", strconv.FormatUint(dealID, 10))
	if err := os.MkdirAll(baseDealDir, 0o755); err != nil {
		return nil, "", err
	}
	stagingDir, err := os.MkdirTemp(baseDealDir, "staging-")
	if err != nil {
		return nil, "", err
	}
	rollback := true
	defer func() {
		if rollback {
			_ = os.RemoveAll(stagingDir)
		}
	}()

	userRoots := make([][]byte, userMdus)
	witnessFlats := make([][]byte, userMdus)

	f, err := os.Open(filePath)
	if err != nil {
		return nil, "", err
	}
	defer f.Close()

	rawBuf := make([]byte, RawMduCapacity)
	{
		parallelism := mode2EncodeParallelism()
		eg, egctx := errgroup.WithContext(ctx)
		eg.SetLimit(parallelism)

		var completed atomic.Uint64

		for i := uint64(0); i < userMdus; i++ {
			if err := egctx.Err(); err != nil {
				return nil, "", err
			}

			n, readErr := io.ReadFull(f, rawBuf)
			if readErr != nil {
				if readErr == io.ErrUnexpectedEOF || readErr == io.EOF {
					// Last chunk is short (or empty).
				} else {
					return nil, "", readErr
				}
			}

			chunk := make([]byte, n)
			copy(chunk, rawBuf[:n])
			i := i

			eg.Go(func() error {
				if err := egctx.Err(); err != nil {
					return err
				}

				witnessFlat, shards, err := crypto_ffi.ExpandPayloadRs(chunk, stripe.k, stripe.m)
				if err != nil {
					return fmt.Errorf("expand mdu %d: %w", i, err)
				}
				root, err := crypto_ffi.ComputeMduRootFromWitnessFlat(witnessFlat)
				if err != nil {
					return fmt.Errorf("compute mdu root %d: %w", i, err)
				}
				userRoots[i] = root
				witnessFlats[i] = witnessFlat

				slabIndex := uint64(1) + witnessCount + i
				for slot := uint64(0); slot < stripe.slotCount; slot++ {
					if int(slot) >= len(shards) {
						return fmt.Errorf("missing shard for slot %d", slot)
					}
					name := fmt.Sprintf("mdu_%d_slot_%d.bin", slabIndex, slot)
					if err := os.WriteFile(filepath.Join(stagingDir, name), shards[slot], 0o644); err != nil {
						return err
					}
				}

				next := completed.Add(1)
				if job != nil {
					job.setSteps(next, totalSteps)
				}

				return nil
			})
		}

		if err := eg.Wait(); err != nil {
			return nil, "", err
		}
	}

	witnessBytesPerUser := uint64(0)
	for i := uint64(0); i < userMdus; i++ {
		root := userRoots[i]
		if len(root) == 0 {
			return nil, "", fmt.Errorf("missing user root %d", i)
		}
		if err := builder.SetRoot(witnessCount+i, root); err != nil {
			return nil, "", fmt.Errorf("set user root %d: %w", i, err)
		}

		wf := witnessFlats[i]
		if len(wf) == 0 {
			return nil, "", fmt.Errorf("missing witness_flat %d", i)
		}
		if witnessBytesPerUser == 0 {
			witnessBytesPerUser = uint64(len(wf))
		} else if witnessBytesPerUser != uint64(len(wf)) {
			return nil, "", fmt.Errorf("witness_flat length mismatch (want %d, got %d)", witnessBytesPerUser, len(wf))
		}
	}

	witnessBytes := make([]byte, 0, userMdus*witnessBytesPerUser)
	for i := uint64(0); i < userMdus; i++ {
		witnessBytes = append(witnessBytes, witnessFlats[i]...)
	}

	// Build witness MDUs from the concatenated witness commitments.
	witnessRoots := make([][]byte, 0, witnessCount)
	for i := uint64(0); i < witnessCount; i++ {
		start := i * RawMduCapacity
		end := start + RawMduCapacity
		var chunk []byte
		if start >= uint64(len(witnessBytes)) {
			chunk = nil
		} else {
			if end > uint64(len(witnessBytes)) {
				end = uint64(len(witnessBytes))
			}
			chunk = witnessBytes[start:end]
		}
		encoded := encodePayloadToMdu(chunk)
		root, err := crypto_ffi.ComputeMduMerkleRoot(encoded)
		if err != nil {
			return nil, "", fmt.Errorf("compute witness root %d: %w", i, err)
		}
		witnessRoots = append(witnessRoots, root)
		if err := builder.SetRoot(i, root); err != nil {
			return nil, "", fmt.Errorf("set witness root %d: %w", i, err)
		}
		if err := os.WriteFile(filepath.Join(stagingDir, fmt.Sprintf("mdu_%d.bin", 1+i)), encoded, 0o644); err != nil {
			return nil, "", err
		}
		if job != nil {
			job.setSteps(userMdus+i+1, totalSteps)
		}
	}

	// Append the file record (naive single-file mapping at offset 0 for now).
	if err := builder.AppendFile(fileRecordPath, fileSize, 0); err != nil {
		return nil, "", err
	}
	sizeBytes := totalSizeBytesFromMdu0(builder)

	// Write MDU #0 and compute its root.
	mdu0Bytes, err := builder.Bytes()
	if err != nil {
		return nil, "", err
	}
	if err := os.WriteFile(filepath.Join(stagingDir, "mdu_0.bin"), mdu0Bytes, 0o644); err != nil {
		return nil, "", err
	}
	mdu0Root, err := crypto_ffi.ComputeMduMerkleRoot(mdu0Bytes)
	if err != nil {
		return nil, "", fmt.Errorf("compute mdu0 root: %w", err)
	}

	roots := make([][]byte, 0, 1+len(witnessRoots)+len(userRoots))
	roots = append(roots, mdu0Root)
	roots = append(roots, witnessRoots...)
	roots = append(roots, userRoots...)

	commitment, manifestBlob, err := crypto_ffi.ComputeManifestCommitment(roots)
	if err != nil {
		return nil, "", fmt.Errorf("compute manifest commitment: %w", err)
	}
	manifestRootHex := "0x" + hex.EncodeToString(commitment)
	parsedRoot, err := parseManifestRoot(manifestRootHex)
	if err != nil {
		return nil, "", err
	}
	if err := os.WriteFile(filepath.Join(stagingDir, "manifest.bin"), manifestBlob, 0o644); err != nil {
		return nil, "", err
	}

	finalDir := dealScopedDir(dealID, parsedRoot)
	if err := os.MkdirAll(filepath.Dir(finalDir), 0o755); err != nil {
		return nil, "", err
	}
	if err := os.Rename(stagingDir, finalDir); err != nil {
		return nil, "", err
	}
	rollback = false
	if job != nil {
		job.setSteps(totalSteps, totalSteps)
	}

	return &mode2IngestResult{
		manifestRoot:    parsedRoot,
		manifestBlob:    manifestBlob,
		allocatedLength: uint64(len(roots)),
		fileSize:        fileSize,
		sizeBytes:       sizeBytes,
		witnessMdus:     witnessCount,
		userMdus:        userMdus,
	}, finalDir, nil
}

func mode2EncodeParallelism() int {
	raw := strings.TrimSpace(os.Getenv("NIL_MODE2_ENCODE_PARALLELISM"))
	if raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			return parsed
		}
	}
	if n := runtime.GOMAXPROCS(0); n > 0 {
		return n
	}
	return 1
}

func mode2BuildArtifactsAppend(
	ctx context.Context,
	filePath string,
	dealID uint64,
	hint string,
	existingManifestRoot string,
	fileRecordPath string,
) (*mode2IngestResult, string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	stripe, err := stripeParamsFromHint(hint)
	if err != nil {
		return nil, "", fmt.Errorf("parse service_hint: %w", err)
	}
	if stripe.mode != 2 || stripe.k == 0 || stripe.m == 0 || stripe.rows == 0 {
		return nil, "", fmt.Errorf("deal is not Mode 2")
	}

	parsedExisting, err := parseManifestRoot(existingManifestRoot)
	if err != nil {
		return nil, "", err
	}
	oldDir, err := resolveDealDirForDeal(dealID, parsedExisting, existingManifestRoot)
	if err != nil {
		return nil, "", fmt.Errorf("failed to resolve existing slab dir: %w", err)
	}
	oldMdu0Bytes, err := os.ReadFile(filepath.Join(oldDir, "mdu_0.bin"))
	if err != nil {
		return nil, "", fmt.Errorf("failed to read existing MDU #0: %w", err)
	}

	commitmentsPerMdu := stripe.leafCount
	tmpBuilder, err := crypto_ffi.LoadMdu0BuilderWithCommitments(oldMdu0Bytes, 1, commitmentsPerMdu)
	if err != nil {
		return nil, "", fmt.Errorf("failed to parse existing MDU #0: %w", err)
	}

	var maxEnd uint64
	recordCount := tmpBuilder.GetRecordCount()
	for i := uint32(0); i < recordCount; i++ {
		rec, err := tmpBuilder.GetRecord(i)
		if err != nil {
			continue
		}
		if rec.Path[0] == 0 {
			continue
		}
		length, _ := crypto_ffi.UnpackLengthAndFlags(rec.LengthAndFlags)
		end := rec.StartOffset + length
		if end > maxEnd {
			maxEnd = end
		}
	}
	tmpBuilder.Free()

	oldUserMdus := uint64(0)
	if maxEnd > 0 {
		oldUserMdus = (maxEnd + RawMduCapacity - 1) / RawMduCapacity
	}
	if oldUserMdus == 0 {
		return nil, "", fmt.Errorf("existing Mode 2 slab has no user MDUs")
	}

	fi, err := os.Stat(filePath)
	if err != nil {
		return nil, "", err
	}
	newFileSize := uint64(fi.Size())
	newUserMdus := uint64(1)
	if newFileSize > 0 {
		newUserMdus = (newFileSize + RawMduCapacity - 1) / RawMduCapacity
		if newUserMdus == 0 {
			newUserMdus = 1
		}
	}
	totalUserMdus := oldUserMdus + newUserMdus

	if fileRecordPath == "" {
		fileRecordPath = filepath.Base(filePath)
	}
	if len(fileRecordPath) > 40 {
		fileRecordPath = fileRecordPath[:40]
	}

	// Stage artifacts under uploads/deals/<dealID>/.staging-<ts>/, then atomically rename to the manifest-root key.
	baseDealDir := filepath.Join(uploadDir, "deals", strconv.FormatUint(dealID, 10))
	if err := os.MkdirAll(baseDealDir, 0o755); err != nil {
		return nil, "", err
	}
	stagingDir, err := os.MkdirTemp(baseDealDir, "staging-")
	if err != nil {
		return nil, "", err
	}
	rollback := true
	defer func() {
		if rollback {
			_ = os.RemoveAll(stagingDir)
		}
	}()

	// Determine witness counts using the same formula as the MDU0 builder.
	oldWBuilder := crypto_ffi.NewMdu0BuilderWithCommitments(oldUserMdus, commitmentsPerMdu)
	oldWitnessCount := oldWBuilder.GetWitnessCount()
	oldWBuilder.Free()

	newWBuilder := crypto_ffi.NewMdu0BuilderWithCommitments(totalUserMdus, commitmentsPerMdu)
	witnessCount := newWBuilder.GetWitnessCount()
	newWBuilder.Free()

	totalSteps := newUserMdus + witnessCount + 2
	job := uploadJobFromContext(ctx)
	if job != nil {
		job.setPhase(uploadJobPhaseEncoding, "Gateway Mode 2: encoding append...")
		job.setSteps(0, totalSteps)
	}

	// Copy existing user shards into staging so the new manifest root is fully materialized on providers.
	for userIdx := uint64(0); userIdx < oldUserMdus; userIdx++ {
		oldSlabIndex := uint64(1) + oldWitnessCount + userIdx
		newSlabIndex := uint64(1) + witnessCount + userIdx
		for slot := uint64(0); slot < stripe.slotCount; slot++ {
			src := filepath.Join(oldDir, fmt.Sprintf("mdu_%d_slot_%d.bin", oldSlabIndex, slot))
			dst := filepath.Join(stagingDir, fmt.Sprintf("mdu_%d_slot_%d.bin", newSlabIndex, slot))
			if err := copyFile(src, dst); err != nil {
				return nil, "", fmt.Errorf("failed to copy existing shard (mdu=%d slot=%d): %w", oldSlabIndex, slot, err)
			}
		}
	}

	// Decode existing witness commitments so we can rebuild witness MDUs and preserve old user roots.
	witnessBytesPerUser := uint64(commitmentsPerMdu) * 48
	oldWitnessBytesTotal := oldUserMdus * witnessBytesPerUser
	oldWitnessBytes := make([]byte, 0, oldWitnessBytesTotal)
	for i := uint64(0); i < oldWitnessCount; i++ {
		path := filepath.Join(oldDir, fmt.Sprintf("mdu_%d.bin", 1+i))
		encoded, err := os.ReadFile(path)
		if err != nil {
			return nil, "", fmt.Errorf("failed to read existing witness mdu %d: %w", i, err)
		}
		start := i * RawMduCapacity
		var segLen uint64
		if start >= oldWitnessBytesTotal {
			segLen = 0
		} else {
			segLen = oldWitnessBytesTotal - start
			if segLen > RawMduCapacity {
				segLen = RawMduCapacity
			}
		}
		decoded, err := decodePayloadFromMdu(encoded, segLen)
		if err != nil {
			return nil, "", fmt.Errorf("failed to decode witness mdu %d: %w", i, err)
		}
		oldWitnessBytes = append(oldWitnessBytes, decoded...)
	}
	if uint64(len(oldWitnessBytes)) > oldWitnessBytesTotal {
		oldWitnessBytes = oldWitnessBytes[:oldWitnessBytesTotal]
	}
	if uint64(len(oldWitnessBytes)) != oldWitnessBytesTotal {
		return nil, "", fmt.Errorf("decoded witness bytes mismatch (expected %d, got %d)", oldWitnessBytesTotal, len(oldWitnessBytes))
	}

	// Load existing MDU0 (preserves file table), then append the new file record.
	builder, err := crypto_ffi.LoadMdu0BuilderWithCommitments(oldMdu0Bytes, totalUserMdus, commitmentsPerMdu)
	if err != nil {
		return nil, "", fmt.Errorf("failed to load existing MDU0 builder: %w", err)
	}
	defer builder.Free()
	if builder.GetWitnessCount() != witnessCount {
		return nil, "", fmt.Errorf("witness_count mismatch (expected %d, got %d)", witnessCount, builder.GetWitnessCount())
	}

	newFileOffset := oldUserMdus * RawMduCapacity
	if err := builder.AppendFile(fileRecordPath, newFileSize, newFileOffset); err != nil {
		return nil, "", fmt.Errorf("append file record failed: %w", err)
	}
	sizeBytes := totalSizeBytesFromMdu0(builder)

	// Read and shard the new file into fresh stripes + witness commitments.
	f, err := os.Open(filePath)
	if err != nil {
		return nil, "", err
	}
	defer f.Close()
	rawBuf := make([]byte, RawMduCapacity)
	newUserRoots := make([][]byte, newUserMdus)
	newWitnessFlats := make([][]byte, newUserMdus)
	{
		parallelism := mode2EncodeParallelism()
		eg, egctx := errgroup.WithContext(ctx)
		eg.SetLimit(parallelism)
		var completed atomic.Uint64

		for i := uint64(0); i < newUserMdus; i++ {
			if err := egctx.Err(); err != nil {
				return nil, "", err
			}
			n, readErr := io.ReadFull(f, rawBuf)
			if readErr != nil {
				if readErr == io.ErrUnexpectedEOF || readErr == io.EOF {
					// Last chunk is short (or empty).
				} else {
					return nil, "", readErr
				}
			}

			chunk := make([]byte, n)
			copy(chunk, rawBuf[:n])
			i := i

			eg.Go(func() error {
				if err := egctx.Err(); err != nil {
					return err
				}

				witnessFlat, shards, err := crypto_ffi.ExpandPayloadRs(chunk, stripe.k, stripe.m)
				if err != nil {
					return fmt.Errorf("expand new mdu %d: %w", i, err)
				}
				if uint64(len(witnessFlat)) != witnessBytesPerUser {
					return fmt.Errorf("unexpected witness_flat length (want %d, got %d)", witnessBytesPerUser, len(witnessFlat))
				}
				root, err := crypto_ffi.ComputeMduRootFromWitnessFlat(witnessFlat)
				if err != nil {
					return fmt.Errorf("compute new mdu root %d: %w", i, err)
				}
				newUserRoots[i] = root
				newWitnessFlats[i] = witnessFlat

				userIdx := oldUserMdus + i
				slabIndex := uint64(1) + witnessCount + userIdx
				for slot := uint64(0); slot < stripe.slotCount; slot++ {
					if int(slot) >= len(shards) {
						return fmt.Errorf("missing shard for slot %d", slot)
					}
					name := fmt.Sprintf("mdu_%d_slot_%d.bin", slabIndex, slot)
					if err := os.WriteFile(filepath.Join(stagingDir, name), shards[slot], 0o644); err != nil {
						return err
					}
				}

				next := completed.Add(1)
				if job != nil {
					job.setSteps(next, totalSteps)
				}
				return nil
			})
		}

		if err := eg.Wait(); err != nil {
			return nil, "", err
		}
	}

	newWitnessBytes := make([]byte, 0, newUserMdus*witnessBytesPerUser)
	for i := uint64(0); i < newUserMdus; i++ {
		wf := newWitnessFlats[i]
		if uint64(len(wf)) != witnessBytesPerUser {
			return nil, "", fmt.Errorf("missing witness_flat %d", i)
		}
		newWitnessBytes = append(newWitnessBytes, wf...)
	}

	// Recompute all user roots + rebuild witness MDUs from concatenated witness commitments.
	totalWitnessBytes := make([]byte, 0, totalUserMdus*witnessBytesPerUser)
	totalWitnessBytes = append(totalWitnessBytes, oldWitnessBytes...)
	totalWitnessBytes = append(totalWitnessBytes, newWitnessBytes...)
	if uint64(len(totalWitnessBytes)) != totalUserMdus*witnessBytesPerUser {
		return nil, "", fmt.Errorf("witness bytes mismatch (expected %d, got %d)", totalUserMdus*witnessBytesPerUser, len(totalWitnessBytes))
	}

	userRoots := make([][]byte, 0, totalUserMdus)
	for userIdx := uint64(0); userIdx < oldUserMdus; userIdx++ {
		start := userIdx * witnessBytesPerUser
		end := start + witnessBytesPerUser
		witnessFlat := totalWitnessBytes[start:end]
		root, err := crypto_ffi.ComputeMduRootFromWitnessFlat(witnessFlat)
		if err != nil {
			return nil, "", fmt.Errorf("compute existing user root %d: %w", userIdx, err)
		}
		userRoots = append(userRoots, root)
	}
	userRoots = append(userRoots, newUserRoots...)

	// Build witness MDUs from the concatenated witness commitments.
	witnessRoots := make([][]byte, 0, witnessCount)
	for i := uint64(0); i < witnessCount; i++ {
		start := i * RawMduCapacity
		end := start + RawMduCapacity
		var chunk []byte
		if start >= uint64(len(totalWitnessBytes)) {
			chunk = nil
		} else {
			if end > uint64(len(totalWitnessBytes)) {
				end = uint64(len(totalWitnessBytes))
			}
			chunk = totalWitnessBytes[start:end]
		}
		encoded := encodePayloadToMdu(chunk)
		root, err := crypto_ffi.ComputeMduMerkleRoot(encoded)
		if err != nil {
			return nil, "", fmt.Errorf("compute witness root %d: %w", i, err)
		}
		witnessRoots = append(witnessRoots, root)
		if err := builder.SetRoot(i, root); err != nil {
			return nil, "", fmt.Errorf("set witness root %d: %w", i, err)
		}
		if err := os.WriteFile(filepath.Join(stagingDir, fmt.Sprintf("mdu_%d.bin", 1+i)), encoded, 0o644); err != nil {
			return nil, "", err
		}
		if job != nil {
			job.setSteps(newUserMdus+i+1, totalSteps)
		}
	}

	// Write user roots into MDU0 (starting after witness roots).
	for i, root := range userRoots {
		if err := builder.SetRoot(witnessCount+uint64(i), root); err != nil {
			return nil, "", fmt.Errorf("set user root %d: %w", i, err)
		}
	}

	// Write MDU #0 and compute its root.
	mdu0Bytes, err := builder.Bytes()
	if err != nil {
		return nil, "", err
	}
	if err := os.WriteFile(filepath.Join(stagingDir, "mdu_0.bin"), mdu0Bytes, 0o644); err != nil {
		return nil, "", err
	}
	mdu0Root, err := crypto_ffi.ComputeMduMerkleRoot(mdu0Bytes)
	if err != nil {
		return nil, "", fmt.Errorf("compute mdu0 root: %w", err)
	}

	roots := make([][]byte, 0, 1+len(witnessRoots)+len(userRoots))
	roots = append(roots, mdu0Root)
	roots = append(roots, witnessRoots...)
	roots = append(roots, userRoots...)

	commitment, manifestBlob, err := crypto_ffi.ComputeManifestCommitment(roots)
	if err != nil {
		return nil, "", fmt.Errorf("compute manifest commitment: %w", err)
	}
	manifestRootHex := "0x" + hex.EncodeToString(commitment)
	parsedRoot, err := parseManifestRoot(manifestRootHex)
	if err != nil {
		return nil, "", err
	}
	if err := os.WriteFile(filepath.Join(stagingDir, "manifest.bin"), manifestBlob, 0o644); err != nil {
		return nil, "", err
	}

	finalDir := dealScopedDir(dealID, parsedRoot)
	if err := os.MkdirAll(filepath.Dir(finalDir), 0o755); err != nil {
		return nil, "", err
	}
	if err := os.Rename(stagingDir, finalDir); err != nil {
		return nil, "", err
	}
	rollback = false
	if job != nil {
		job.setSteps(totalSteps, totalSteps)
	}

	return &mode2IngestResult{
		manifestRoot:    parsedRoot,
		manifestBlob:    manifestBlob,
		allocatedLength: uint64(len(roots)),
		fileSize:        newFileSize,
		sizeBytes:       sizeBytes,
		witnessMdus:     witnessCount,
		userMdus:        totalUserMdus,
	}, finalDir, nil
}

func mode2UploadArtifactsToProviders(
	ctx context.Context,
	dealID uint64,
	manifestRoot ManifestRoot,
	hint string,
	finalDir string,
	witnessCount uint64,
	userMdus uint64,
) error {
	if ctx == nil {
		ctx = context.Background()
	}
	stripe, err := stripeParamsFromHint(hint)
	if err != nil {
		return fmt.Errorf("parse service_hint: %w", err)
	}
	if stripe.mode != 2 || stripe.k == 0 || stripe.m == 0 || stripe.rows == 0 {
		return fmt.Errorf("deal is not Mode 2")
	}
	if witnessCount == 0 || stripe.slotCount == 0 {
		return fmt.Errorf("invalid Mode 2 state")
	}

	job := uploadJobFromContext(ctx)
	totalUploads := stripe.slotCount * (witnessCount + 2 + userMdus)
	if job != nil {
		job.setPhase(uploadJobPhaseUploading, "Gateway Mode 2: uploading to providers...")
		job.setSteps(0, totalUploads)
	}
	var uploaded atomic.Uint64
	bump := func() {
		next := uploaded.Add(1)
		if job != nil {
			job.setSteps(next, totalUploads)
		}
	}

	// Upload to assigned providers as a dumb pipe: bytes-in/bytes-out.
	providers, err := fetchDealProvidersFromLCD(ctx, dealID)
	if err != nil {
		return err
	}
	if len(providers) < int(stripe.slotCount) {
		return fmt.Errorf("not enough providers for Mode 2 (need %d, got %d)", stripe.slotCount, len(providers))
	}
	slotBases := make([]string, stripe.slotCount)
	{
		eg, egctx := errgroup.WithContext(ctx)
		eg.SetLimit(int(stripe.slotCount))
		for slot := uint64(0); slot < stripe.slotCount; slot++ {
			slot := int(slot)
			provider := providers[slot]
			eg.Go(func() error {
				base, err := resolveProviderHTTPBaseURL(egctx, provider)
				if err != nil {
					return err
				}
				slotBases[slot] = strings.TrimRight(base, "/")
				return nil
			})
		}
		if err := eg.Wait(); err != nil {
			return err
		}
	}

	transport := &http.Transport{
		MaxIdleConns:        256,
		MaxIdleConnsPerHost: 32,
		IdleConnTimeout:     90 * time.Second,
	}
	client := &http.Client{Timeout: 60 * time.Second, Transport: transport}
	manifestRootCanonical := manifestRoot.Canonical
	dealIDStr := strconv.FormatUint(dealID, 10)

	uploadBlob := func(ctx context.Context, url string, setHeaders func(*http.Request), path string, maxBytes int64) error {
		fi, err := os.Stat(path)
		if err != nil {
			return err
		}
		if maxBytes > 0 && fi.Size() > maxBytes {
			return fmt.Errorf("artifact too large: %s (%d bytes)", filepath.Base(path), fi.Size())
		}
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()

		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, f)
		if err != nil {
			return err
		}
		req.ContentLength = fi.Size()
		req.Header.Set("Content-Type", "application/octet-stream")
		if setHeaders != nil {
			setHeaders(req)
		}

		resp, err := client.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			msg, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
			return fmt.Errorf("upload failed: %s (%s)", resp.Status, strings.TrimSpace(string(msg)))
		}
		return nil
	}

	eg, egctx := errgroup.WithContext(ctx)
	eg.SetLimit(int(stripe.slotCount))
	for slot := uint64(0); slot < stripe.slotCount; slot++ {
		slot := int(slot)
		base := slotBases[slot]
		eg.Go(func() error {
			// Replicated metadata: mdu_0..mdu_witnessCount + manifest.bin to all slots.
			for mduIndex := uint64(0); mduIndex <= witnessCount; mduIndex++ {
				path := filepath.Join(finalDir, fmt.Sprintf("mdu_%d.bin", mduIndex))
				if err := uploadBlob(egctx, base+"/sp/upload_mdu", func(req *http.Request) {
					req.Header.Set("X-Nil-Deal-ID", dealIDStr)
					req.Header.Set("X-Nil-Mdu-Index", strconv.FormatUint(mduIndex, 10))
					req.Header.Set("X-Nil-Manifest-Root", manifestRootCanonical)
				}, path, 10<<20); err != nil {
					return err
				}
				bump()
			}

			if err := uploadBlob(egctx, base+"/sp/upload_manifest", func(req *http.Request) {
				req.Header.Set("X-Nil-Deal-ID", dealIDStr)
				req.Header.Set("X-Nil-Manifest-Root", manifestRootCanonical)
			}, filepath.Join(finalDir, "manifest.bin"), 512<<10); err != nil {
				return err
			}
			bump()

			// Striped user shards for this slot only.
			for i := uint64(0); i < userMdus; i++ {
				slabIndex := uint64(1) + witnessCount + i
				path := filepath.Join(finalDir, fmt.Sprintf("mdu_%d_slot_%d.bin", slabIndex, slot))
				if err := uploadBlob(egctx, base+"/sp/upload_shard", func(req *http.Request) {
					req.Header.Set("X-Nil-Deal-ID", dealIDStr)
					req.Header.Set("X-Nil-Mdu-Index", strconv.FormatUint(slabIndex, 10))
					req.Header.Set("X-Nil-Slot", strconv.Itoa(slot))
					req.Header.Set("X-Nil-Manifest-Root", manifestRootCanonical)
				}, path, 10<<20); err != nil {
					return err
				}
				bump()
			}
			return nil
		})
	}
	return eg.Wait()
}

func mode2IngestAndUploadNewDeal(ctx context.Context, filePath string, dealID uint64, hint string, fileRecordPath string) (*mode2IngestResult, error) {
	res, finalDir, err := mode2BuildArtifacts(ctx, filePath, dealID, hint, fileRecordPath)
	if err != nil {
		return nil, err
	}
	if err := mode2UploadArtifactsToProviders(ctx, dealID, res.manifestRoot, hint, finalDir, res.witnessMdus, res.userMdus); err != nil {
		return nil, err
	}
	return res, nil
}

func mode2IngestAndUploadAppendToDeal(ctx context.Context, filePath string, dealID uint64, hint string, existingManifestRoot string, fileRecordPath string) (*mode2IngestResult, error) {
	res, finalDir, err := mode2BuildArtifactsAppend(ctx, filePath, dealID, hint, existingManifestRoot, fileRecordPath)
	if err != nil {
		return nil, err
	}
	if err := mode2UploadArtifactsToProviders(ctx, dealID, res.manifestRoot, hint, finalDir, res.witnessMdus, res.userMdus); err != nil {
		return nil, err
	}
	return res, nil
}

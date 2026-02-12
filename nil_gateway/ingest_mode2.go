package main

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
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

type providerUploadHTTPError struct {
	statusCode int
	status     string
	body       string
}

func (e *providerUploadHTTPError) Error() string {
	if e == nil {
		return "upload failed"
	}
	msg := strings.TrimSpace(e.body)
	if msg == "" {
		return fmt.Sprintf("upload failed: %s", e.status)
	}
	return fmt.Sprintf("upload failed: %s (%s)", e.status, msg)
}

const mode2SlabCompleteMarker = ".slab_complete"

func mode2DirLooksComplete(dir string) bool {
	if dir == "" {
		return false
	}
	if _, err := os.Stat(filepath.Join(dir, mode2SlabCompleteMarker)); err == nil {
		return true
	}
	manifestPath := filepath.Join(dir, "manifest.bin")
	mdu0Path := filepath.Join(dir, "mdu_0.bin")
	manifestInfo, errManifest := os.Stat(manifestPath)
	if errManifest != nil {
		return false
	}
	mdu0Info, errMdu0 := os.Stat(mdu0Path)
	if errMdu0 != nil {
		return false
	}
	if !mdu0Info.Mode().IsRegular() || mdu0Info.Size() != int64(types.MDU_SIZE) {
		return false
	}
	// Manifest should be small (currently 128 KiB), but keep the bound permissive for future
	// upgrades so older slabs still look "complete" to idempotency logic.
	if !manifestInfo.Mode().IsRegular() || manifestInfo.Size() <= 0 || manifestInfo.Size() > 1<<20 {
		return false
	}
	return true
}

func mode2EnsureCompleteMarker(dir string) {
	if dir == "" {
		return
	}
	markerPath := filepath.Join(dir, mode2SlabCompleteMarker)
	if _, err := os.Stat(markerPath); err == nil {
		return
	}
	if err := os.WriteFile(markerPath, []byte("ok\n"), 0o644); err != nil {
		return
	}
}

func mode2BuildArtifacts(ctx context.Context, filePath string, dealID uint64, hint string, fileRecordPath string, fileFlags uint8) (*mode2IngestResult, string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	profile := mode2UploadProfileFromContext(ctx)
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
	if profile != nil {
		profile.setCount("mode2_user_mdus", userMdus)
		profile.setCount("mode2_witness_mdus", witnessCount)
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

	encodeStarted := time.Now()
	{
		bufPool := sync.Pool{
			New: func() any {
				return make([]byte, RawMduCapacity)
			},
		}

		parallelism := mode2EncodeParallelism()
		eg, egctx := errgroup.WithContext(ctx)
		eg.SetLimit(parallelism)

		var completed atomic.Uint64

		for i := uint64(0); i < userMdus; i++ {
			if err := egctx.Err(); err != nil {
				return nil, "", err
			}

			buf := bufPool.Get().([]byte)
			n, readErr := io.ReadFull(f, buf)
			if readErr != nil {
				if readErr == io.ErrUnexpectedEOF || readErr == io.EOF {
					// Last chunk is short (or empty).
				} else {
					bufPool.Put(buf)
					return nil, "", readErr
				}
			}

			i := i

			{
				buf := buf
				n := n
				eg.Go(func() error {
					defer bufPool.Put(buf)

					if err := egctx.Err(); err != nil {
						return err
					}

					chunk := buf[:n]
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
		}

		if err := eg.Wait(); err != nil {
			return nil, "", err
		}
	}
	if profile != nil {
		profile.addDuration("mode2_encode_user_mdus_ms", time.Since(encodeStarted))
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
	witnessStarted := time.Now()
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
		encoded, err := crypto_ffi.EncodePayloadToMdu(chunk)
		if err != nil {
			return nil, "", fmt.Errorf("encode witness mdu %d: %w", i, err)
		}
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
	if profile != nil {
		profile.addDuration("mode2_build_witness_mdus_ms", time.Since(witnessStarted))
	}

	// Append the file record (naive single-file mapping at offset 0 for now).
	if err := builder.AppendFileWithFlags(fileRecordPath, fileSize, 0, fileFlags); err != nil {
		return nil, "", err
	}
	sizeBytes := totalSizeBytesFromMdu0(builder)

	manifestStarted := time.Now()
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
	if err := os.WriteFile(filepath.Join(stagingDir, mode2SlabCompleteMarker), []byte("ok\n"), 0o644); err != nil {
		return nil, "", err
	}
	if profile != nil {
		profile.addDuration("mode2_build_manifest_ms", time.Since(manifestStarted))
	}

	finalDir := dealScopedDir(dealID, parsedRoot)
	if err := os.MkdirAll(filepath.Dir(finalDir), 0o755); err != nil {
		return nil, "", err
	}
	finalizeStarted := time.Now()
	if err := mode2FinalizeStagingDir(stagingDir, finalDir); err != nil {
		return nil, "", err
	}
	if profile != nil {
		profile.addDuration("mode2_finalize_dir_ms", time.Since(finalizeStarted))
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

func mode2UploadParallelism(slotCount uint64) int {
	raw := strings.TrimSpace(os.Getenv("NIL_MODE2_UPLOAD_PARALLELISM"))
	if raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			return parsed
		}
	}
	// Default sequential-by-design while we optimize single upload performance.
	// Operators can opt in to parallel uploads via NIL_MODE2_UPLOAD_PARALLELISM.
	_ = slotCount
	return 1
}

func mode2ExpectContinueTimeout() time.Duration {
	raw := strings.TrimSpace(os.Getenv("NIL_MODE2_EXPECT_CONTINUE_MS"))
	if raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			if parsed <= 0 {
				return 0
			}
			return time.Duration(parsed) * time.Millisecond
		}
	}
	// Keep a short pause for early 4xx/5xx rejects without paying a multi-second
	// RTT penalty per upload request.
	return 250 * time.Millisecond
}

func mode2SparseUploadEnabled() bool {
	raw := strings.TrimSpace(os.Getenv("NIL_MODE2_SPARSE_UPLOAD"))
	if raw == "" {
		return true
	}
	switch strings.ToLower(raw) {
	case "0", "false", "no", "off":
		return false
	default:
		return true
	}
}

func mode2SparsePayloadLength(path string, maxBytes int64) (fullSize int64, sendSize int64, err error) {
	fi, err := os.Stat(path)
	if err != nil {
		return 0, 0, err
	}
	fullSize = fi.Size()
	if maxBytes > 0 && fullSize > maxBytes {
		return 0, 0, fmt.Errorf("artifact too large: %s (%d bytes)", filepath.Base(path), fullSize)
	}
	if fullSize <= 0 {
		return fullSize, fullSize, nil
	}

	buf, err := os.ReadFile(path)
	if err != nil {
		return 0, 0, err
	}
	send := len(buf)
	for send > 0 && buf[send-1] == 0 {
		send--
	}
	// Preserve a non-empty upload body so existing transport/server logic keeps working.
	if send == 0 && fullSize > 0 {
		send = 1
	}

	return fullSize, int64(send), nil
}

type limitedReadCloser struct {
	io.Reader
	io.Closer
}

func mode2FinalizeStagingDir(stagingDir string, finalDir string) error {
	lockPath := filepath.Join(filepath.Dir(finalDir), "."+filepath.Base(finalDir)+".lock")
	lockHeld := false

	acquireLock := func() error {
		// Fast-path: if the slab is already complete, there's nothing to finalize.
		if mode2DirLooksComplete(finalDir) {
			mode2EnsureCompleteMarker(finalDir)
			_ = os.RemoveAll(stagingDir)
			return nil
		}

		const attempts = 80
		for i := 0; i < attempts; i++ {
			f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
			if err == nil {
				lockHeld = true
				_, _ = f.WriteString("pid=" + strconv.Itoa(os.Getpid()) + "\n")
				_ = f.Close()
				return nil
			}
			if !os.IsExist(err) && !errors.Is(err, os.ErrExist) {
				return fmt.Errorf("failed to acquire slab lock: %w", err)
			}

			// Another process is finalizing. If it completes, treat as idempotent.
			if mode2DirLooksComplete(finalDir) {
				mode2EnsureCompleteMarker(finalDir)
				_ = os.RemoveAll(stagingDir)
				return nil
			}

			// Best-effort stale lock cleanup: if the lock is old and the directory isn't complete,
			// remove the lock so progress can continue after crashes.
			if info, statErr := os.Stat(lockPath); statErr == nil {
				if age := time.Since(info.ModTime()); age > 2*time.Minute {
					_ = os.Remove(lockPath)
				}
			}

			time.Sleep(25 * time.Millisecond)
		}
		return fmt.Errorf("timeout waiting for slab lock %s", lockPath)
	}

	if err := acquireLock(); err != nil {
		return err
	}
	if lockHeld {
		defer func() { _ = os.Remove(lockPath) }()
	}

	if err := os.Rename(stagingDir, finalDir); err != nil {
		// If another attempt already created/finalized the destination, treat this as
		// idempotent success and clean up our staging directory.
		info, statErr := os.Stat(finalDir)
		if statErr != nil {
			// Race: destination disappeared after rename error. Retry once.
			if os.IsNotExist(statErr) {
				if retryErr := os.Rename(stagingDir, finalDir); retryErr == nil {
					return nil
				}
			}
			return err
		}

		if info.IsDir() {
			if mode2DirLooksComplete(finalDir) {
				mode2EnsureCompleteMarker(finalDir)
				_ = os.RemoveAll(stagingDir)
				return nil
			}

			// Best-effort: move staged artifacts into the existing directory (overwriting).
			if mergeErr := mode2MergeStagingIntoFinal(stagingDir, finalDir); mergeErr == nil {
				mode2EnsureCompleteMarker(finalDir)
				return nil
			}

			// Under lock, we can safely replace the incomplete directory with our staged copy.
			if rmErr := os.RemoveAll(finalDir); rmErr != nil && !os.IsNotExist(rmErr) {
				return fmt.Errorf("failed to remove incomplete existing slab dir %s: %w", finalDir, rmErr)
			}
			if retryErr := os.Rename(stagingDir, finalDir); retryErr != nil {
				return retryErr
			}
			mode2EnsureCompleteMarker(finalDir)
			return nil
		}

		// Unexpected: finalDir exists as a file. Best-effort remove and retry.
		if removeErr := os.Remove(finalDir); removeErr == nil {
			if retryErr := os.Rename(stagingDir, finalDir); retryErr != nil {
				return retryErr
			}
			return nil
		}

		return err
	}
	return nil
}

func mode2MergeStagingIntoFinal(stagingDir string, finalDir string) error {
	entries, err := os.ReadDir(stagingDir)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		name := entry.Name()
		src := filepath.Join(stagingDir, name)
		dst := filepath.Join(finalDir, name)

		if entry.IsDir() {
			if err := os.MkdirAll(dst, 0o755); err != nil {
				return err
			}
			if err := mode2MergeStagingIntoFinal(src, dst); err != nil {
				return err
			}
			if err := os.RemoveAll(src); err != nil && !os.IsNotExist(err) {
				return err
			}
			continue
		}

		if err := os.Rename(src, dst); err == nil {
			continue
		}

		// Overwrite existing file/dir if present.
		if rmErr := os.RemoveAll(dst); rmErr != nil && !os.IsNotExist(rmErr) {
			return rmErr
		}
		if err := os.Rename(src, dst); err == nil {
			continue
		}

		// Cross-device rename or other edge-case: copy + unlink.
		if err := copyFile(src, dst); err != nil {
			return err
		}
		if err := os.Remove(src); err != nil && !os.IsNotExist(err) {
			return err
		}
	}

	if err := os.RemoveAll(stagingDir); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func mode2BuildArtifactsAppend(
	ctx context.Context,
	filePath string,
	dealID uint64,
	hint string,
	existingManifestRoot string,
	fileRecordPath string,
	fileFlags uint8,
) (*mode2IngestResult, string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	profile := mode2UploadProfileFromContext(ctx)
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
	if profile != nil {
		profile.setCount("mode2_old_user_mdus", oldUserMdus)
		profile.setCount("mode2_new_user_mdus", newUserMdus)
		profile.setCount("mode2_user_mdus", totalUserMdus)
		profile.setCount("mode2_witness_mdus", witnessCount)
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
		decoded, err := crypto_ffi.DecodePayloadFromMdu(encoded, segLen)
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
	if err := builder.AppendFileWithFlags(fileRecordPath, newFileSize, newFileOffset, fileFlags); err != nil {
		return nil, "", fmt.Errorf("append file record failed: %w", err)
	}
	sizeBytes := totalSizeBytesFromMdu0(builder)

	// Read and shard the new file into fresh stripes + witness commitments.
	f, err := os.Open(filePath)
	if err != nil {
		return nil, "", err
	}
	defer f.Close()
	newUserRoots := make([][]byte, newUserMdus)
	newWitnessFlats := make([][]byte, newUserMdus)
	encodeStarted := time.Now()
	{
		bufPool := sync.Pool{
			New: func() any {
				return make([]byte, RawMduCapacity)
			},
		}

		parallelism := mode2EncodeParallelism()
		eg, egctx := errgroup.WithContext(ctx)
		eg.SetLimit(parallelism)
		var completed atomic.Uint64

		for i := uint64(0); i < newUserMdus; i++ {
			if err := egctx.Err(); err != nil {
				return nil, "", err
			}

			buf := bufPool.Get().([]byte)
			n, readErr := io.ReadFull(f, buf)
			if readErr != nil {
				if readErr == io.ErrUnexpectedEOF || readErr == io.EOF {
					// Last chunk is short (or empty).
				} else {
					bufPool.Put(buf)
					return nil, "", readErr
				}
			}

			i := i

			{
				buf := buf
				n := n
				eg.Go(func() error {
					defer bufPool.Put(buf)

					if err := egctx.Err(); err != nil {
						return err
					}

					chunk := buf[:n]
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
		}

		if err := eg.Wait(); err != nil {
			return nil, "", err
		}
	}
	if profile != nil {
		profile.addDuration("mode2_encode_user_mdus_ms", time.Since(encodeStarted))
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
	witnessStarted := time.Now()
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
		encoded, err := crypto_ffi.EncodePayloadToMdu(chunk)
		if err != nil {
			return nil, "", fmt.Errorf("encode witness mdu %d: %w", i, err)
		}
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
	if profile != nil {
		profile.addDuration("mode2_build_witness_mdus_ms", time.Since(witnessStarted))
	}

	// Write user roots into MDU0 (starting after witness roots).
	for i, root := range userRoots {
		if err := builder.SetRoot(witnessCount+uint64(i), root); err != nil {
			return nil, "", fmt.Errorf("set user root %d: %w", i, err)
		}
	}

	manifestStarted := time.Now()
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
	if err := os.WriteFile(filepath.Join(stagingDir, mode2SlabCompleteMarker), []byte("ok\n"), 0o644); err != nil {
		return nil, "", err
	}
	if profile != nil {
		profile.addDuration("mode2_build_manifest_ms", time.Since(manifestStarted))
	}

	finalDir := dealScopedDir(dealID, parsedRoot)
	if err := os.MkdirAll(filepath.Dir(finalDir), 0o755); err != nil {
		return nil, "", err
	}
	finalizeStarted := time.Now()
	if err := mode2FinalizeStagingDir(stagingDir, finalDir); err != nil {
		return nil, "", err
	}
	if profile != nil {
		profile.addDuration("mode2_finalize_dir_ms", time.Since(finalizeStarted))
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
	profile := mode2UploadProfileFromContext(ctx)
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

	// Upload to assigned providers as a dumb pipe: bytes-in/bytes-out.
	resolveSlotsStarted := time.Now()
	slots, err := resolveDealMode2Slots(ctx, dealID)
	if err != nil {
		return err
	}
	if len(slots) < int(stripe.slotCount) {
		return fmt.Errorf("not enough slot assignments for Mode 2 (need %d, got %d)", stripe.slotCount, len(slots))
	}
	if profile != nil {
		profile.addDuration("mode2_resolve_slots_ms", time.Since(resolveSlotsStarted))
	}

	localProviderAddr := strings.TrimSpace(cachedProviderAddress(ctx))

	type slotTarget struct {
		slot     uint64
		provider string
	}

	targets := make([]slotTarget, 0, stripe.slotCount)
	metadataProviders := make([]string, 0, stripe.slotCount)
	metadataSeen := make(map[string]struct{}, stripe.slotCount)
	for slot := uint64(0); slot < stripe.slotCount; slot++ {
		assign := slots[int(slot)]
		provider := strings.TrimSpace(assign.Provider)
		pending := strings.TrimSpace(assign.PendingProvider)

		// Make-before-break: once a slot is repairing, stop blocking on the outgoing provider.
		// Upload all new shards + replicated metadata to the pending provider so it can catch up.
		if assign.Status == 2 && pending != "" {
			provider = pending
		}

		if provider == "" {
			// If the slot is repairing and pending_provider is unset, treat the slot as temporarily
			// unavailable for uploads (reads should route around repairing slots).
			continue
		}
		if localProviderAddr != "" && provider == localProviderAddr {
			continue
		}
		targets = append(targets, slotTarget{slot: slot, provider: provider})
		if _, ok := metadataSeen[provider]; !ok {
			metadataSeen[provider] = struct{}{}
			metadataProviders = append(metadataProviders, provider)
		}
	}
	if profile != nil {
		profile.setCount("mode2_slots_targeted", uint64(len(targets)))
		profile.setCount("mode2_remote_providers_targeted", uint64(len(metadataProviders)))
	}

	job := uploadJobFromContext(ctx)
	metadataUploads := uint64(len(metadataProviders)) * (witnessCount + 2) // mdu_0..mdu_witness + manifest.bin
	shardUploads := uint64(len(targets)) * userMdus                        // slot-local user shards only
	totalUploads := metadataUploads + shardUploads
	if job != nil {
		job.setPhase(uploadJobPhaseUploading, "Gateway Mode 2: uploading to providers...")
		job.setSteps(0, totalUploads)
	}
	if profile != nil {
		profile.setCount("mode2_upload_tasks_metadata", metadataUploads)
		profile.setCount("mode2_upload_tasks_shards", shardUploads)
		profile.setCount("mode2_upload_tasks_total", totalUploads)
	}

	var uploaded atomic.Uint64
	bump := func() {
		next := uploaded.Add(1)
		if job != nil {
			job.setSteps(next, totalUploads)
		}
	}

	resolveProvidersStarted := time.Now()
	providerBases := make(map[string]string, len(metadataProviders))
	{
		eg, egctx := errgroup.WithContext(ctx)
		eg.SetLimit(int(stripe.slotCount))

		var mu sync.Mutex
		for _, providerAddr := range metadataProviders {
			providerAddrLocal := providerAddr

			eg.Go(func() error {
				base, err := resolveProviderHTTPBaseURL(egctx, providerAddrLocal)
				if err != nil {
					return err
				}
				mu.Lock()
				providerBases[providerAddrLocal] = strings.TrimRight(base, "/")
				mu.Unlock()
				return nil
			})
		}
		if err := eg.Wait(); err != nil {
			return err
		}
	}
	if profile != nil {
		profile.addDuration("mode2_resolve_provider_endpoints_ms", time.Since(resolveProvidersStarted))
	}

	expectContinueTimeout := mode2ExpectContinueTimeout()
	transport := &http.Transport{
		MaxIdleConns:        256,
		MaxIdleConnsPerHost: 32,
		ForceAttemptHTTP2:   false,
		// Providers validate deal state via LCD before reading bodies; keep a generous
		// wait window so we don't start streaming 8 MiB payloads only to be rejected
		// a moment later (which also triggers client-side ContentLength mismatch errors).
		ExpectContinueTimeout: expectContinueTimeout,
		IdleConnTimeout:       90 * time.Second,
	}
	client := &http.Client{Timeout: 60 * time.Second, Transport: transport}
	manifestRootCanonical := manifestRoot.Canonical
	dealIDStr := strconv.FormatUint(dealID, 10)
	sparseUploads := mode2SparseUploadEnabled()

	type uploadTask struct {
		url          string
		path         string
		sizeBytes    int64
		maxBytes     int64
		dealID       string
		manifestRoot string
		mduIndex     string
		slot         string
	}

	isRetryableUploadErr := func(err error) bool {
		if err == nil {
			return false
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return false
		}

		var httpErr *providerUploadHTTPError
		if errors.As(err, &httpErr) {
			switch httpErr.statusCode {
			case http.StatusRequestTimeout, http.StatusTooEarly, http.StatusTooManyRequests, http.StatusInternalServerError, http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
				return true
			default:
				return false
			}
		}

		var netErr net.Error
		if errors.As(err, &netErr) {
			if netErr.Timeout() {
				return true
			}
		}

		msg := strings.ToLower(err.Error())
		retryHints := []string{
			"protocol_error",
			"stream error",
			"http2: transport",
			"connection reset by peer",
			"broken pipe",
			"unexpected eof",
			"server closed idle connection",
			"use of closed network connection",
		}
		for _, hint := range retryHints {
			if strings.Contains(msg, hint) {
				return true
			}
		}
		return false
	}

	var retries atomic.Uint64

	uploadBlob := func(ctx context.Context, task uploadTask) error {
		fullSize, sendSize, err := mode2SparsePayloadLength(task.path, task.maxBytes)
		if err != nil {
			return err
		}
		const maxAttempts = 3
		currentSendSize := sendSize
		openBody := func() (io.ReadCloser, error) {
			f, err := os.Open(task.path)
			if err != nil {
				return nil, err
			}
			if sparseUploads && currentSendSize > 0 && currentSendSize < fullSize {
				return &limitedReadCloser{
					Reader: io.LimitReader(f, currentSendSize),
					Closer: f,
				}, nil
			}
			return f, nil
		}

		uploadOnce := func(ctx context.Context) error {
			body, err := openBody()
			if err != nil {
				return err
			}
			req, err := http.NewRequestWithContext(ctx, http.MethodPost, task.url, body)
			if err != nil {
				_ = body.Close()
				return err
			}
			defer req.Body.Close()
			req.GetBody = openBody
			req.ContentLength = currentSendSize
			req.Header.Set("Content-Type", "application/octet-stream")
			// Avoid sending large bodies when the SP would reject early (deal validation,
			// missing headers, etc). Keep this short so uploads don't block on origins
			// that don't promptly emit a 100-Continue response.
			if expectContinueTimeout > 0 {
				req.Header.Set("Expect", "100-continue")
			}
			if sparseUploads && currentSendSize > 0 && currentSendSize < fullSize {
				req.Header.Set("X-Nil-Full-Size", strconv.FormatInt(fullSize, 10))
			}
			if task.dealID != "" {
				req.Header.Set("X-Nil-Deal-ID", task.dealID)
			}
			if task.mduIndex != "" {
				req.Header.Set("X-Nil-Mdu-Index", task.mduIndex)
			}
			if task.slot != "" {
				req.Header.Set("X-Nil-Slot", task.slot)
			}
			if task.manifestRoot != "" {
				req.Header.Set("X-Nil-Manifest-Root", task.manifestRoot)
			}

			resp, err := client.Do(req)
			if err != nil {
				return err
			}
			defer resp.Body.Close()
			if resp.StatusCode < 200 || resp.StatusCode >= 300 {
				msg, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
				return &providerUploadHTTPError{
					statusCode: resp.StatusCode,
					status:     resp.Status,
					body:       string(msg),
				}
			}
			return nil
		}

		var lastErr error
		for attempt := 1; attempt <= maxAttempts; attempt++ {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			err := uploadOnce(ctx)
			if err == nil {
				return nil
			}
			if sparseUploads && currentSendSize > 0 && currentSendSize < fullSize {
				var httpErr *providerUploadHTTPError
				if errors.As(err, &httpErr) && (httpErr.statusCode == http.StatusBadRequest || httpErr.statusCode == http.StatusLengthRequired) {
					// Mixed-version rollout safety: older providers can reject sparse bodies.
					// Retry the same task once with full payload before surfacing failure.
					currentSendSize = fullSize
					attempt--
					continue
				}
			}
			lastErr = err
			if attempt == maxAttempts || !isRetryableUploadErr(err) {
				break
			}
			retries.Add(1)
			backoff := time.Duration(attempt*attempt) * 250 * time.Millisecond
			timer := time.NewTimer(backoff)
			select {
			case <-ctx.Done():
				timer.Stop()
				return ctx.Err()
			case <-timer.C:
			}
		}
		return fmt.Errorf("upload to %s failed after retries: %w", task.url, lastErr)
	}

	taskBuildStarted := time.Now()
	fileSizeCache := make(map[string]int64, totalUploads)
	statSize := func(path string) (int64, error) {
		if size, ok := fileSizeCache[path]; ok {
			return size, nil
		}
		info, err := os.Stat(path)
		if err != nil {
			return 0, err
		}
		size := info.Size()
		fileSizeCache[path] = size
		return size, nil
	}

	tasks := make([]uploadTask, 0, totalUploads)

	// Upload replicated metadata once per provider.
	for _, provider := range metadataProviders {
		base := providerBases[provider]
		if base == "" {
			continue
		}

		for mduIndex := uint64(0); mduIndex <= witnessCount; mduIndex++ {
			mduIndexStr := strconv.FormatUint(mduIndex, 10)
			artifactPath := filepath.Join(finalDir, fmt.Sprintf("mdu_%d.bin", mduIndex))
			sizeBytes, err := statSize(artifactPath)
			if err != nil {
				return err
			}
			tasks = append(tasks, uploadTask{
				url:          base + "/sp/upload_mdu",
				path:         artifactPath,
				sizeBytes:    sizeBytes,
				maxBytes:     10 << 20,
				dealID:       dealIDStr,
				manifestRoot: manifestRootCanonical,
				mduIndex:     mduIndexStr,
			})
		}

		manifestPath := filepath.Join(finalDir, "manifest.bin")
		manifestSize, err := statSize(manifestPath)
		if err != nil {
			return err
		}
		tasks = append(tasks, uploadTask{
			url:          base + "/sp/upload_manifest",
			path:         manifestPath,
			sizeBytes:    manifestSize,
			maxBytes:     512 << 10,
			dealID:       dealIDStr,
			manifestRoot: manifestRootCanonical,
		})
	}

	// Upload striped user shards per slot.
	for _, target := range targets {
		slot := target.slot
		base := providerBases[target.provider]
		if base == "" {
			continue
		}

		for i := uint64(0); i < userMdus; i++ {
			slabIndex := uint64(1) + witnessCount + i
			slabIndexStr := strconv.FormatUint(slabIndex, 10)
			slotStr := strconv.FormatUint(slot, 10)
			artifactPath := filepath.Join(finalDir, fmt.Sprintf("mdu_%d_slot_%d.bin", slabIndex, slot))
			sizeBytes, err := statSize(artifactPath)
			if err != nil {
				return err
			}
			tasks = append(tasks, uploadTask{
				url:          base + "/sp/upload_shard",
				path:         artifactPath,
				sizeBytes:    sizeBytes,
				maxBytes:     10 << 20,
				dealID:       dealIDStr,
				manifestRoot: manifestRootCanonical,
				mduIndex:     slabIndexStr,
				slot:         slotStr,
			})
		}
	}
	if profile != nil {
		profile.addDuration("mode2_build_upload_tasks_ms", time.Since(taskBuildStarted))
	}

	uploadParallelism := mode2UploadParallelism(stripe.slotCount)
	uploadStarted := time.Now()
	eg, egctx := errgroup.WithContext(ctx)
	eg.SetLimit(uploadParallelism)
	for _, task := range tasks {
		task := task
		eg.Go(func() error {
			if err := uploadBlob(egctx, task); err != nil {
				return err
			}
			bump()
			return nil
		})
	}
	if err := eg.Wait(); err != nil {
		return err
	}
	if profile != nil {
		profile.addDuration("mode2_upload_requests_ms", time.Since(uploadStarted))
		profile.setCount("mode2_upload_parallelism", uint64(uploadParallelism))
		profile.setCount("mode2_upload_retries", retries.Load())
	}
	return nil
}

func mode2IngestAndUploadNewDeal(ctx context.Context, filePath string, dealID uint64, hint string, fileRecordPath string, fileFlags uint8) (*mode2IngestResult, error) {
	res, finalDir, err := mode2BuildArtifacts(ctx, filePath, dealID, hint, fileRecordPath, fileFlags)
	if err != nil {
		return nil, err
	}
	if err := mode2UploadArtifactsToProviders(ctx, dealID, res.manifestRoot, hint, finalDir, res.witnessMdus, res.userMdus); err != nil {
		return nil, err
	}
	return res, nil
}

func mode2IngestAndUploadAppendToDeal(ctx context.Context, filePath string, dealID uint64, hint string, existingManifestRoot string, fileRecordPath string, fileFlags uint8) (*mode2IngestResult, error) {
	res, finalDir, err := mode2BuildArtifactsAppend(ctx, filePath, dealID, hint, existingManifestRoot, fileRecordPath, fileFlags)
	if err != nil {
		return nil, err
	}
	if err := mode2UploadArtifactsToProviders(ctx, dealID, res.manifestRoot, hint, finalDir, res.witnessMdus, res.userMdus); err != nil {
		return nil, err
	}
	return res, nil
}

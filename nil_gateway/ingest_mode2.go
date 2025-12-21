package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"nilchain/x/crypto_ffi"
	"nilchain/x/nilchain/types"
)

type mode2IngestResult struct {
	manifestRoot    ManifestRoot
	manifestBlob    []byte
	allocatedLength uint64
	fileSize        uint64
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

func mode2IngestAndUploadNewDeal(ctx context.Context, filePath string, dealID uint64, hint string, fileRecordPath string) (*mode2IngestResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	stripe, err := stripeParamsFromHint(hint)
	if err != nil {
		return nil, fmt.Errorf("parse service_hint: %w", err)
	}
	if stripe.mode != 2 || stripe.k == 0 || stripe.m == 0 || stripe.rows == 0 {
		return nil, fmt.Errorf("deal is not Mode 2")
	}

	fi, err := os.Stat(filePath)
	if err != nil {
		return nil, err
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
		return nil, fmt.Errorf("failed to create MDU0 builder")
	}
	defer builder.Free()
	witnessCount := builder.GetWitnessCount()

	// Stage artifacts under uploads/deals/<dealID>/.staging-<ts>/, then atomically rename to the manifest-root key.
	baseDealDir := filepath.Join(uploadDir, "deals", strconv.FormatUint(dealID, 10))
	if err := os.MkdirAll(baseDealDir, 0o755); err != nil {
		return nil, err
	}
	stagingDir, err := os.MkdirTemp(baseDealDir, "staging-")
	if err != nil {
		return nil, err
	}
	rollback := true
	defer func() {
		if rollback {
			_ = os.RemoveAll(stagingDir)
		}
	}()

	userRoots := make([][]byte, 0, userMdus)
	witnessData := new(bytes.Buffer)

	f, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	rawBuf := make([]byte, RawMduCapacity)
	for i := uint64(0); i < userMdus; i++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		n, readErr := io.ReadFull(f, rawBuf)
		if readErr != nil {
			if readErr == io.ErrUnexpectedEOF || readErr == io.EOF {
				// Last chunk is short (or empty).
			} else {
				return nil, readErr
			}
		}
		chunk := rawBuf[:n]
		encoded := encodePayloadToMdu(chunk)

		witnessFlat, shards, err := crypto_ffi.ExpandMduRs(encoded, stripe.k, stripe.m)
		if err != nil {
			return nil, fmt.Errorf("expand mdu %d: %w", i, err)
		}
		root, err := crypto_ffi.ComputeMduRootFromWitnessFlat(witnessFlat)
		if err != nil {
			return nil, fmt.Errorf("compute mdu root %d: %w", i, err)
		}
		userRoots = append(userRoots, root)
		if err := builder.SetRoot(witnessCount+i, root); err != nil {
			return nil, fmt.Errorf("set user root %d: %w", i, err)
		}
		_, _ = witnessData.Write(witnessFlat)

		slabIndex := uint64(1) + witnessCount + i
		for slot := uint64(0); slot < stripe.slotCount; slot++ {
			if int(slot) >= len(shards) {
				return nil, fmt.Errorf("missing shard for slot %d", slot)
			}
			name := fmt.Sprintf("mdu_%d_slot_%d.bin", slabIndex, slot)
			if err := os.WriteFile(filepath.Join(stagingDir, name), shards[slot], 0o644); err != nil {
				return nil, err
			}
		}
	}

	// Build witness MDUs from the concatenated witness commitments.
	witnessRoots := make([][]byte, 0, witnessCount)
	witnessBytes := witnessData.Bytes()
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
			return nil, fmt.Errorf("compute witness root %d: %w", i, err)
		}
		witnessRoots = append(witnessRoots, root)
		if err := builder.SetRoot(i, root); err != nil {
			return nil, fmt.Errorf("set witness root %d: %w", i, err)
		}
		if err := os.WriteFile(filepath.Join(stagingDir, fmt.Sprintf("mdu_%d.bin", 1+i)), encoded, 0o644); err != nil {
			return nil, err
		}
	}

	// Append the file record (naive single-file mapping at offset 0 for now).
	if err := builder.AppendFile(fileRecordPath, fileSize, 0); err != nil {
		return nil, err
	}

	// Write MDU #0 and compute its root.
	mdu0Bytes, err := builder.Bytes()
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(stagingDir, "mdu_0.bin"), mdu0Bytes, 0o644); err != nil {
		return nil, err
	}
	mdu0Root, err := crypto_ffi.ComputeMduMerkleRoot(mdu0Bytes)
	if err != nil {
		return nil, fmt.Errorf("compute mdu0 root: %w", err)
	}

	roots := make([][]byte, 0, 1+len(witnessRoots)+len(userRoots))
	roots = append(roots, mdu0Root)
	roots = append(roots, witnessRoots...)
	roots = append(roots, userRoots...)

	commitment, manifestBlob, err := crypto_ffi.ComputeManifestCommitment(roots)
	if err != nil {
		return nil, fmt.Errorf("compute manifest commitment: %w", err)
	}
	manifestRootHex := "0x" + hex.EncodeToString(commitment)
	parsedRoot, err := parseManifestRoot(manifestRootHex)
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(stagingDir, "manifest.bin"), manifestBlob, 0o644); err != nil {
		return nil, err
	}

	finalDir := dealScopedDir(dealID, parsedRoot)
	if err := os.MkdirAll(filepath.Dir(finalDir), 0o755); err != nil {
		return nil, err
	}
	if err := os.Rename(stagingDir, finalDir); err != nil {
		return nil, err
	}
	rollback = false

	// Upload to assigned providers as a dumb pipe: bytes-in/bytes-out.
	providers, err := fetchDealProvidersFromLCD(ctx, dealID)
	if err != nil {
		return nil, err
	}
	if len(providers) < int(stripe.slotCount) {
		return nil, fmt.Errorf("not enough providers for Mode 2 (need %d, got %d)", stripe.slotCount, len(providers))
	}
	slotBases := make([]string, 0, stripe.slotCount)
	for slot := uint64(0); slot < stripe.slotCount; slot++ {
		base, err := resolveProviderHTTPBaseURL(ctx, providers[slot])
		if err != nil {
			return nil, err
		}
		slotBases = append(slotBases, strings.TrimRight(base, "/"))
	}

	client := &http.Client{Timeout: 60 * time.Second}
	manifestRootCanonical := parsedRoot.Canonical
	dealIDStr := strconv.FormatUint(dealID, 10)

	uploadBlob := func(ctx context.Context, url string, headers map[string]string, path string, maxBytes int64) error {
		body, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if maxBytes > 0 && int64(len(body)) > maxBytes {
			return fmt.Errorf("artifact too large: %s (%d bytes)", filepath.Base(path), len(body))
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
		if err != nil {
			return err
		}
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		req.Header.Set("Content-Type", "application/octet-stream")
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

	// Replicated metadata: mdu_0..mdu_witnessCount + manifest.bin to all slots.
	for _, base := range slotBases {
		for mduIndex := uint64(0); mduIndex <= witnessCount; mduIndex++ {
			path := filepath.Join(finalDir, fmt.Sprintf("mdu_%d.bin", mduIndex))
			if err := uploadBlob(ctx, base+"/sp/upload_mdu", map[string]string{
				"X-Nil-Deal-ID":       dealIDStr,
				"X-Nil-Mdu-Index":     strconv.FormatUint(mduIndex, 10),
				"X-Nil-Manifest-Root": manifestRootCanonical,
			}, path, 10<<20); err != nil {
				return nil, err
			}
		}
		if err := uploadBlob(ctx, base+"/sp/upload_manifest", map[string]string{
			"X-Nil-Deal-ID":       dealIDStr,
			"X-Nil-Manifest-Root": manifestRootCanonical,
		}, filepath.Join(finalDir, "manifest.bin"), 512<<10); err != nil {
			return nil, err
		}
	}

	// Striped user shards.
	for i := uint64(0); i < userMdus; i++ {
		slabIndex := uint64(1) + witnessCount + i
		for slot, base := range slotBases {
			path := filepath.Join(finalDir, fmt.Sprintf("mdu_%d_slot_%d.bin", slabIndex, slot))
			if err := uploadBlob(ctx, base+"/sp/upload_shard", map[string]string{
				"X-Nil-Deal-ID":       dealIDStr,
				"X-Nil-Mdu-Index":     strconv.FormatUint(slabIndex, 10),
				"X-Nil-Slot":          strconv.Itoa(slot),
				"X-Nil-Manifest-Root": manifestRootCanonical,
			}, path, 10<<20); err != nil {
				return nil, err
			}
		}
	}

	return &mode2IngestResult{
		manifestRoot:    parsedRoot,
		manifestBlob:    manifestBlob,
		allocatedLength: uint64(len(roots)),
		fileSize:        fileSize,
		witnessMdus:     witnessCount,
		userMdus:        userMdus,
	}, nil
}

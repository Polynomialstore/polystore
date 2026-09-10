package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"path/filepath"
	"strconv"
	"time"

	"polystorechain/pkg/retrievalchallenge"
	"polystorechain/x/polystorechain/types"
)

const integrityIndexColdBuildTimeoutV3 = 5 * time.Minute

func acceptsRetrievalVersion(r *http.Request, version string) bool {
	media, params, err := mime.ParseMediaType(r.Header.Get("Accept"))
	return err == nil && media == "multipart/form-data" && params["version"] == version
}

type retrievalDataEntryV3 struct {
	T                 string   `json:"t"`
	MDUIndex          string   `json:"mdu_index"`
	LeafIndex         uint32   `json:"leaf_index"`
	IntegrityPosition string   `json:"integrity_position"`
	IntegrityPath     []string `json:"integrity_path"`
}

type retrievalDataMetadataV3 struct {
	Version       uint32                 `json:"version"`
	SessionID     string                 `json:"session_id"`
	ContextHash   string                 `json:"context_hash"`
	PolyFSRoot    string                 `json:"polyfs_root"`
	IntegrityRoot string                 `json:"integrity_root"`
	Slot          uint32                 `json:"slot"`
	MDUIndex      string                 `json:"mdu_index"`
	StartBlob     uint32                 `json:"start_blob_index"`
	BlobCount     string                 `json:"blob_count"`
	TotalBytes    string                 `json:"total_bytes"`
	Entries       []retrievalDataEntryV3 `json:"entries"`
}

type retrievalDataChunkV3 struct {
	slot, startLeaf uint32
	mdu             uint64
	payee           string
	t               []uint64
}

func parseRetrievalSlotV3(r *http.Request) (uint32, error) {
	values := r.Header.Values("X-PolyStore-Slot")
	if len(values) != 1 {
		return 0, fmt.Errorf("exactly one X-PolyStore-Slot header is required")
	}
	parsed, err := strconv.ParseUint(values[0], 10, 32)
	if err != nil || parsed > 7 || strconv.FormatUint(parsed, 10) != values[0] {
		return 0, fmt.Errorf("invalid X-PolyStore-Slot header")
	}
	return uint32(parsed), nil
}

func frozenRetrievalDataChunkV3(f *frozenRetrievalSessionV3, root ManifestRoot, mdu, deal uint64, owner string, slot uint32) (retrievalDataChunkV3, error) {
	if f == nil || deal != f.Context.DealID || owner != f.Session.Owner || root.Bytes != f.Context.PolyFSRoot || slot > 7 || mdu < f.Context.MetadataMDUs || mdu-f.Context.MetadataMDUs >= f.Context.UserMDUs {
		return retrievalDataChunkV3{}, fmt.Errorf("request does not match frozen v3 session")
	}
	bit := uint32(1) << slot
	if f.Session.AckedSlotsMask&bit != 0 || f.Session.SettledSlotsMask&bit != 0 || f.Session.RefundedSlotsMask&bit != 0 {
		return retrievalDataChunkV3{}, fmt.Errorf("v3 slot is no longer eligible for delivery")
	}
	payee := ""
	for _, obligation := range f.Session.Obligations {
		if obligation.Slot == slot {
			payee = obligation.Payee
			break
		}
	}
	if payee == "" {
		return retrievalDataChunkV3{}, fmt.Errorf("slot is not represented in frozen v3 plan")
	}
	user := mdu - f.Context.MetadataMDUs
	first, last := user*64, user*64+63
	if first < f.Plan.First {
		first = f.Plan.First
	}
	if last > f.Plan.Last {
		last = f.Plan.Last
	}
	if first > last {
		return retrievalDataChunkV3{}, fmt.Errorf("MDU does not intersect frozen v3 range")
	}
	delta := (uint64(slot) + 8 - first%8) % 8
	if delta > last-first {
		return retrievalDataChunkV3{}, fmt.Errorf("slot does not intersect requested MDU")
	}
	start := first + delta
	chunk := retrievalDataChunkV3{slot: slot, mdu: mdu, payee: payee, t: make([]uint64, 0, 8)}
	for value := start; value <= last; value += 8 {
		chunk.t = append(chunk.t, value)
		if last-value < 8 {
			break
		}
	}
	_, leaf, actualSlot, err := retrievalchallenge.SystematicCoordinateV3(chunk.t[0], f.Context.MetadataMDUs, f.Context.UserMDUs)
	if err != nil || actualSlot != slot {
		return retrievalDataChunkV3{}, fmt.Errorf("invalid frozen v3 data coordinate")
	}
	chunk.startLeaf = leaf
	return chunk, nil
}

func validateRetrievalChunkHintsV3(r *http.Request, chunk retrievalDataChunkV3) error {
	expected := map[string]string{
		"X-PolyStore-Start-Blob-Index": strconv.FormatUint(uint64(chunk.startLeaf), 10),
		"X-PolyStore-Blob-Count":       strconv.Itoa(len(chunk.t)),
	}
	for name, want := range expected {
		values := r.Header.Values(name)
		if len(values) > 1 || len(values) == 1 && values[0] != want {
			return fmt.Errorf("%s does not match frozen v3 chunk", name)
		}
	}
	return nil
}

func retrievalGenerationV3(f *frozenRetrievalSessionV3) retrievalGenerationKey {
	return retrievalGenerationKey{Chain: f.Context.ChainID, Setup: f.Context.SetupDigest, Root: f.Context.PolyFSRoot, Integrity: f.Context.IntegrityRoot, Deal: f.Context.DealID, Generation: f.Context.Generation, Metadata: f.Context.MetadataMDUs, Users: f.Context.UserMDUs, Layout: retrievalchallenge.StripeK8M4, K: 8, M: 4, Version: 3}
}

func prepareRetrievalDataV3(ctx context.Context, dir string, f *frozenRetrievalSessionV3, chunk retrievalDataChunkV3) ([]byte, []byte, error) {
	key := retrievalGenerationV3(f)
	if _, err := authenticatedRetrievalMetadataFor(ctx, dir, key); err != nil {
		return nil, nil, err
	}
	buildCtx, cancel := context.WithTimeout(ctx, integrityIndexColdBuildTimeoutV3)
	defer cancel()
	indexPath, err := ensureIntegrityIndexV3(buildCtx, dir, key)
	if err != nil {
		return nil, nil, err
	}
	rowStart := uint64(chunk.startLeaf % 8)
	length := uint64(len(chunk.t)) * types.BLOB_SIZE
	window, err := readExactArtifactRange(filepath.Join(dir, fmt.Sprintf("mdu_%d_slot_%d.bin", chunk.mdu, chunk.slot)), 8*types.BLOB_SIZE, rowStart*types.BLOB_SIZE, length)
	if err != nil {
		return nil, nil, err
	}
	leafCount := key.Users * retrievalchallenge.IntegrityLeavesPerUserMDU
	entries := make([]retrievalDataEntryV3, len(chunk.t))
	for i, t := range chunk.t {
		if err := ctx.Err(); err != nil {
			return nil, nil, err
		}
		mdu, leaf, slot, err := retrievalchallenge.SystematicCoordinateV3(t, key.Metadata, key.Users)
		if err != nil || mdu != chunk.mdu || slot != chunk.slot || leaf != chunk.startLeaf+uint32(i) {
			return nil, nil, fmt.Errorf("noncanonical v3 chunk coordinate")
		}
		blob := window[uint64(i)*types.BLOB_SIZE : uint64(i+1)*types.BLOB_SIZE]
		value, err := retrievalchallenge.IntegrityLeafV3(mdu, leaf, blob)
		if err != nil {
			return nil, nil, err
		}
		position := (mdu-key.Metadata)*retrievalchallenge.IntegrityLeavesPerUserMDU + uint64(leaf)
		path, err := readIntegrityPathV3(indexPath, filepath.Join(dir, integrityLeavesV3File), position, leafCount)
		if err != nil || !retrievalchallenge.VerifyIntegrityPathV3(value, position, leafCount, path, key.Integrity) {
			return nil, nil, fmt.Errorf("v3 data blob %d/%d failed integrity verification", mdu, leaf)
		}
		encodedPath := make([]string, len(path))
		for j := range path {
			encodedPath[j] = "0x" + hex.EncodeToString(path[j][:])
		}
		entries[i] = retrievalDataEntryV3{T: strconv.FormatUint(t, 10), MDUIndex: strconv.FormatUint(mdu, 10), LeafIndex: leaf, IntegrityPosition: strconv.FormatUint(position, 10), IntegrityPath: encodedPath}
	}
	metadata, err := json.Marshal(retrievalDataMetadataV3{
		Version: 3, SessionID: "0x" + hex.EncodeToString(f.Session.SessionId), ContextHash: "0x" + hex.EncodeToString(f.Hash[:]),
		PolyFSRoot: "0x" + hex.EncodeToString(f.Context.PolyFSRoot[:]), IntegrityRoot: "0x" + hex.EncodeToString(f.Context.IntegrityRoot[:]),
		Slot: chunk.slot, MDUIndex: strconv.FormatUint(chunk.mdu, 10), StartBlob: chunk.startLeaf, BlobCount: strconv.Itoa(len(chunk.t)), TotalBytes: strconv.FormatUint(length, 10), Entries: entries,
	})
	if err != nil || len(metadata) > maxRetrievalMetadataBytes {
		return nil, nil, fmt.Errorf("v3 retrieval metadata exceeds response bound")
	}
	return metadata, window, nil
}

func serveFrozenRetrievalDataV3(w http.ResponseWriter, r *http.Request, root ManifestRoot, index uint64, response *types.QueryGetRetrievalSessionV3Response, height uint64) {
	if !acceptsRetrievalVersion(r, "3") {
		writeJSONError(w, http.StatusNotAcceptable, "retrieval v3 requires multipart/form-data; version=3", "")
		return
	}
	f, err := freezeRetrievalSessionV3Response(response, height)
	if err != nil {
		writeJSONError(w, http.StatusConflict, "retrieval v3 authority unavailable", err.Error())
		return
	}
	dealRaw := r.URL.Query().Get("deal_id")
	deal, err := strconv.ParseUint(dealRaw, 10, 64)
	if err != nil || strconv.FormatUint(deal, 10) != dealRaw || len(r.URL.Query()["deal_id"]) != 1 || len(r.URL.Query()["owner"]) != 1 {
		writeJSONError(w, http.StatusBadRequest, "deal_id and owner are required", "")
		return
	}
	slot, err := parseRetrievalSlotV3(r)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error(), "")
		return
	}
	chunk, err := frozenRetrievalDataChunkV3(f, root, index, deal, r.URL.Query().Get("owner"), slot)
	if err == nil {
		err = validateRetrievalChunkHintsV3(r, chunk)
	}
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "request does not match frozen v3 data chunk", err.Error())
		return
	}
	_, signer, err := retrievalSigner(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusServiceUnavailable, "provider signing key unavailable", err.Error())
		return
	}
	if signer != chunk.payee {
		writeJSONError(w, http.StatusForbidden, "v3 session authorizes a different provider", "")
		return
	}
	ctx, release, err := admitRetrievalResponse(r.Context())
	if err != nil {
		w.Header().Set("Retry-After", "1")
		writeJSONError(w, http.StatusServiceUnavailable, "provider retrieval capacity is busy", "")
		return
	}
	defer release()
	dir, releaseGeneration, err := openFrozenGeneration(deal, root)
	if err != nil {
		writeJSONError(w, http.StatusNotFound, "retained generation unavailable", err.Error())
		return
	}
	defer releaseGeneration()
	metadata, window, err := prepareRetrievalDataV3(ctx, dir, f, chunk)
	if err != nil {
		status := http.StatusConflict
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			status = http.StatusServiceUnavailable
		}
		writeJSONError(w, status, "authenticated v3 data unavailable", err.Error())
		return
	}
	w.Header().Set("X-PolyStore-Session-Id", "0x"+hex.EncodeToString(f.Session.SessionId))
	w.Header().Set("X-PolyStore-Mdu-Index", strconv.FormatUint(chunk.mdu, 10))
	w.Header().Set("X-PolyStore-Slot", strconv.FormatUint(uint64(chunk.slot), 10))
	w.Header().Set("X-PolyStore-Start-Blob-Index", strconv.FormatUint(uint64(chunk.startLeaf), 10))
	w.Header().Set("X-PolyStore-Blob-Count", strconv.Itoa(len(chunk.t)))
	if err := writeRetrievalWindowVersion(w, metadata, window, "3"); err != nil {
		return
	}
}

func routerRetrievalDataProviderV3(r *http.Request, f *frozenRetrievalSessionV3, root ManifestRoot, mdu, deal uint64, owner string) (string, int, error) {
	if !acceptsRetrievalVersion(r, "3") {
		return "", http.StatusNotAcceptable, fmt.Errorf("retrieval v3 requires multipart/form-data; version=3")
	}
	slot, err := parseRetrievalSlotV3(r)
	if err != nil {
		return "", http.StatusBadRequest, err
	}
	chunk, err := frozenRetrievalDataChunkV3(f, root, mdu, deal, owner, slot)
	if err != nil {
		return "", http.StatusBadRequest, err
	}
	if err := validateRetrievalChunkHintsV3(r, chunk); err != nil {
		return "", http.StatusBadRequest, err
	}
	return chunk.payee, http.StatusOK, nil
}

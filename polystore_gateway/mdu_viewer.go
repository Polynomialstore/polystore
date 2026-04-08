package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/gorilla/mux"

	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/types"
)

type manifestInfoResponse struct {
	ManifestRoot    string          `json:"manifest_root"`
	ManifestBlobHex string          `json:"manifest_blob_hex"`
	TotalMdus       uint64          `json:"total_mdus"`
	WitnessMdus     uint64          `json:"witness_mdus"`
	UserMdus        uint64          `json:"user_mdus"`
	Roots           []mduRootRecord `json:"roots"`
}

type mduRootRecord struct {
	MduIndex       uint64  `json:"mdu_index"`
	Kind           string  `json:"kind"`
	RootHex        string  `json:"root_hex"`
	RootTableIndex *uint64 `json:"root_table_index,omitempty"`
}

type mduKzgResponse struct {
	ManifestRoot string   `json:"manifest_root"`
	MduIndex     uint64   `json:"mdu_index"`
	Kind         string   `json:"kind"`
	RootHex      string   `json:"root_hex"`
	Blobs        []string `json:"blobs"`
}

func GatewayMdu(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	vars := mux.Vars(r)
	rawManifestRoot := strings.TrimSpace(vars["cid"])
	if rawManifestRoot == "" {
		writeJSONError(w, http.StatusBadRequest, "manifest_root path parameter is required", "")
		return
	}
	manifestRoot, err := parseManifestRoot(rawManifestRoot)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid manifest_root", err.Error())
		return
	}
	indexStr := strings.TrimSpace(vars["index"])
	if indexStr == "" {
		writeJSONError(w, http.StatusBadRequest, "index is required", "")
		return
	}
	mduIndex, err := strconv.ParseUint(indexStr, 10, 64)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid index", "")
		return
	}

	dealID, _, status, err := validateDealOwnerCidQuery(r, manifestRoot)
	hasDealQuery := strings.TrimSpace(r.URL.Query().Get("deal_id")) != ""
	if err != nil {
		writeJSONError(w, status, err.Error(), "")
		return
	}
	if strings.HasPrefix(r.URL.Path, "/sp/retrieval/") {
		sessionID := strings.TrimSpace(r.Header.Get("X-Nil-Session-Id"))
		if sessionID == "" {
			writeJSONError(w, http.StatusBadRequest, "missing X-Nil-Session-Id", "open an on-chain retrieval session first")
			return
		}
		if !hasDealQuery {
			writeJSONError(w, http.StatusBadRequest, "deal_id and owner query parameters are required", "provider retrieval requires session-scoped deal context")
			return
		}
		onchainSession, err := fetchRetrievalSession(sessionID)
		if err != nil {
			if errors.Is(err, ErrSessionNotFound) {
				writeJSONError(w, http.StatusNotFound, "retrieval session not found", "")
				return
			}
			writeJSONError(w, http.StatusBadGateway, "failed to load retrieval session", err.Error())
			return
		}
		providerAddr := strings.TrimSpace(cachedProviderAddress(r.Context()))
		if providerAddr == "" {
			writeJSONError(w, http.StatusInternalServerError, "provider address unavailable", "")
			return
		}
		if onchainSession.DealId != dealID {
			writeJSONError(w, http.StatusBadRequest, "retrieval session does not match request", "deal_id mismatch")
			return
		}
		if strings.TrimSpace(onchainSession.Owner) != strings.TrimSpace(r.URL.Query().Get("owner")) {
			writeJSONError(w, http.StatusBadRequest, "retrieval session does not match request", "owner mismatch")
			return
		}
		if strings.TrimSpace(onchainSession.Provider) != providerAddr {
			writeJSONError(w, http.StatusBadRequest, "retrieval session does not match this provider", "provider mismatch")
			return
		}
		sessionRootHex := "0x" + hex.EncodeToString(onchainSession.ManifestRoot)
		if normalizeManifestRootOrEmpty(sessionRootHex) != manifestRoot.Canonical {
			writeJSONError(w, http.StatusBadRequest, "retrieval session does not match request", "manifest_root mismatch")
			return
		}
		if onchainSession.StartMduIndex != mduIndex {
			writeJSONError(w, http.StatusBadRequest, "retrieval session does not match request", "mdu_index mismatch")
			return
		}
		if len(onchainSession.SessionId) == 0 {
			writeJSONError(w, http.StatusBadRequest, "invalid retrieval session", "missing session id bytes")
			return
		}

		hint, err := fetchDealServiceHintFromLCD(r.Context(), dealID)
		if err != nil {
			writeJSONError(w, http.StatusBadGateway, "failed to load deal service hint", err.Error())
			return
		}
		stripe, serr := stripeParamsFromHint(hint)
		if serr != nil {
			writeJSONError(w, http.StatusBadGateway, "failed to parse deal service hint", serr.Error())
			return
		}
		if onchainSession.BlobCount == 0 {
			writeJSONError(w, http.StatusBadRequest, "invalid retrieval session", "blob_count must be > 0")
			return
		}
		windowBytes, err := readMduSessionWindow(metaOrNil(dealID, manifestRoot, rawManifestRoot), mduIndex, stripe, onchainSession.StartBlobIndex, onchainSession.BlobCount)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				writeJSONError(w, http.StatusNotFound, "mdu not found", "")
				return
			}
			writeJSONError(w, http.StatusInternalServerError, "failed to read mdu session window", err.Error())
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", strconv.Itoa(len(windowBytes)))
		w.Header().Set("X-Nil-Manifest-Root", manifestRoot.Canonical)
		w.Header().Set("X-Nil-Mdu-Index", strconv.FormatUint(mduIndex, 10))
		w.Header().Set("X-Nil-Start-Blob-Index", strconv.FormatUint(uint64(onchainSession.StartBlobIndex), 10))
		w.Header().Set("X-Nil-Blob-Count", strconv.FormatUint(onchainSession.BlobCount, 10))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(windowBytes)
		return
	}

	var dealDir string
	if hasDealQuery {
		dealDir, err = resolveDealDirForDeal(dealID, manifestRoot, rawManifestRoot)
	} else {
		dealDir, err = resolveDealDir(manifestRoot, rawManifestRoot)
	}
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeJSONError(w, http.StatusNotFound, "slab not found on disk", "")
			return
		}
		if errors.Is(err, ErrDealDirConflict) {
			writeJSONError(w, http.StatusConflict, "deal directory conflict", err.Error())
			return
		}
		writeJSONError(w, http.StatusInternalServerError, "failed to resolve slab directory", err.Error())
		return
	}

	meta, err := loadSlabMeta(dealDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeJSONError(w, http.StatusNotFound, "slab not found", "")
			return
		}
		log.Printf("GatewayMdu: load slab meta error: %v", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to load slab", "")
		return
	}
	defer meta.Close()

	if mduIndex >= meta.totalMdus {
		writeJSONError(w, http.StatusNotFound, "mdu index out of range", "")
		return
	}

	mduPath := filepath.Join(meta.dealDir, fmt.Sprintf("mdu_%d.bin", mduIndex))
	data, err := os.ReadFile(mduPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeJSONError(w, http.StatusNotFound, "mdu not found", "")
			return
		}
		log.Printf("GatewayMdu: read mdu error: %v", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to read mdu", "")
		return
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.Header().Set("X-Nil-Manifest-Root", manifestRoot.Canonical)
	w.Header().Set("X-Nil-Mdu-Index", strconv.FormatUint(mduIndex, 10))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

type dealDirLocator struct {
	dealID          uint64
	manifestRoot    ManifestRoot
	rawManifestRoot string
}

func metaOrNil(dealID uint64, manifestRoot ManifestRoot, rawManifestRoot string) dealDirLocator {
	return dealDirLocator{dealID: dealID, manifestRoot: manifestRoot, rawManifestRoot: rawManifestRoot}
}

func readMduSessionWindow(locator dealDirLocator, mduIndex uint64, stripe stripeParams, startBlobIndex uint32, blobCount uint64) ([]byte, error) {
	dealDir, err := resolveDealDirForDeal(locator.dealID, locator.manifestRoot, locator.rawManifestRoot)
	if err != nil {
		return nil, err
	}
	if blobCount == 0 {
		return nil, fmt.Errorf("blob_count must be > 0")
	}
	if stripe.mode != 2 {
		mduPath := filepath.Join(dealDir, fmt.Sprintf("mdu_%d.bin", mduIndex))
		data, err := os.ReadFile(mduPath)
		if err != nil {
			return nil, err
		}
		start := uint64(startBlobIndex) * uint64(types.BLOB_SIZE)
		length := blobCount * uint64(types.BLOB_SIZE)
		end := start + length
		if end > uint64(len(data)) {
			return nil, fmt.Errorf("requested blob window exceeds mdu length")
		}
		return data[start:end], nil
	}
	if stripe.rows == 0 {
		return nil, fmt.Errorf("invalid mode2 stripe rows")
	}
	slot := uint64(startBlobIndex) / stripe.rows
	rowStart := uint64(startBlobIndex) % stripe.rows
	if rowStart+blobCount > stripe.rows {
		return nil, fmt.Errorf("requested mode2 blob window crosses slot boundary")
	}

	shardPath := filepath.Join(dealDir, fmt.Sprintf("mdu_%d_slot_%d.bin", mduIndex, slot))
	if shardBytes, err := os.ReadFile(shardPath); err == nil {
		start := rowStart * uint64(types.BLOB_SIZE)
		length := blobCount * uint64(types.BLOB_SIZE)
		end := start + length
		if end > uint64(len(shardBytes)) {
			return nil, fmt.Errorf("requested shard window exceeds stored shard length")
		}
		return shardBytes[start:end], nil
	}

	fullPath := filepath.Join(dealDir, fmt.Sprintf("mdu_%d.bin", mduIndex))
	fullBytes, err := os.ReadFile(fullPath)
	if err != nil {
		return nil, err
	}
	return synthesizeMode2SlotWindowFromFullMdu(fullBytes, stripe, slot, rowStart, blobCount)
}

func synthesizeMode2SlotWindowFromFullMdu(mdu []byte, stripe stripeParams, slot uint64, rowStart uint64, blobCount uint64) ([]byte, error) {
	if stripe.k == 0 || stripe.rows == 0 {
		return nil, fmt.Errorf("invalid mode2 stripe params")
	}
	if slot >= stripe.k {
		return nil, fmt.Errorf("slot %d is not a data slot", slot)
	}
	if rowStart+blobCount > stripe.rows {
		return nil, fmt.Errorf("requested mode2 blob window crosses slot boundary")
	}
	expectedLen := uint64(types.MDU_SIZE)
	if uint64(len(mdu)) < expectedLen {
		return nil, fmt.Errorf("mdu shorter than expected: got %d want %d", len(mdu), expectedLen)
	}
	out := make([]byte, blobCount*uint64(types.BLOB_SIZE))
	for i := uint64(0); i < blobCount; i++ {
		row := rowStart + i
		blobIndex := row*stripe.k + slot
		srcStart := blobIndex * uint64(types.BLOB_SIZE)
		srcEnd := srcStart + uint64(types.BLOB_SIZE)
		dstStart := i * uint64(types.BLOB_SIZE)
		copy(out[dstStart:dstStart+uint64(types.BLOB_SIZE)], mdu[srcStart:srcEnd])
	}
	return out, nil
}

type slabMeta struct {
	dealDir     string
	builder     *crypto_ffi.Mdu0Builder
	totalMdus   uint64
	witnessMdus uint64
	userMdus    uint64
}

func (s *slabMeta) Close() {
	if s.builder != nil {
		s.builder.Free()
		s.builder = nil
	}
}

func loadSlabMeta(dealDir string) (*slabMeta, error) {
	metaDoc, err := loadSlabMetadataWithFallback(dealDir)
	if err != nil {
		return nil, err
	}

	mdu0Path := filepath.Join(dealDir, "mdu_0.bin")
	mdu0Data, err := os.ReadFile(mdu0Path)
	if err != nil {
		return nil, err
	}

	b, err := crypto_ffi.LoadMdu0Builder(mdu0Data, 1)
	if err != nil {
		return nil, err
	}
	return &slabMeta{
		dealDir:     dealDir,
		builder:     b,
		totalMdus:   metaDoc.TotalMdus,
		witnessMdus: metaDoc.WitnessMdus,
		userMdus:    metaDoc.UserMdus,
	}, nil
}

func shardFileCached(ctx context.Context, path string, raw bool) (*NilCliOutput, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	outPath := path + ".json"
	if data, err := os.ReadFile(outPath); err == nil {
		var parsed NilCliOutput
		if err := json.Unmarshal(data, &parsed); err == nil && parsed.ManifestRootHex != "" && len(parsed.Mdus) > 0 {
			return &parsed, nil
		}
	}
	return shardFile(ctx, path, raw, "")
}

func validateDealOwnerCidQuery(r *http.Request, manifestRoot ManifestRoot) (uint64, string, int, error) {
	q := r.URL.Query()
	dealIDStr := strings.TrimSpace(q.Get("deal_id"))
	owner := strings.TrimSpace(q.Get("owner"))
	if dealIDStr == "" && owner == "" {
		return 0, "", 0, nil
	}
	if dealIDStr == "" || owner == "" {
		return 0, "", http.StatusBadRequest, fmt.Errorf("deal_id and owner must be provided together")
	}
	dealID, err := strconv.ParseUint(dealIDStr, 10, 64)
	if err != nil {
		return 0, "", http.StatusBadRequest, fmt.Errorf("invalid deal_id")
	}

	dealOwner, dealCID, err := fetchDealOwnerAndCID(dealID)
	if err != nil {
		if errors.Is(err, ErrDealNotFound) {
			return 0, "", http.StatusNotFound, fmt.Errorf("deal not found")
		}
		return 0, "", http.StatusInternalServerError, fmt.Errorf("failed to validate deal owner")
	}
	if dealOwner == "" || dealOwner != owner {
		return 0, "", http.StatusForbidden, fmt.Errorf("forbidden: owner does not match deal")
	}
	if strings.TrimSpace(dealCID) == "" {
		return 0, "", http.StatusConflict, fmt.Errorf("deal has no committed manifest_root yet")
	}
	chainRoot, err := parseManifestRoot(dealCID)
	if err != nil {
		return 0, "", http.StatusInternalServerError, fmt.Errorf("invalid on-chain manifest_root")
	}
	if chainRoot.Canonical != manifestRoot.Canonical {
		return 0, "", http.StatusConflict, fmt.Errorf("stale manifest_root (does not match on-chain deal state)")
	}

	return dealID, owner, 0, nil
}

// GatewayManifestInfo returns the manifest blob and the ordered MDU root vector for a slab.
func GatewayManifestInfo(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	vars := mux.Vars(r)
	rawManifestRoot := strings.TrimSpace(vars["cid"])
	if rawManifestRoot == "" {
		writeJSONError(w, http.StatusBadRequest, "manifest_root path parameter is required", "")
		return
	}
	manifestRoot, err := parseManifestRoot(rawManifestRoot)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid manifest_root", err.Error())
		return
	}

	dealID, _, status, err := validateDealOwnerCidQuery(r, manifestRoot)
	hasDealQuery := strings.TrimSpace(r.URL.Query().Get("deal_id")) != ""
	if err != nil {
		writeJSONError(w, status, err.Error(), "")
		return
	}

	var dealDir string
	if hasDealQuery {
		dealDir, err = resolveDealDirForDeal(dealID, manifestRoot, rawManifestRoot)
	} else {
		dealDir, err = resolveDealDir(manifestRoot, rawManifestRoot)
	}
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeJSONError(w, http.StatusNotFound, "slab not found on disk", "")
			return
		}
		if errors.Is(err, ErrDealDirConflict) {
			writeJSONError(w, http.StatusConflict, "deal directory conflict", err.Error())
			return
		}
		writeJSONError(w, http.StatusInternalServerError, "failed to resolve slab directory", err.Error())
		return
	}

	meta, err := loadSlabMeta(dealDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeJSONError(w, http.StatusNotFound, "slab not found", "")
			return
		}
		log.Printf("GatewayManifestInfo: load slab meta error: %v", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to load slab", "")
		return
	}

	manifestBlobPath := filepath.Join(meta.dealDir, "manifest.bin")
	manifestBlob, err := os.ReadFile(manifestBlobPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeJSONError(w, http.StatusNotFound, "manifest not found", "")
			return
		}
		log.Printf("GatewayManifestInfo: read manifest error: %v", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to read manifest", "")
		return
	}

	// MDU #0 root is derived from the raw 8 MiB bytes (not stored in the root table).
	mdu0Path := filepath.Join(meta.dealDir, "mdu_0.bin")
	mdu0Shard, err := shardFileCached(r.Context(), mdu0Path, true)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			writeJSONError(w, http.StatusRequestTimeout, err.Error(), "")
			return
		}
		log.Printf("GatewayManifestInfo: shard mdu0 error: %v", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to compute MDU #0 root", "")
		return
	}
	mdu0Root := ""
	if len(mdu0Shard.Mdus) > 0 {
		mdu0Root = mdu0Shard.Mdus[0].RootHex
	}

	roots := make([]mduRootRecord, 0, meta.totalMdus)
	roots = append(roots, mduRootRecord{
		MduIndex: 0,
		Kind:     "mdu0",
		RootHex:  mdu0Root,
	})

	for i := uint64(1); i < meta.totalMdus; i++ {
		rootIdx := i - 1
		rootBytes, err := meta.builder.GetRoot(rootIdx)
		if err != nil {
			log.Printf("GatewayManifestInfo: GetRoot error: %v", err)
			continue
		}
		rootHex := "0x" + hex.EncodeToString(rootBytes[:])

		kind := "user"
		if i <= meta.witnessMdus {
			kind = "witness"
		}
		roots = append(roots, mduRootRecord{
			MduIndex:       i,
			Kind:           kind,
			RootHex:        rootHex,
			RootTableIndex: &rootIdx,
		})
	}

	resp := manifestInfoResponse{
		ManifestRoot:    manifestRoot.Canonical,
		ManifestBlobHex: "0x" + hex.EncodeToString(manifestBlob),
		TotalMdus:       meta.totalMdus,
		WitnessMdus:     meta.witnessMdus,
		UserMdus:        meta.userMdus,
		Roots:           roots,
	}
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		log.Printf("GatewayManifestInfo encode error: %v", err)
	}
}

// GatewayMduKzg returns the KZG blob commitments for a single on-disk MDU.
func GatewayMduKzg(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	vars := mux.Vars(r)
	rawManifestRoot := strings.TrimSpace(vars["cid"])
	if rawManifestRoot == "" {
		writeJSONError(w, http.StatusBadRequest, "manifest_root path parameter is required", "")
		return
	}
	manifestRoot, err := parseManifestRoot(rawManifestRoot)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid manifest_root", err.Error())
		return
	}
	indexStr := strings.TrimSpace(vars["index"])
	if indexStr == "" {
		writeJSONError(w, http.StatusBadRequest, "index is required", "")
		return
	}
	mduIndex, err := strconv.ParseUint(indexStr, 10, 64)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid index", "")
		return
	}

	dealID, _, status, err := validateDealOwnerCidQuery(r, manifestRoot)
	hasDealQuery := strings.TrimSpace(r.URL.Query().Get("deal_id")) != ""
	if err != nil {
		writeJSONError(w, status, err.Error(), "")
		return
	}

	var dealDir string
	if hasDealQuery {
		dealDir, err = resolveDealDirForDeal(dealID, manifestRoot, rawManifestRoot)
	} else {
		dealDir, err = resolveDealDir(manifestRoot, rawManifestRoot)
	}
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeJSONError(w, http.StatusNotFound, "slab not found on disk", "")
			return
		}
		if errors.Is(err, ErrDealDirConflict) {
			writeJSONError(w, http.StatusConflict, "deal directory conflict", err.Error())
			return
		}
		writeJSONError(w, http.StatusInternalServerError, "failed to resolve slab directory", err.Error())
		return
	}

	meta, err := loadSlabMeta(dealDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeJSONError(w, http.StatusNotFound, "slab not found", "")
			return
		}
		log.Printf("GatewayMduKzg: load slab meta error: %v", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to load slab", "")
		return
	}
	if mduIndex >= meta.totalMdus {
		writeJSONError(w, http.StatusNotFound, "mdu index out of range", "")
		return
	}

	mduPath := filepath.Join(meta.dealDir, fmt.Sprintf("mdu_%d.bin", mduIndex))
	if _, err := os.Stat(mduPath); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeJSONError(w, http.StatusNotFound, "mdu not found", "")
			return
		}
		log.Printf("GatewayMduKzg: stat mdu error: %v", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to read mdu", "")
		return
	}

	out, err := shardFileCached(r.Context(), mduPath, true)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			writeJSONError(w, http.StatusRequestTimeout, err.Error(), "")
			return
		}
		log.Printf("GatewayMduKzg: shard error: %v", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to compute mdu commitments", "")
		return
	}
	if len(out.Mdus) == 0 {
		writeJSONError(w, http.StatusInternalServerError, "invalid shard output", "")
		return
	}

	kind := "user"
	if mduIndex == 0 {
		kind = "mdu0"
	} else if mduIndex <= meta.witnessMdus {
		kind = "witness"
	}

	resp := mduKzgResponse{
		ManifestRoot: manifestRoot.Canonical,
		MduIndex:     mduIndex,
		Kind:         kind,
		RootHex:      out.Mdus[0].RootHex,
		Blobs:        out.Mdus[0].Blobs,
	}
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		log.Printf("GatewayMduKzg encode error: %v", err)
	}
}

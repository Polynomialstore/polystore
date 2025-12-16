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

	"nilchain/x/crypto_ffi"
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
	mdu0Path := filepath.Join(dealDir, "mdu_0.bin")
	mdu0Data, err := os.ReadFile(mdu0Path)
	if err != nil {
		return nil, err
	}

	b, err := crypto_ffi.LoadMdu0Builder(mdu0Data, 1)
	if err != nil {
		return nil, err
	}

	var maxEnd uint64
	count := b.GetRecordCount()
	for i := uint32(0); i < count; i++ {
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

	userMdus := uint64(0)
	if maxEnd > 0 {
		userMdus = (maxEnd + RawMduCapacity - 1) / RawMduCapacity
	}

	entries, err := os.ReadDir(dealDir)
	if err != nil {
		b.Free()
		return nil, err
	}

	idxSet := map[uint64]struct{}{}
	var maxIdx uint64
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, "mdu_") || !strings.HasSuffix(name, ".bin") {
			continue
		}
		idxStr := strings.TrimSuffix(strings.TrimPrefix(name, "mdu_"), ".bin")
		idx, err := strconv.ParseUint(idxStr, 10, 64)
		if err != nil {
			continue
		}
		idxSet[idx] = struct{}{}
		if idx > maxIdx {
			maxIdx = idx
		}
	}

	if len(idxSet) == 0 {
		b.Free()
		return nil, os.ErrNotExist
	}
	if _, ok := idxSet[0]; !ok {
		b.Free()
		return nil, fmt.Errorf("invalid slab layout: mdu_0.bin missing")
	}

	totalMdus := maxIdx + 1
	if uint64(len(idxSet)) != totalMdus {
		b.Free()
		return nil, fmt.Errorf("invalid slab layout: non-contiguous mdu files")
	}
	if totalMdus-1 < userMdus {
		b.Free()
		return nil, fmt.Errorf("invalid slab layout: file table exceeds user mdus")
	}

	witnessMdus := (totalMdus - 1) - userMdus
	return &slabMeta{
		dealDir:     dealDir,
		builder:     b,
		totalMdus:   totalMdus,
		witnessMdus: witnessMdus,
		userMdus:    userMdus,
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

	if _, _, status, err := validateDealOwnerCidQuery(r, manifestRoot); err != nil {
		writeJSONError(w, status, err.Error(), "")
		return
	}

	dealDir, err := resolveDealDir(manifestRoot, rawManifestRoot)
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

	if _, _, status, err := validateDealOwnerCidQuery(r, manifestRoot); err != nil {
		writeJSONError(w, status, err.Error(), "")
		return
	}

	dealDir, err := resolveDealDir(manifestRoot, rawManifestRoot)
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

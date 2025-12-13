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

	"nil_s3/pkg/builder"
	"nil_s3/pkg/layout"
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
	builder     *builder.Mdu0Builder
	totalMdus   uint64
	witnessMdus uint64
	userMdus    uint64
}

func loadSlabMeta(cid string) (*slabMeta, error) {
	dealDir := filepath.Join(uploadDir, cid)
	mdu0Path := filepath.Join(dealDir, "mdu_0.bin")
	mdu0Data, err := os.ReadFile(mdu0Path)
	if err != nil {
		return nil, err
	}

	b, err := builder.LoadMdu0Builder(mdu0Data, 1)
	if err != nil {
		return nil, err
	}

	var maxEnd uint64
	for i := uint32(0); i < b.Header.RecordCount; i++ {
		rec := b.GetFileRecord(i)
		length, _ := layout.UnpackLengthAndFlags(rec.LengthAndFlags)
		end := rec.StartOffset + length
		if end > maxEnd {
			maxEnd = end
		}
	}

	userMdus := uint64(0)
	if maxEnd > 0 {
		userMdus = (maxEnd + builder.MduSize - 1) / builder.MduSize
	}

	entries, err := os.ReadDir(dealDir)
	if err != nil {
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
		return nil, os.ErrNotExist
	}
	if _, ok := idxSet[0]; !ok {
		return nil, fmt.Errorf("invalid slab layout: mdu_0.bin missing")
	}

	totalMdus := maxIdx + 1
	if uint64(len(idxSet)) != totalMdus {
		return nil, fmt.Errorf("invalid slab layout: non-contiguous mdu files")
	}
	if totalMdus-1 < userMdus {
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

func validateDealOwnerCidQuery(r *http.Request, cid string) (uint64, string, int, error) {
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
		return 0, "", http.StatusInternalServerError, fmt.Errorf("failed to validate deal owner")
	}
	if dealOwner == "" || dealOwner != owner {
		return 0, "", http.StatusForbidden, fmt.Errorf("forbidden: owner does not match deal")
	}
	if dealCID != "" && dealCID != cid {
		return 0, "", http.StatusBadRequest, fmt.Errorf("cid does not match deal")
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
	cid := strings.TrimSpace(vars["cid"])
	if cid == "" {
		http.Error(w, "cid required", http.StatusBadRequest)
		return
	}

	if _, _, status, err := validateDealOwnerCidQuery(r, cid); err != nil {
		http.Error(w, err.Error(), status)
		return
	}

	meta, err := loadSlabMeta(cid)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			http.Error(w, "slab not found", http.StatusNotFound)
			return
		}
		log.Printf("GatewayManifestInfo: load slab meta error: %v", err)
		http.Error(w, "failed to load slab", http.StatusInternalServerError)
		return
	}

	manifestBlobPath := filepath.Join(meta.dealDir, "manifest.bin")
	manifestBlob, err := os.ReadFile(manifestBlobPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			http.Error(w, "manifest not found", http.StatusNotFound)
			return
		}
		log.Printf("GatewayManifestInfo: read manifest error: %v", err)
		http.Error(w, "failed to read manifest", http.StatusInternalServerError)
		return
	}

	// MDU #0 root is derived from the raw 8 MiB bytes (not stored in the root table).
	mdu0Path := filepath.Join(meta.dealDir, "mdu_0.bin")
	mdu0Shard, err := shardFileCached(r.Context(), mdu0Path, true)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			http.Error(w, err.Error(), http.StatusRequestTimeout)
			return
		}
		log.Printf("GatewayManifestInfo: shard mdu0 error: %v", err)
		http.Error(w, "failed to compute MDU #0 root", http.StatusInternalServerError)
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
		rootBytes := meta.builder.GetRoot(rootIdx)
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
		ManifestRoot:    cid,
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
	cid := strings.TrimSpace(vars["cid"])
	if cid == "" {
		http.Error(w, "cid required", http.StatusBadRequest)
		return
	}
	indexStr := strings.TrimSpace(vars["index"])
	if indexStr == "" {
		http.Error(w, "index required", http.StatusBadRequest)
		return
	}
	mduIndex, err := strconv.ParseUint(indexStr, 10, 64)
	if err != nil {
		http.Error(w, "invalid index", http.StatusBadRequest)
		return
	}

	if _, _, status, err := validateDealOwnerCidQuery(r, cid); err != nil {
		http.Error(w, err.Error(), status)
		return
	}

	meta, err := loadSlabMeta(cid)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			http.Error(w, "slab not found", http.StatusNotFound)
			return
		}
		log.Printf("GatewayMduKzg: load slab meta error: %v", err)
		http.Error(w, "failed to load slab", http.StatusInternalServerError)
		return
	}
	if mduIndex >= meta.totalMdus {
		http.Error(w, "mdu index out of range", http.StatusNotFound)
		return
	}

	mduPath := filepath.Join(meta.dealDir, fmt.Sprintf("mdu_%d.bin", mduIndex))
	if _, err := os.Stat(mduPath); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			http.Error(w, "mdu not found", http.StatusNotFound)
			return
		}
		log.Printf("GatewayMduKzg: stat mdu error: %v", err)
		http.Error(w, "failed to read mdu", http.StatusInternalServerError)
		return
	}

	out, err := shardFileCached(r.Context(), mduPath, true)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			http.Error(w, err.Error(), http.StatusRequestTimeout)
			return
		}
		log.Printf("GatewayMduKzg: shard error: %v", err)
		http.Error(w, "failed to compute mdu commitments", http.StatusInternalServerError)
		return
	}
	if len(out.Mdus) == 0 {
		http.Error(w, "invalid shard output", http.StatusInternalServerError)
		return
	}

	kind := "user"
	if mduIndex == 0 {
		kind = "mdu0"
	} else if mduIndex <= meta.witnessMdus {
		kind = "witness"
	}

	resp := mduKzgResponse{
		ManifestRoot: cid,
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

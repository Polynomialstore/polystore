package main

import (
	"errors"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/gorilla/mux"
)

// GatewayDebugRawFetch serves file bytes directly from an on-disk NilFS slab without
// requiring retrieval-session / receipt flows. This is intended for devnet debugging.
//
// Query params:
// - deal_id, owner: optional but recommended; when provided they are validated against chain state.
// - file_path: required NilFS path.
// - range_start, range_len: optional byte range within the file; len=0 means "to EOF".
func GatewayDebugRawFetch(w http.ResponseWriter, r *http.Request) {
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

	// Optional deal_id/owner validation (shared semantics with manifest-info / mdu-kzg).
	dealID, _, status, err := validateDealOwnerCidQuery(r, manifestRoot)
	hasDealQuery := strings.TrimSpace(r.URL.Query().Get("deal_id")) != ""
	if err != nil {
		writeJSONError(w, status, err.Error(), "")
		return
	}

	q := r.URL.Query()
	filePath, err := validateNilfsFilePath(q.Get("file_path"))
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid file_path", "")
		return
	}

	var rangeStart uint64
	if raw := strings.TrimSpace(q.Get("range_start")); raw != "" {
		v, err := strconv.ParseUint(raw, 10, 64)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid range_start", "")
			return
		}
		rangeStart = v
	}
	var rangeLen uint64
	if raw := strings.TrimSpace(q.Get("range_len")); raw != "" {
		v, err := strconv.ParseUint(raw, 10, 64)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid range_len", "")
			return
		}
		rangeLen = v
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

	content, _, _, _, servedLen, _, err := resolveNilfsFileSegmentForFetch(dealDir, filePath, rangeStart, rangeLen)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeJSONError(w, http.StatusNotFound, "file not found in deal", "")
			return
		}
		writeJSONError(w, http.StatusInternalServerError, "failed to resolve file", err.Error())
		return
	}
	defer content.Close()
	if servedLen == 0 {
		writeJSONError(w, http.StatusRequestedRangeNotSatisfiable, "range not satisfiable", "")
		return
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	// Provide a small, parseable hint for debug tooling (not used by the main UI yet).
	w.Header().Set("X-Nil-Debug-Range-Start", strconv.FormatUint(rangeStart, 10))
	w.Header().Set("X-Nil-Debug-Range-Len", strconv.FormatUint(servedLen, 10))

	_, _ = io.Copy(w, content)
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
}

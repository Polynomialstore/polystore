package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/gorilla/mux"

	"polystorechain/x/polystorechain/types"
)

// GatewayDebugRawFetch serves file bytes directly from an on-disk PolyFS slab without
// requiring retrieval-session / receipt flows. This is intended for devnet debugging.
//
// Query params:
// - deal_id, owner: optional but recommended; when provided they are validated against chain state.
// - file_path: required PolyFS path.
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

	var (
		onchainSession *types.RetrievalSession
		stripe         stripeParams
	)
	if requireOnchainSession {
		rawSession := strings.TrimSpace(r.Header.Get("X-Nil-Session-Id"))
		if rawSession == "" {
			writeJSONError(w, http.StatusBadRequest, "missing X-Nil-Session-Id", "")
			return
		}
		sessionID, _, nerr := parseSessionIDHex(rawSession)
		if nerr != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid X-Nil-Session-Id", nerr.Error())
			return
		}
		sess, serr := fetchRetrievalSession(sessionID)
		if serr != nil {
			if errors.Is(serr, ErrSessionNotFound) {
				writeJSONError(w, http.StatusNotFound, "retrieval session not found on chain", "")
				return
			}
			writeJSONError(w, http.StatusInternalServerError, "failed to fetch retrieval session", serr.Error())
			return
		}
		onchainSession = sess
		if onchainSession.Status != types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_OPEN {
			writeJSONError(w, http.StatusConflict, "session not OPEN", fmt.Sprintf("status: %s", onchainSession.Status))
			return
		}
		if len(onchainSession.ManifestRoot) != 48 || !bytes.Equal(onchainSession.ManifestRoot, manifestRoot.Bytes[:]) {
			writeJSONError(w, http.StatusBadRequest, "session manifest_root mismatch", "")
			return
		}
		if hasDealQuery && dealID != onchainSession.DealId {
			writeJSONError(w, http.StatusBadRequest, "session deal_id mismatch", "")
			return
		}
		if rawOwner := strings.TrimSpace(r.URL.Query().Get("owner")); rawOwner != "" && rawOwner != onchainSession.Owner {
			writeJSONError(w, http.StatusForbidden, "session owner mismatch", "")
			return
		}

		h, herr := fetchLatestHeight(r.Context(), lcdBase)
		if herr != nil {
			writeJSONError(w, http.StatusInternalServerError, "failed to fetch chain height", herr.Error())
			return
		}
		meta, derr := fetchDealMeta(onchainSession.DealId)
		if derr != nil {
			writeJSONError(w, http.StatusInternalServerError, "failed to fetch deal", derr.Error())
			return
		}
		if meta.EndBlock != 0 && h >= meta.EndBlock {
			writeJSONError(w, http.StatusGone, "deal expired", fmt.Sprintf("end_block=%d", meta.EndBlock))
			return
		}
		if onchainSession.ExpiresAt != 0 && h > onchainSession.ExpiresAt {
			writeJSONError(w, http.StatusForbidden, "session expired", "")
			return
		}
		if meta.EndBlock != 0 && onchainSession.ExpiresAt != 0 && onchainSession.ExpiresAt > meta.EndBlock {
			writeJSONError(w, http.StatusForbidden, "session outlives deal term", "")
			return
		}

		serviceHint, serr := fetchDealServiceHintFromLCD(r.Context(), onchainSession.DealId)
		if serr != nil {
			log.Printf("GatewayDebugRawFetch: failed to fetch service hint: %v", serr)
			serviceHint = ""
		}
		stripe, serr = stripeParamsFromHint(serviceHint)
		if serr != nil {
			stripe = stripeParams{mode: 1, leafCount: types.BLOBS_PER_MDU}
		}
		if stripe.mode == 2 {
			writeJSONError(w, http.StatusBadRequest, "debug raw fetch not supported for Mode 2 deals", "")
			return
		}
	}

	q := r.URL.Query()
	filePath, err := validatePolyfsFilePath(q.Get("file_path"))
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
	if requireOnchainSession {
		if rangeLen == 0 {
			writeJSONError(w, http.StatusBadRequest, "range_len is required", "")
			return
		}
		if rangeLen > uint64(types.BLOB_SIZE) {
			writeJSONError(w, http.StatusBadRequest, "range too large", fmt.Sprintf("range_len must be <= %d", types.BLOB_SIZE))
			return
		}
	}

	var dealDir string
	if requireOnchainSession {
		dealDir, err = resolveDealDirForDeal(onchainSession.DealId, manifestRoot, rawManifestRoot)
	} else if hasDealQuery {
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

	content, mduIdx, _, absOffset, servedLen, _, err := resolvePolyfsFileSegmentForFetch(dealDir, filePath, rangeStart, rangeLen)
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
	if requireOnchainSession {
		endAbs := absOffset + servedLen - 1
		if absOffset/RawMduCapacity != endAbs/RawMduCapacity {
			writeJSONError(w, http.StatusBadRequest, "range crosses MDU boundary", "split into multiple requests")
			return
		}
		offsetInMdu := absOffset % RawMduCapacity
		blobIndex, berr := rawOffsetToEncodedBlobIndex(offsetInMdu)
		if berr != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid blob range", berr.Error())
			return
		}
		endOffsetInMdu := endAbs % RawMduCapacity
		endBlob, eerr := rawOffsetToEncodedBlobIndex(endOffsetInMdu)
		if eerr != nil || endBlob != blobIndex {
			writeJSONError(w, http.StatusBadRequest, "range crosses blob boundary", "split into multiple requests")
			return
		}
		if stripe.leafCount == 0 {
			writeJSONError(w, http.StatusInternalServerError, "invalid stripe params", "leaf_count is zero")
			return
		}
		if onchainSession.BlobCount == 0 {
			writeJSONError(w, http.StatusBadRequest, "invalid session range", "blob_count is zero")
			return
		}
		leafIndex, lerr := leafIndexForBlobIndex(blobIndex, stripe)
		if lerr != nil {
			writeJSONError(w, http.StatusInternalServerError, "failed to map leaf index", lerr.Error())
			return
		}
		sessionStart, overflow := addUint64(onchainSession.StartMduIndex*stripe.leafCount, uint64(onchainSession.StartBlobIndex))
		if overflow {
			writeJSONError(w, http.StatusBadRequest, "invalid session range", "start_global overflow")
			return
		}
		sessionEnd := sessionStart + onchainSession.BlobCount - 1
		if sessionEnd < sessionStart {
			writeJSONError(w, http.StatusBadRequest, "invalid session range", "end_global overflow")
			return
		}
		reqGlobal, overflow := addUint64(mduIdx*stripe.leafCount, leafIndex)
		if overflow {
			writeJSONError(w, http.StatusBadRequest, "invalid request range", "global index overflow")
			return
		}
		if reqGlobal < sessionStart || reqGlobal > sessionEnd {
			writeJSONError(w, http.StatusForbidden, "range outside session", "split into multiple sessions or re-open with a larger blob range")
			return
		}
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

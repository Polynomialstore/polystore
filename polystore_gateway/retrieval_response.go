package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	sdk "github.com/cosmos/cosmos-sdk/types"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	bolt "go.etcd.io/bbolt"
	"polystorechain/x/polystorechain/types"
)

const maxRetrievalMetadataBytes = 128 * 1024

type retrievalWindowMetadata struct {
	Version      uint32               `json:"version"`
	SessionID    string               `json:"session_id"`
	ContextHash  string               `json:"context_hash"`
	ManifestRoot string               `json:"manifest_root"`
	StartMDU     string               `json:"start_mdu_index"`
	StartBlob    uint32               `json:"start_blob_index"`
	BlobCount    string               `json:"blob_count"`
	TotalBytes   string               `json:"total_bytes"`
	Proofs       []types.ChainedProof `json:"proofs"`
}

func windowMetadata(f *frozenRetrievalSession, proofs []types.ChainedProof) retrievalWindowMetadata {
	c := f.Context
	return retrievalWindowMetadata{2, "0x" + hex.EncodeToString(c.ID[:]), "0x" + hex.EncodeToString(f.Hash[:]), "0x" + hex.EncodeToString(c.Root[:]), strconv.FormatUint(c.StartMDU, 10), c.StartLeaf, strconv.FormatUint(c.BlobCount, 10), strconv.FormatUint(c.BlobCount*types.BlobSizeBytes, 10), proofs}
}

// Resolve the actual key used by --from; an environment display override is not
// signing authority. Do this again before a submission or reconciled cleanup.
func retrievalSigner(ctx context.Context) (key, address string, err error) {
	key = envDefault("POLYSTORE_PROVIDER_KEY", "faucet")
	address, err = resolveKeyAddress(ctx, key)
	if err != nil {
		return "", "", err
	}
	decoded, err := sdk.AccAddressFromBech32(address)
	if err != nil || len(decoded) != 20 || decoded.String() != address {
		return "", "", fmt.Errorf("provider key returned a noncanonical account")
	}
	if override := strings.TrimSpace(os.Getenv("POLYSTORE_PROVIDER_ADDRESS")); override != "" && override != address {
		return "", "", fmt.Errorf("configured provider address differs from signing key")
	}
	return key, address, nil
}

func validateSessionFunding(s types.RetrievalSession) error {
	if s.LockedFee.IsNil() || s.LockedFee.IsNegative() {
		return fmt.Errorf("invalid locked session fee")
	}
	switch s.Purpose {
	case types.RetrievalSessionPurpose_RETRIEVAL_SESSION_PURPOSE_USER:
		switch s.Funding {
		case types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_DEAL_ESCROW:
			if s.Payer != "" {
				return fmt.Errorf("escrow session has unexpected payer")
			}
		case types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_REQUESTER:
			if s.Payer != s.Owner {
				return fmt.Errorf("requester funding does not match session owner")
			}
		default:
			return fmt.Errorf("invalid user session funding")
		}
	case types.RetrievalSessionPurpose_RETRIEVAL_SESSION_PURPOSE_PROTOCOL_AUDIT, types.RetrievalSessionPurpose_RETRIEVAL_SESSION_PURPOSE_PROTOCOL_REPAIR:
		if s.Funding != types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_PROTOCOL || s.Payer != authtypes.NewModuleAddress(types.ProtocolBudgetModuleName).String() {
			return fmt.Errorf("invalid protocol session funding")
		}
	default:
		return fmt.Errorf("unknown session purpose")
	}
	return nil
}

func serveFrozenRetrievalWindow(w http.ResponseWriter, r *http.Request, root ManifestRoot, index uint64, response *types.QueryGetRetrievalSessionResponse, height uint64) {
	started := time.Now()
	media, params, err := mime.ParseMediaType(r.Header.Get("Accept"))
	if err != nil || media != "multipart/form-data" || params["version"] != "2" {
		writeJSONError(w, http.StatusNotAcceptable, "retrieval v2 requires multipart/form-data; version=2", "")
		return
	}
	f, err := freezeRetrievalSessionResponse(response, height)
	if err != nil {
		status := http.StatusBadGateway
		if errors.Is(err, errChallengeNotReady) {
			status = http.StatusConflict
			w.Header().Set("Retry-After", "1")
		}
		writeJSONError(w, status, "retrieval challenge unavailable", err.Error())
		return
	}
	c, s := f.Context, f.Session
	idRaw := r.URL.Query().Get("deal_id")
	id, err := strconv.ParseUint(idRaw, 10, 64)
	if err != nil || strconv.FormatUint(id, 10) != idRaw || id != c.DealID || r.URL.Query().Get("owner") != s.Owner || root.Bytes != c.Root || index != c.StartMDU {
		writeJSONError(w, http.StatusBadRequest, "request does not match frozen session", "")
		return
	}
	for name, expected := range map[string]string{"X-PolyStore-Start-Blob-Index": strconv.FormatUint(uint64(c.StartLeaf), 10), "X-PolyStore-Blob-Count": strconv.FormatUint(c.BlobCount, 10)} {
		if supplied := r.Header.Get(name); supplied != "" && supplied != expected {
			writeJSONError(w, http.StatusBadRequest, "window hint does not match frozen session", "")
			return
		}
	}

	if err := validateSessionFunding(s); err != nil {
		writeJSONError(w, http.StatusBadGateway, "invalid session funding", err.Error())
		return
	}
	if !c.Window.Contains(height) || (s.Status != types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_OPEN && s.Status != types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_USER_CONFIRMED && s.Status != types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_PROOF_SUBMITTED) {
		writeJSONError(w, http.StatusConflict, "session is no longer eligible for delivery", "")
		return
	}
	_, signer, err := retrievalSigner(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusServiceUnavailable, "provider signing key unavailable", err.Error())
		return
	}
	if signer != s.AuthorizedProofProvider {
		writeJSONError(w, http.StatusForbidden, "session authorizes a different proof provider", "")
		return
	}
	ctx, release, err := admitRetrievalResponse(r.Context())
	if err != nil {
		w.Header().Set("Retry-After", "1")
		writeJSONError(w, http.StatusServiceUnavailable, "provider proof capacity is busy", "")
		return
	}
	defer release()
	r = r.WithContext(ctx)

	// Hold this frozen generation through the final response write.
	dir, releaseGeneration, err := openFrozenGeneration(c.DealID, root)
	defer releaseGeneration()
	if err != nil {
		writeJSONError(w, http.StatusNotFound, "retained generation unavailable", err.Error())
		return
	}
	// Timings describe this provider response, not delivery or user acknowledgement.
	// Session identity is public; never include request headers or signing material.
	generationStarted := time.Now()
	admissionMs := generationStarted.Sub(started).Seconds() * 1000
	var generationMs, persistMs, writeMs float64
	stage, success := "generation", false
	defer func() {
		log.Printf("provider-daemon retrieval timing session=%x admission_ms=%.3f generation_ms=%.3f persist_ms=%.3f write_ms=%.3f total_ms=%.3f stage=%s success=%t", c.ID, admissionMs, generationMs, persistMs, writeMs, time.Since(started).Seconds()*1000, stage, success)
	}()
	proofs, window, err := generateFrozenSessionProof(r.Context(), dir, f)
	generationMs = time.Since(generationStarted).Seconds() * 1000
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to produce authenticated session window", err.Error())
		return
	}
	stage = "persist"
	persistStarted := time.Now()
	metadata, err := json.Marshal(windowMetadata(f, proofs))
	if err != nil || len(metadata) > maxRetrievalMetadataBytes {
		writeJSONError(w, http.StatusInternalServerError, "session metadata exceeds response bound", "")
		return
	}
	// Persist a complete verified proof atomically before exposing bytes. A write
	// failure leaves it recoverable; this record is never evidence of a user ACK.
	err = storeFrozenSessionProof(f, proofs)
	persistMs = time.Since(persistStarted).Seconds() * 1000
	if err != nil {
		writeJSONError(w, http.StatusServiceUnavailable, "failed to persist session proof", err.Error())
		return
	}
	stage = "write"
	writeStarted := time.Now()
	err = writeRetrievalWindow(w, metadata, window)
	writeMs = time.Since(writeStarted).Seconds() * 1000
	if err != nil {
		log.Printf("provider-daemon retrieval response failed session=%x: %v", c.ID, err)
		return
	}
	stage, success = "complete", true
}

func writeRetrievalWindow(w http.ResponseWriter, metadata, window []byte) error {
	return writeRetrievalWindowVersion(w, metadata, window, "2")
}

func writeRetrievalWindowVersion(w http.ResponseWriter, metadata, window []byte, version string) error {
	if len(metadata) > maxRetrievalMetadataBytes || len(window) == 0 || len(window) > types.MDU_SIZE || len(window)%types.BLOB_SIZE != 0 {
		return fmt.Errorf("invalid retrieval response bounds")
	}
	if version != "2" && version != "3" {
		return fmt.Errorf("invalid retrieval response version")
	}
	writer := multipart.NewWriter(w)
	w.Header().Set("Content-Type", mime.FormatMediaType("multipart/form-data", map[string]string{"boundary": writer.Boundary(), "version": version}))
	w.Header().Set("Cache-Control", "no-store")
	h := make(textproto.MIMEHeader)
	h.Set("Content-Disposition", `form-data; name="metadata"`)
	h.Set("Content-Type", "application/json")
	part, err := writer.CreatePart(h)
	if err != nil {
		return err
	}
	if _, err = io.Copy(part, bytes.NewReader(metadata)); err != nil {
		return err
	}
	h.Set("Content-Disposition", `form-data; name="bytes"; filename="window.bin"`)
	h.Set("Content-Type", "application/octet-stream")
	part, err = writer.CreatePart(h)
	if err != nil {
		return err
	}
	if _, err = io.Copy(part, bytes.NewReader(window)); err != nil {
		return err
	}
	return writer.Close()
}

type storedFrozenProof struct {
	Version    uint32               `json:"version"`
	Context    []byte               `json:"context"`
	Hash       []byte               `json:"context_hash"`
	Seed       []byte               `json:"seed"`
	Proofs     []types.ChainedProof `json:"proofs"`
	TxHash     string               `json:"tx_hash,omitempty"`
	Submitting bool                 `json:"submitting,omitempty"`
}

func frozenProofKey(id [32]byte) []byte { return []byte("v2:" + hex.EncodeToString(id[:])) }
func storeFrozenSessionProof(f *frozenRetrievalSession, proofs []types.ChainedProof) error {
	if sessionDB == nil {
		return fmt.Errorf("session DB unavailable")
	}
	canonical, err := f.Context.Bytes()
	if err != nil {
		return err
	}
	record := storedFrozenProof{Version: 2, Context: canonical, Hash: f.Hash[:], Seed: f.Seed[:], Proofs: proofs}
	encoded, err := json.Marshal(record)
	if err != nil {
		return err
	}
	if len(encoded) > maxRetrievalMetadataBytes {
		return fmt.Errorf("stored proof exceeds limit")
	}
	return sessionDB.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(onChainSessionProofsBucket)
		if bucket == nil {
			return fmt.Errorf("session proof bucket missing")
		}
		key := frozenProofKey(f.Context.ID)
		if previous := bucket.Get(key); previous != nil {
			if len(previous) > maxRetrievalMetadataBytes {
				return fmt.Errorf("stored proof exceeds limit")
			}
			var existing storedFrozenProof
			if err := decodeStoredFrozenProof(previous, &existing); err != nil {
				return err
			}
			// A retry never erases a broadcast hash or changes the frozen statement.
			existing.TxHash = ""
			existing.Submitting = false
			normalized, err := json.Marshal(existing)
			if err != nil {
				return err
			}
			if !bytes.Equal(normalized, encoded) {
				return fmt.Errorf("conflicting stored session proof")
			}
			return nil
		}
		// Cleanup may lag abandoned-session traffic or an unavailable chain. Cap
		// retained records at the chain's live-session bound (<=1 GiB payload),
		// including unresolved broadcasts. Existing records remain retryable.
		cursor := bucket.Cursor()
		prefix := []byte("v2:")
		var count uint64
		for k, _ := cursor.Seek(prefix); k != nil && bytes.HasPrefix(k, prefix); k, _ = cursor.Next() {
			count++
			if count >= types.MaxLiveRetrievalSessionContexts {
				return fmt.Errorf("retained session proof capacity reached; retry after cleanup")
			}
		}
		return bucket.Put(key, encoded)
	})
}

func serveCommittedRetrievalMetadata(w http.ResponseWriter, r *http.Request, root ManifestRoot, index uint64) {
	q := r.URL.Query()
	id, err := strconv.ParseUint(q.Get("deal_id"), 10, 64)
	if err != nil || strconv.FormatUint(id, 10) != q.Get("deal_id") || q.Get("owner") == "" || len(q["deal_id"]) != 1 || len(q["owner"]) != 1 {
		writeJSONError(w, http.StatusBadRequest, "deal_id and owner are required", "")
		return
	}
	var height uint64
	if raw, present := q["committed_height"]; present {
		if len(raw) != 1 {
			writeJSONError(w, http.StatusBadRequest, "invalid committed_height", "")
			return
		}
		height, err = strconv.ParseUint(raw[0], 10, 64)
		if err != nil || height == 0 || strconv.FormatUint(height, 10) != raw[0] {
			writeJSONError(w, http.StatusBadRequest, "invalid committed_height", "")
			return
		}
	}
	deal, committed, err := queryRetrievalDeal(r.Context(), id, height)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "committed metadata authority unavailable", err.Error())
		return
	}
	if deal.Owner != q.Get("owner") || !bytes.Equal(deal.ManifestRoot, root.Bytes[:]) {
		writeJSONError(w, http.StatusConflict, "metadata does not match committed deal", "")
		return
	}
	if index >= deal.TotalMdus || index > deal.WitnessMdus {
		writeJSONError(w, http.StatusBadRequest, "metadata index out of range", "open a retrieval session for user data")
		return
	}
	dir, release, err := openFrozenGeneration(id, root)
	defer release()
	if err != nil {
		writeJSONError(w, http.StatusNotFound, "metadata generation unavailable", err.Error())
		return
	}
	f, err := os.Open(filepath.Join(dir, fmt.Sprintf("mdu_%d.bin", index)))
	if err != nil {
		writeJSONError(w, http.StatusNotFound, "metadata MDU unavailable", err.Error())
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() != types.MDU_SIZE {
		writeJSONError(w, http.StatusConflict, "metadata MDU has invalid size or type", "")
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.Itoa(types.MDU_SIZE))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set(committedHeightHeader, strconv.FormatUint(committed, 10))
	w.Header().Set("X-PolyStore-Manifest-Root", root.Canonical)
	w.Header().Set("X-PolyStore-Mdu-Index", strconv.FormatUint(index, 10))
	if _, err := io.CopyN(w, f, types.MDU_SIZE); err != nil {
		log.Printf("Retrieval metadata stream interrupted: deal=%d mdu=%d: %v", id, index, err)
	}
}

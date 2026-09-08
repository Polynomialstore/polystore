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
	"strconv"
	"strings"

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

	// This resolver will become a lease held through the final write when the
	// shared generation-retention guard is integrated in this same change.
	dir, err := resolveDealDirForDeal(c.DealID, root, root.Canonical)
	if err != nil {
		writeJSONError(w, http.StatusNotFound, "retained generation unavailable", err.Error())
		return
	}
	proofs, window, err := generateFrozenSessionProof(r.Context(), dir, f)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to produce authenticated session window", err.Error())
		return
	}
	metadata, err := json.Marshal(windowMetadata(f, proofs))
	if err != nil || len(metadata) > maxRetrievalMetadataBytes {
		writeJSONError(w, http.StatusInternalServerError, "session metadata exceeds response bound", "")
		return
	}
	// Persist a complete verified proof atomically before exposing bytes. A write
	// failure leaves it recoverable; this record is never evidence of a user ACK.
	if err := storeFrozenSessionProof(f, proofs); err != nil {
		writeJSONError(w, http.StatusServiceUnavailable, "failed to persist session proof", err.Error())
		return
	}
	if err := writeRetrievalWindow(w, metadata, window); err != nil {
		log.Printf("provider-daemon retrieval response failed session=%x: %v", c.ID, err)
	}
}

func writeRetrievalWindow(w http.ResponseWriter, metadata, window []byte) error {
	if len(metadata) > maxRetrievalMetadataBytes || len(window) == 0 || len(window) > types.MDU_SIZE || len(window)%types.BLOB_SIZE != 0 {
		return fmt.Errorf("invalid retrieval response bounds")
	}
	writer := multipart.NewWriter(w)
	w.Header().Set("Content-Type", mime.FormatMediaType("multipart/form-data", map[string]string{"boundary": writer.Boundary(), "version": "2"}))
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
	Version uint32               `json:"version"`
	Context []byte               `json:"context"`
	Hash    []byte               `json:"context_hash"`
	Seed    []byte               `json:"seed"`
	Proofs  []types.ChainedProof `json:"proofs"`
	TxHash  string               `json:"tx_hash,omitempty"`
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
			if err := json.Unmarshal(previous, &existing); err != nil {
				return err
			}
			// A retry never erases a broadcast hash or changes the frozen statement.
			existing.TxHash = ""
			normalized, err := json.Marshal(existing)
			if err != nil {
				return err
			}
			if !bytes.Equal(normalized, encoded) {
				return fmt.Errorf("conflicting stored session proof")
			}
			return nil
		}
		return bucket.Put(key, encoded)
	})
}

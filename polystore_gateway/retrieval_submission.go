package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"slices"
	"sort"
	"sync"
	"time"

	bolt "go.etcd.io/bbolt"
	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/types"
)

const maxSessionProofRequestBytes = 16 * 1024
const maxSessionProofOutcomeBytes = 64 * 1024

// Proof submission includes CLI simulation/signing plus bounded commit polling.
var sessionProofHTTPClient = &http.Client{Timeout: 2 * time.Minute}

// No queue: requests sharing a session or actual signer retry explicitly. The
// same guard covers serving before its chain query through its final write, so
// a late store cannot recreate a record after committed cleanup.
var retrievalOperations = struct {
	sync.Mutex
	sessions map[string]bool
	signers  map[string]bool
}{sessions: make(map[string]bool), signers: make(map[string]bool)}

func claimRetrievalOperations(ids []string, signer string) (func(), error) {
	retrievalOperations.Lock()
	defer retrievalOperations.Unlock()
	if len(retrievalOperations.sessions)+len(ids) > 256 || (signer != "" && (retrievalOperations.signers[signer] || len(retrievalOperations.signers) >= 4)) {
		return nil, fmt.Errorf("retrieval submission capacity or signer busy")
	}
	for _, id := range ids {
		if retrievalOperations.sessions[id] {
			return nil, fmt.Errorf("retrieval session busy")
		}
	}
	for _, id := range ids {
		retrievalOperations.sessions[id] = true
	}
	if signer != "" {
		retrievalOperations.signers[signer] = true
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			retrievalOperations.Lock()
			defer retrievalOperations.Unlock()
			for _, id := range ids {
				delete(retrievalOperations.sessions, id)
			}
			delete(retrievalOperations.signers, signer)
		})
	}, nil
}

type sessionProofRequest struct {
	SessionID  string   `json:"session_id,omitempty"`
	SessionIDs []string `json:"session_ids,omitempty"`
	Provider   string   `json:"provider,omitempty"`
}

func readSessionProofRequest(r io.Reader) ([]byte, sessionProofRequest, []string, error) {
	var request sessionProofRequest
	body, err := io.ReadAll(io.LimitReader(r, maxSessionProofRequestBytes+1))
	if err != nil {
		return nil, request, nil, err
	}
	if len(body) > maxSessionProofRequestBytes {
		return nil, request, nil, fmt.Errorf("session proof request exceeds limit")
	}
	if err := validateJSONObject(body); err != nil {
		return nil, request, nil, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		return nil, request, nil, err
	}
	for field := range fields {
		switch field {
		case "session_id", "session_ids", "provider", "deal_id":
		default:
			return nil, request, nil, fmt.Errorf("unknown session proof field %q", field)
		}
	}
	_, single := fields["session_id"]
	_, plural := fields["session_ids"]
	if single == plural {
		return nil, request, nil, fmt.Errorf("expected exactly one of session_id or session_ids")
	}
	if err := json.Unmarshal(body, &request); err != nil {
		return nil, request, nil, err
	}
	ids := request.SessionIDs
	if single {
		ids = []string{request.SessionID}
	}
	if len(ids) == 0 || len(ids) > 64 {
		return nil, request, nil, fmt.Errorf("expected 1..64 sessions")
	}
	seen := make(map[string]bool, len(ids))
	for i, raw := range ids {
		id, _, err := parseSessionIDHex(raw)
		if err != nil {
			return nil, request, nil, err
		}
		if seen[id] {
			return nil, request, nil, fmt.Errorf("duplicate session_id")
		}
		seen[id] = true
		ids[i] = id
	}
	return body, request, ids, nil
}

// One durable marker per actual account quarantines unknown broadcasts across
// retrieval and system-proof paths. This is an index in the existing DB, not a
// job queue: only caller-driven reconciliation can clear it.
type pendingSignerOperation struct {
	Kind   string   `json:"kind"`
	IDs    []string `json:"ids"`
	TxHash string   `json:"tx_hash,omitempty"`
}

var pendingSignerPrefix = []byte("pending-signer:")

func pendingSignerKey(signer string) []byte {
	return append(bytes.Clone(pendingSignerPrefix), signer...)
}

func decodePendingSigner(raw []byte, out *pendingSignerOperation) error {
	if len(raw) == 0 || len(raw) > maxSessionProofRequestBytes {
		return fmt.Errorf("invalid pending signer record size")
	}
	if err := validateJSONObject(raw); err != nil {
		return err
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(out); err != nil {
		return err
	}
	if (out.Kind != "retrieval" && out.Kind != "audit" && out.Kind != "generation-v3") || len(out.IDs) == 0 || len(out.IDs) > 64 {
		return fmt.Errorf("invalid pending signer identity")
	}
	seen := make(map[string]bool, len(out.IDs))
	for _, id := range out.IDs {
		if id == "" || len(id) > 128 || seen[id] {
			return fmt.Errorf("invalid pending operation ID")
		}
		seen[id] = true
	}
	if out.TxHash != "" {
		h, err := normalizeTxHash(out.TxHash)
		if err != nil || h != out.TxHash {
			return fmt.Errorf("invalid pending signer hash")
		}
	}
	return nil
}

func loadPendingSigner(signer string) (*pendingSignerOperation, error) {
	if sessionDB == nil {
		return nil, fmt.Errorf("session DB unavailable")
	}
	var out *pendingSignerOperation
	err := sessionDB.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(onChainSessionProofsBucket)
		if b == nil {
			return fmt.Errorf("proof bucket missing")
		}
		raw := b.Get(pendingSignerKey(signer))
		if raw == nil {
			return nil
		}
		out = &pendingSignerOperation{}
		return decodePendingSigner(raw, out)
	})
	return out, err
}

func claimPendingSigner(tx *bolt.Tx, signer string, operation pendingSignerOperation) error {
	b := tx.Bucket(onChainSessionProofsBucket)
	if b == nil {
		return fmt.Errorf("proof bucket missing")
	}
	raw, err := json.Marshal(operation)
	if err != nil {
		return err
	}
	var checked pendingSignerOperation
	if err := decodePendingSigner(raw, &checked); err != nil {
		return err
	}
	key := pendingSignerKey(signer)
	if previous := b.Get(key); previous != nil {
		var old pendingSignerOperation
		if err := decodePendingSigner(previous, &old); err != nil {
			return err
		}
		if old.Kind != operation.Kind || !slices.Equal(old.IDs, operation.IDs) || (old.TxHash != "" && old.TxHash != operation.TxHash) {
			return fmt.Errorf("actual signer has an unresolved %s operation", old.Kind)
		}
	} else {
		// Prefix seek visits at most four markers, independent of proof history.
		count := 0
		cursor := b.Cursor()
		for k, _ := cursor.Seek(pendingSignerPrefix); k != nil && bytes.HasPrefix(k, pendingSignerPrefix); k, _ = cursor.Next() {
			count++
			if count >= 4 {
				return fmt.Errorf("pending signer capacity reached")
			}
		}
	}
	return b.Put(key, raw)
}

func clearPendingSigner(tx *bolt.Tx, signer, kind string, ids []string) error {
	b := tx.Bucket(onChainSessionProofsBucket)
	if b == nil {
		return fmt.Errorf("proof bucket missing")
	}
	key := pendingSignerKey(signer)
	raw := b.Get(key)
	if raw == nil {
		return nil
	}
	var old pendingSignerOperation
	if err := decodePendingSigner(raw, &old); err != nil {
		return err
	}
	if old.Kind != kind || !slices.Equal(old.IDs, ids) {
		return fmt.Errorf("reconcile the original %s operation IDs %v", old.Kind, old.IDs)
	}
	return b.Delete(key)
}

func decodeStoredFrozenProof(raw []byte, record *storedFrozenProof) error {
	if len(raw) == 0 || len(raw) > maxRetrievalMetadataBytes {
		return fmt.Errorf("stored proof missing or exceeds limit")
	}
	if err := validateJSONObject(raw); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(record); err != nil {
		return err
	}
	if record.Version != 2 || len(record.Hash) != 32 || len(record.Seed) != 32 || len(record.Proofs) == 0 || len(record.Proofs) > 64 {
		return fmt.Errorf("invalid stored proof shape")
	}
	if record.TxHash != "" {
		hash, err := normalizeTxHash(record.TxHash)
		if err != nil || hash != record.TxHash {
			return fmt.Errorf("invalid stored transaction hash")
		}
	}
	return nil
}

type frozenSubmission struct {
	frozen   *frozenRetrievalSession
	response *types.QueryGetRetrievalSessionResponse
	record   storedFrozenProof
	raw      []byte
}

func loadFrozenSubmission(f *frozenRetrievalSession) (*frozenSubmission, error) {
	if sessionDB == nil {
		return nil, fmt.Errorf("session DB unavailable")
	}
	out := &frozenSubmission{frozen: f}
	err := sessionDB.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(onChainSessionProofsBucket)
		if b == nil {
			return fmt.Errorf("proof bucket missing")
		}
		raw := b.Get(frozenProofKey(f.Context.ID))
		if raw == nil {
			return os.ErrNotExist
		}
		if err := decodeStoredFrozenProof(raw, &out.record); err != nil {
			return err
		}
		out.raw = bytes.Clone(raw)
		return nil
	})
	if err != nil {
		return nil, err
	}
	canonical, _ := f.Context.Bytes()
	if !bytes.Equal(out.record.Context, canonical) || !bytes.Equal(out.record.Hash, f.Hash[:]) || uint64(len(out.record.Proofs)) != f.Context.BlobCount {
		return nil, fmt.Errorf("stored proof does not match frozen challenge")
	}
	return out, nil
}

func validateStoredSessionProof(s *frozenSubmission) error {
	f, r := s.frozen, &s.record
	if !bytes.Equal(f.Seed[:], r.Seed) {
		return fmt.Errorf("stored proof challenge seed mismatch")
	}
	expected, err := f.Context.Challenges(f.Seed[:])
	if err != nil {
		return err
	}
	// Stored/new wire lists are already bounded. Normalize once by full tuple,
	// then require the entire ordered C2 set before any native crypto call.
	sort.Slice(r.Proofs, func(i, j int) bool {
		a, b := r.Proofs[i], r.Proofs[j]
		if a.MduIndex != b.MduIndex {
			return a.MduIndex < b.MduIndex
		}
		return a.BlobIndex < b.BlobIndex
	})
	if len(expected) != len(r.Proofs) {
		return fmt.Errorf("incomplete stored challenge range")
	}
	for i, ch := range expected {
		p := r.Proofs[i]
		if p.MduIndex != ch.MDUIndex || p.BlobIndex != ch.LeafIndex || !bytes.Equal(p.ZValue, ch.Z[:]) {
			return fmt.Errorf("stored proof tuple or z mismatch")
		}
	}
	valid, err := crypto_ffi.VerifyPolyFSSessionProofBatch(f.Context.Root[:], f.Hash[:], f.Seed[:], uint64(64/f.Context.K)*uint64(f.Context.K+f.Context.M), r.Proofs)
	if err != nil {
		return err
	}
	if !valid {
		return fmt.Errorf("stored session proof verification failed")
	}
	return nil
}

// Compare-and-update inside one existing bbolt transaction. Failed cleanup is
// reported separately; another identity or later record is never removed.
func changeFrozenSubmissions(entries []*frozenSubmission, update func(*storedFrozenProof), remove bool, signerChange ...func(*bolt.Tx) error) error {
	if sessionDB == nil {
		return fmt.Errorf("session DB unavailable")
	}
	next := make([][]byte, len(entries))
	err := sessionDB.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(onChainSessionProofsBucket)
		if b == nil {
			return fmt.Errorf("proof bucket missing")
		}
		for i, s := range entries {
			key := frozenProofKey(s.frozen.Context.ID)
			if !bytes.Equal(b.Get(key), s.raw) {
				return fmt.Errorf("stored proof changed during submission")
			}
			if remove {
				if err := b.Delete(key); err != nil {
					return err
				}
				continue
			}
			r := s.record
			update(&r)
			raw, err := json.Marshal(r)
			if err != nil {
				return err
			}
			if len(raw) > maxRetrievalMetadataBytes {
				return fmt.Errorf("stored proof exceeds limit")
			}
			if err := b.Put(key, raw); err != nil {
				return err
			}
			next[i] = raw
		}
		for _, change := range signerChange {
			if err := change(tx); err != nil {
				return err
			}
		}
		return nil
	})
	if err == nil && !remove {
		for i, s := range entries {
			update(&s.record)
			s.raw = next[i]
		}
	}
	return err
}

// Only a matching, committed nonzero result authorizes this reset. Keep the
// frozen proofs unchanged for a later caller's freshly validated retry or GC.
func resetFailedFrozenSubmissions(entries []*frozenSubmission, signer string, ids []string, hash string) error {
	canonical, err := normalizeTxHash(hash)
	if err != nil || canonical != hash || len(entries) == 0 || len(entries) != len(ids) {
		return fmt.Errorf("invalid failed submission identity")
	}
	for i, entry := range entries {
		if !entry.record.Submitting || entry.record.TxHash != hash || fmt.Sprintf("0x%x", entry.frozen.Context.ID) != ids[i] {
			return fmt.Errorf("stored submission does not match failed transaction")
		}
	}
	return changeFrozenSubmissions(entries, func(r *storedFrozenProof) {
		r.Submitting, r.TxHash = false, ""
	}, false, func(tx *bolt.Tx) error {
		b := tx.Bucket(onChainSessionProofsBucket)
		if raw := b.Get(pendingSignerKey(signer)); raw != nil {
			var marker pendingSignerOperation
			if err := decodePendingSigner(raw, &marker); err != nil {
				return err
			}
			if marker.TxHash != hash {
				return fmt.Errorf("signer hash changed during failed submission recovery")
			}
		}
		// Earlier versions cleared only the marker on committed failure. Permit
		// repairing those records, but never clear a different/newer operation.
		return clearPendingSigner(tx, signer, "retrieval", ids)
	})
}

func writeSubmissionOutcome(w http.ResponseWriter, request sessionProofRequest, ids []string, count int, hash, status, cleanup string, err error) {
	result := map[string]any{"status": status, "tx_hash": hash, "proof_count": count}
	if request.SessionIDs != nil {
		result["session_ids"] = ids
	} else {
		result["session_id"] = ids[0]
	}
	if cleanup != "" {
		result["cleanup_status"] = cleanup
	}
	if err != nil {
		result["error"] = err.Error()
	}
	w.Header().Set("Content-Type", "application/json")
	if status == "pending" {
		w.WriteHeader(http.StatusAccepted)
	} else if status == "failed" {
		w.WriteHeader(http.StatusConflict)
	}
	_ = json.NewEncoder(w).Encode(result)
}

func SpSubmitRetrievalSessionProof(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if !isGatewayAuthorized(r) {
		writeJSONError(w, http.StatusForbidden, "forbidden", "")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	body, request, ids, err := readSessionProofRequest(r.Body)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid session proof request", err.Error())
		return
	}
	key, signer, err := retrievalSigner(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "provider signing key unavailable", err.Error())
		return
	}
	if request.Provider != "" && request.Provider != signer {
		writeJSONError(w, http.StatusForbidden, "routing provider differs from actual signing key", "")
		return
	}
	release, err := claimRetrievalOperations(ids, signer)
	if err != nil {
		writeJSONError(w, http.StatusTooManyRequests, "retrieval submission busy", err.Error())
		return
	}
	defer release()
	entries := make([]*frozenSubmission, 0, len(ids))
	totalBytes, proofCount, completed := 0, 0, 0
	for _, id := range ids {
		response, height, err := queryRetrievalSession(r.Context(), id)
		if err != nil {
			writeJSONError(w, http.StatusBadGateway, "session authority unavailable", err.Error())
			return
		}
		if response.Session.ChallengeVersion == 0 && len(ids) == 1 && request.SessionIDs == nil {
			r.Body = io.NopCloser(bytes.NewReader(body))
			submitLegacyRetrievalSessionProof(w, r)
			return
		}
		f, err := frozenRetrievalIdentity(response, height)
		if err != nil {
			writeJSONError(w, http.StatusConflict, "invalid frozen session", err.Error())
			return
		}
		if f.Session.AuthorizedProofProvider != signer {
			writeJSONError(w, http.StatusForbidden, "session does not authorize signing key", "")
			return
		}
		if err := validateSessionFunding(f.Session); err != nil {
			writeJSONError(w, http.StatusConflict, "invalid session funding", err.Error())
			return
		}
		entry, err := loadFrozenSubmission(f)
		if errors.Is(err, os.ErrNotExist) && f.Session.Status == types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_COMPLETED {
			completed++
			proofCount += int(f.Context.BlobCount)
			continue
		}
		if err != nil {
			writeJSONError(w, http.StatusConflict, "stored proof unavailable; retained for diagnosis", err.Error())
			return
		}
		entry.response = response
		entries = append(entries, entry)
		totalBytes += len(entry.raw)
		proofCount += len(entry.record.Proofs)
		if totalBytes > types.MaxTransactionBytes-4096 {
			writeJSONError(w, http.StatusRequestEntityTooLarge, "session proof batch exceeds unsigned size budget", "")
			return
		}
		if f.Session.Status == types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_COMPLETED {
			completed++
			continue
		}
	}
	finish := func(hash, status string) {
		cleanup := "complete"
		err := changeFrozenSubmissions(entries, nil, true, func(tx *bolt.Tx) error { return clearPendingSigner(tx, signer, "retrieval", ids) })
		if err != nil {
			cleanup = "pending"
		}
		writeSubmissionOutcome(w, request, ids, proofCount, hash, status, cleanup, err)
	}
	// V2 completion retains the immutable effective payee even after the anchor
	// and temporary proof-provider index are pruned. All identities matched above.
	if completed == len(ids) {
		finish("", "reconciled")
		return
	}
	if len(entries) != len(ids) {
		writeJSONError(w, http.StatusConflict, "reconcile completed sessions separately before a new batch", "")
		return
	}
	var pendingHash string
	pending := 0
	for _, entry := range entries {
		if entry.record.Submitting || entry.record.TxHash != "" {
			pending++
			if entry.record.TxHash == "" {
				writeSubmissionOutcome(w, request, ids, proofCount, "", "pending", "retained", fmt.Errorf("submission interrupted before hash persistence; awaiting matching terminal session"))
				return
			}
			if pendingHash != "" && pendingHash != entry.record.TxHash {
				writeJSONError(w, http.StatusConflict, "reconcile separate prior transactions individually", "")
				return
			}
			pendingHash = entry.record.TxHash
		}
	}
	if pending > 0 {
		if pending != len(entries) {
			writeJSONError(w, http.StatusConflict, "reconcile pending sessions before a new batch", "")
			return
		}
		hash, err := waitForCommittedTx(r.Context(), pendingHash)
		if err == nil {
			finish(hash, "success")
			return
		}
		status := "pending"
		if errors.Is(err, errTxFailed) {
			status = "failed"
			if clearErr := resetFailedFrozenSubmissions(entries, signer, ids, hash); clearErr != nil {
				err = fmt.Errorf("%w; local recovery: %v", err, clearErr)
			}
		}
		writeSubmissionOutcome(w, request, ids, proofCount, hash, status, "retained", err)
		return
	}
	if operation, err := loadPendingSigner(signer); err != nil || operation != nil {
		if err == nil {
			err = fmt.Errorf("actual signer awaits %s reconciliation for IDs %v", operation.Kind, operation.IDs)
		}
		writeSubmissionOutcome(w, request, ids, proofCount, "", "pending", "retained", err)
		return
	}
	msgs := make([]types.MsgSubmitRetrievalSessionProof, len(entries))
	for i, entry := range entries {
		f, err := freezeRetrievalSessionResponse(entry.response, entry.frozen.Height)
		if err != nil {
			writeJSONError(w, http.StatusConflict, "session challenge unavailable", err.Error())
			return
		}
		entry.frozen = f
		if !f.Context.Window.Contains(f.Height) {
			writeJSONError(w, http.StatusConflict, "session is terminal or outside its proof window; reconcile separately", "")
			return
		}
		switch f.Session.Status {
		case types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_OPEN, types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_USER_CONFIRMED, types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_PROOF_SUBMITTED, types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_COMPLETED:
		default:
			writeJSONError(w, http.StatusConflict, "session does not accept proofs", "")
			return
		}
		if err := validateStoredSessionProof(entry); err != nil {
			writeJSONError(w, http.StatusConflict, "invalid stored session proof", err.Error())
			return
		}
		msgs[i] = types.MsgSubmitRetrievalSessionProof{Creator: signer, SessionId: f.Session.SessionId, Proofs: entry.record.Proofs}
	}
	var input any = msgs[0]
	if request.SessionIDs != nil {
		input = struct {
			Sessions []types.MsgSubmitRetrievalSessionProof `json:"sessions"`
		}{msgs}
	}
	encoded, err := json.Marshal(input)
	if err != nil || len(encoded) > types.MaxTransactionBytes-4096 {
		writeJSONError(w, http.StatusRequestEntityTooLarge, "unsigned proof input exceeds limit", "")
		return
	}
	file, err := os.CreateTemp(uploadDir, "session-proof-*.json")
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "cannot create proof input", err.Error())
		return
	}
	defer os.Remove(file.Name())
	_, writeErr := file.Write(encoded)
	closeErr := file.Close()
	if writeErr != nil || closeErr != nil {
		writeJSONError(w, http.StatusInternalServerError, "cannot write proof input", "")
		return
	}
	if err := changeFrozenSubmissions(entries, func(r *storedFrozenProof) { r.Submitting = true }, false, func(tx *bolt.Tx) error {
		return claimPendingSigner(tx, signer, pendingSignerOperation{Kind: "retrieval", IDs: ids})
	}); err != nil {
		writeJSONError(w, http.StatusConflict, "cannot persist submission intent", err.Error())
		return
	}
	hash, err := submitTxAndRecord(r.Context(), func(hash string) error {
		return changeFrozenSubmissions(entries, func(r *storedFrozenProof) { r.TxHash = hash }, false, func(tx *bolt.Tx) error {
			return claimPendingSigner(tx, signer, pendingSignerOperation{Kind: "retrieval", IDs: ids, TxHash: hash})
		})
	},
		"tx", "polystorechain", "submit-retrieval-proof", file.Name(), "--from", key, "--chain-id", chainID, "--home", homeDir, "--keyring-backend", "test", "--yes", "--gas", "auto", "--gas-adjustment", "1.6", "--gas-prices", gasPrices, "--broadcast-mode", "sync", "--output", "json")
	if err == nil {
		finish(hash, "success")
		return
	}
	status := "pending"
	if errors.Is(err, errTxRejected) || errors.Is(err, errTxNotSubmitted) {
		status = "failed"
		if clearErr := changeFrozenSubmissions(entries, func(r *storedFrozenProof) { r.Submitting = false }, false, func(tx *bolt.Tx) error { return clearPendingSigner(tx, signer, "retrieval", ids) }); clearErr != nil {
			err = fmt.Errorf("%w; local recovery: %v", err, clearErr)
		}
	} else if errors.Is(err, errTxFailed) {
		status = "failed"
		if clearErr := resetFailedFrozenSubmissions(entries, signer, ids, hash); clearErr != nil {
			err = fmt.Errorf("%w; local recovery: %v", err, clearErr)
		}
	}
	writeSubmissionOutcome(w, request, ids, proofCount, hash, status, "retained", err)
}

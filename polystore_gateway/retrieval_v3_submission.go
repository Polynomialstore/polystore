package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/cosmos/gogoproto/jsonpb"
	"polystorechain/pkg/retrievalchallenge"
	"polystorechain/x/polystorechain/types"
)

func retrievalProofOperationV3(sessionID []byte, proofs []types.RetrievalSampleProofV3) pendingSignerOperation {
	prefix := hex.EncodeToString(sessionID) + ":"
	ids := make([]string, len(proofs))
	for i := range proofs {
		ids[i] = prefix + strconv.FormatUint(proofs[i].Ordinal, 10)
	}
	return pendingSignerOperation{Kind: "retrieval-v3", IDs: ids}
}

func parseRetrievalProofOperationV3(op *pendingSignerOperation) (string, []uint64, bool) {
	if op == nil || op.Kind != "retrieval-v3" || len(op.IDs) == 0 {
		return "", nil, false
	}
	prefix, _, ok := strings.Cut(op.IDs[0], ":")
	if !ok || len(prefix) != 64 {
		return "", nil, false
	}
	decoded, err := hex.DecodeString(prefix)
	if err != nil || hex.EncodeToString(decoded) != prefix {
		return "", nil, false
	}
	ordinals := make([]uint64, len(op.IDs))
	seen := make(map[uint64]struct{}, len(op.IDs))
	for i, id := range op.IDs {
		gotPrefix, rawOrdinal, ok := strings.Cut(id, ":")
		ordinal, err := strconv.ParseUint(rawOrdinal, 10, 64)
		if !ok || strings.Contains(rawOrdinal, ":") || gotPrefix != prefix || err != nil || strconv.FormatUint(ordinal, 10) != rawOrdinal || ordinal >= retrievalchallenge.MaxLargeSessionSamples {
			return "", nil, false
		}
		if _, duplicate := seen[ordinal]; duplicate {
			return "", nil, false
		}
		seen[ordinal] = struct{}{}
		ordinals[i] = ordinal
	}
	return prefix, ordinals, true
}

func pendingRetrievalProofsAcceptedV3(op *pendingSignerOperation, session types.RetrievalSessionV3) bool {
	if op == nil || op.Kind != "retrieval-v3" || len(session.SessionId) != 32 || len(session.AcceptedSampleBitmap) != v3SampleBitmapBytes {
		return false
	}
	prefix, ordinals, ok := parseRetrievalProofOperationV3(op)
	if !ok || prefix != hex.EncodeToString(session.SessionId) {
		return false
	}
	for _, ordinal := range ordinals {
		if ordinal >= session.SampleCount || !v3BitmapSet(session.AcceptedSampleBitmap, ordinal) {
			return false
		}
	}
	return true
}

func writeRetrievalV3RecoveryOutcome(w http.ResponseWriter, status, recordedSessionID, hash string, proofs int, cleanup string, err error) {
	result := map[string]any{"status": status, "recorded_session_id": recordedSessionID, "tx_hash": hash, "proof_count": proofs, "cleanup_status": cleanup, "retry_required": true}
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

type retrievalV3ProviderTiming struct {
	Schema              string                    `json:"schema"`
	AuthorityNS         uint64                    `json:"authority_ns"`
	ProofPreparationNS  uint64                    `json:"proof_preparation_ns"`
	SubmissionAttempts  []submissionAttemptTiming `json:"submission_attempts"`
	CommitObservationNS uint64                    `json:"commit_observation_ns"`
	ProviderTotalNS     uint64                    `json:"provider_total_ns"`
}

func writeRetrievalV3Outcome(w http.ResponseWriter, status, sessionID, hash string, slot uint32, proofs, remaining int, cleanup string, timing *retrievalV3ProviderTiming, err error) {
	result := map[string]any{"status": status, "session_id": sessionID, "tx_hash": hash, "slot": slot, "proof_count": proofs, "remaining": remaining, "cleanup_status": cleanup}
	if timing != nil && status == "success" && err == nil {
		result["timing"] = timing
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

// submitRetrievalSessionProofV3 runs under the existing per-session and signer
// in-memory locks held by SpSubmitRetrievalSessionProof.
func submitRetrievalSessionProofV3(w http.ResponseWriter, ctx context.Context, keyName, signer, sessionID string) {
	// SpSubmitRetrievalSessionProof has already selected V3 and acquired the
	// session/signer admission locks. ProviderTotalNS begins at this V3 dispatch.
	providerStarted := time.Now()
	pending, err := loadPendingSigner(signer)
	if err != nil {
		writeJSONError(w, http.StatusConflict, "v3 proof reconciliation state unavailable", err.Error())
		return
	}
	if pending != nil && pending.Kind != "retrieval-v3" {
		writeJSONError(w, http.StatusConflict, "provider signer has unresolved operation", fmt.Sprintf("actual signer awaits %s reconciliation", pending.Kind))
		return
	}
	recordedSessionID := ""
	if pending != nil {
		var ok bool
		recordedSessionID, _, ok = parseRetrievalProofOperationV3(pending)
		if !ok {
			writeJSONError(w, http.StatusConflict, "invalid v3 proof reconciliation identity", "stored proof ordinals do not bind one canonical session")
			return
		}
	}
	if pending != nil && pending.TxHash != "" {
		hash, waitErr := waitForCommittedTx(ctx, pending.TxHash)
		if waitErr == nil || errors.Is(waitErr, errTxFailed) {
			if clearErr := updatePendingSignerV3(signer, *pending, true); clearErr != nil {
				writeJSONError(w, http.StatusConflict, "v3 proof cleanup pending", clearErr.Error())
				return
			}
		}
		if waitErr != nil {
			if errors.Is(waitErr, errTxFailed) {
				writeRetrievalV3RecoveryOutcome(w, "failed", recordedSessionID, pending.TxHash, len(pending.IDs), "complete", waitErr)
				return
			}
			writeRetrievalV3RecoveryOutcome(w, "pending", recordedSessionID, pending.TxHash, len(pending.IDs), "retained", waitErr)
			return
		}
		writeRetrievalV3RecoveryOutcome(w, "reconciled", recordedSessionID, hash, len(pending.IDs), "complete", nil)
		return
	}
	querySessionID := sessionID
	if pending != nil {
		querySessionID = recordedSessionID
	}
	response, height, err := queryRetrievalSessionV3(ctx, querySessionID)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "v3 session authority unavailable", err.Error())
		return
	}
	if pending != nil && pendingRetrievalProofsAcceptedV3(pending, response.Session) {
		if err := updatePendingSignerV3(signer, *pending, true); err != nil {
			writeJSONError(w, http.StatusConflict, "v3 proof cleanup pending", err.Error())
			return
		}
		writeRetrievalV3RecoveryOutcome(w, "reconciled", recordedSessionID, "", len(pending.IDs), "complete", nil)
		return
	}
	if pending != nil {
		writeRetrievalV3RecoveryOutcome(w, "pending", recordedSessionID, "", len(pending.IDs), "retained", fmt.Errorf("broadcast hash was not persisted and exact samples are not accepted"))
		return
	}
	frozen, err := freezeRetrievalSessionV3Response(response, height)
	if err != nil {
		writeJSONError(w, http.StatusConflict, "invalid frozen v3 session", err.Error())
		return
	}
	authorityNS := uint64(time.Since(providerStarted))
	proofStarted := time.Now()
	slot, proofs, remaining, err := buildProviderProofBatchV3(ctx, frozen, signer)
	proofPreparationNS := uint64(time.Since(proofStarted))
	if err != nil {
		writeJSONError(w, http.StatusConflict, "v3 session proof unavailable", err.Error())
		return
	}
	if len(proofs) == 0 {
		writeRetrievalV3Outcome(w, "reconciled", sessionID, "", slot, 0, remaining, "complete", nil, nil)
		return
	}
	// One obligation keeps the existing journal and HTTP contract while the
	// batch route aggregates its KZG openings in the native verifier.
	msg := &types.MsgSubmitRetrievalSessionProofBatchV3{Creator: signer, Sessions: []types.RetrievalSessionProofBatchEntryV3{{SessionId: frozen.Session.SessionId, Slot: slot, Proofs: proofs}}}
	file, err := os.CreateTemp(uploadDir, "session-proof-v3-*.json")
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "cannot create v3 proof input", err.Error())
		return
	}
	defer os.Remove(file.Name())
	marshaler := &jsonpb.Marshaler{OrigName: true}
	writeErr := marshaler.Marshal(file, msg)
	closeErr := file.Close()
	if writeErr != nil || closeErr != nil {
		writeJSONError(w, http.StatusInternalServerError, "cannot write v3 proof input", "")
		return
	}
	op := retrievalProofOperationV3(frozen.Session.SessionId, proofs)
	if err := updatePendingSignerV3(signer, op, false); err != nil {
		writeJSONError(w, http.StatusConflict, "cannot persist v3 proof intent", err.Error())
		return
	}
	hash, submissionTiming, err := submitTxAndRecordTiming(ctx, func(hash string) error {
		op.TxHash = hash
		return updatePendingSignerV3(signer, op, false)
	}, "tx", "polystorechain", "retrieval-session-v3", "prove-batch", file.Name(), "--from", keyName, "--chain-id", chainID, "--home", homeDir, "--keyring-backend", "test", "--yes", "--gas", "auto", "--gas-adjustment", "1.6", "--gas-prices", gasPrices, "--broadcast-mode", "sync", "--output", "json")
	cleanup := "retained"
	if err == nil || errors.Is(err, errTxFailed) || errors.Is(err, errTxRejected) || errors.Is(err, errTxNotSubmitted) {
		if clearErr := updatePendingSignerV3(signer, op, true); clearErr != nil {
			if err == nil {
				err = fmt.Errorf("transaction committed but local v3 proof cleanup remains pending: %w", clearErr)
			} else {
				err = fmt.Errorf("%w; local v3 proof cleanup remains pending: %v", err, clearErr)
			}
		} else {
			cleanup = "complete"
		}
	}
	status := "success"
	if err != nil {
		status = "pending"
		if errors.Is(err, errTxFailed) || errors.Is(err, errTxRejected) || errors.Is(err, errTxNotSubmitted) {
			status = "failed"
		}
	}
	var timing *retrievalV3ProviderTiming
	if err == nil && validV3SubmissionTiming(submissionTiming) {
		timing = &retrievalV3ProviderTiming{Schema: "polystore-v3-provider-timing-v1",
			AuthorityNS: authorityNS, ProofPreparationNS: proofPreparationNS,
			SubmissionAttempts:  submissionTiming.Attempts,
			CommitObservationNS: submissionTiming.CommitObservationNS,
			ProviderTotalNS:     uint64(time.Since(providerStarted))}
	}
	writeRetrievalV3Outcome(w, status, sessionID, hash, slot, len(proofs), remaining, cleanup, timing, err)
}

func validV3SubmissionTiming(value txSubmissionTiming) bool {
	if !value.Complete || len(value.Attempts) == 0 || len(value.Attempts) > 5 || value.CommitObservationNS == 0 {
		return false
	}
	const maxPhaseNS = uint64(90 * time.Second)
	if value.CommitObservationNS > maxPhaseNS {
		return false
	}
	for index, attempt := range value.Attempts {
		if attempt.Attempt != index+1 || attempt.PreBroadcastNS > maxPhaseNS ||
			attempt.BroadcastTxSyncNS > maxPhaseNS ||
			(index+1 < len(value.Attempts) && attempt.CheckTxCode != 32) ||
			(index+1 == len(value.Attempts) && attempt.CheckTxCode != 0) {
			return false
		}
	}
	return true
}

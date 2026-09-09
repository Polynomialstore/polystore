package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/gogoproto/jsonpb"
	bolt "go.etcd.io/bbolt"
	"polystorechain/pkg/retrievalchallenge"
	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/types"
)

const integrityLeavesV3File = "integrity_leaves_v3.bin"

const (
	generationVerificationBaseTimeoutV3   = 5 * time.Minute
	generationVerificationPerUserMDUV3    = 250 * time.Millisecond
	generationVerificationProgressEveryV3 = 60 * time.Second
	generationSubmissionTimeoutV3         = 2 * time.Minute
)

var errProviderNotAssignedV3 = errors.New("provider is not assigned to the generation")

type generationAcceptanceV3Request struct {
	DealID   uint64 `json:"deal_id"`
	Provider string `json:"provider,omitempty"`
}

func queryDealGenerationV3(ctx context.Context, deal uint64) (*types.QueryGetDealGenerationV3Response, uint64, error) {
	path := "/polystorechain/polystorechain/v1/deals/" + strconv.FormatUint(deal, 10) + "/generation-v3"
	body, height, err := readLCDJSON(ctx, path, 0, maxSessionQueryBytes)
	if errors.Is(err, errLCDNotFound) {
		return nil, 0, ErrSessionNotFound
	}
	if err != nil {
		return nil, 0, err
	}
	var response types.QueryGetDealGenerationV3Response
	if err := jsonpb.Unmarshal(bytes.NewReader(body), &response); err != nil {
		return nil, 0, fmt.Errorf("invalid v3 generation query: %w", err)
	}
	return &response, height, nil
}

func validateGenerationAdmissionV3(a *types.DealGenerationAdmissionV3, expectedDeal uint64) (retrievalGenerationKey, [12][20]byte, error) {
	var providers [12][20]byte
	setup, setupErr := hex.DecodeString(types.RetrievalSetupDigest)
	if a == nil || a.DealId != expectedDeal || a.ChainId != chainID || a.Generation == 0 || a.ProposedHeight <= 0 || len(a.PolyfsRoot) != 32 || len(a.IntegrityRoot) != 32 || len(a.SetupDigest) != 32 || setupErr != nil || !bytes.Equal(a.SetupDigest, setup) || len(a.Providers) != 12 || a.MetadataMdus < 2 || a.WitnessMdus != a.MetadataMdus-1 || a.UserMdus == 0 || a.MetadataMdus > 65536 || a.UserMdus > 65536-a.MetadataMdus || a.TotalMdus != a.MetadataMdus+a.UserMdus || a.UserMdus > retrievalchallenge.MaxIntegrityLeaves/retrievalchallenge.IntegrityLeavesPerUserMDU || a.IntegrityLeafCount != a.UserMdus*retrievalchallenge.IntegrityLeavesPerUserMDU || a.AcceptedSlotsMask&^uint32(0xfff) != 0 {
		return retrievalGenerationKey{}, providers, fmt.Errorf("invalid v3 generation snapshot")
	}
	key := retrievalGenerationKey{Chain: a.ChainId, Deal: a.DealId, Generation: a.Generation, Metadata: a.MetadataMdus, Users: a.UserMdus, Layout: retrievalchallenge.StripeK8M4, K: 8, M: 4, Version: 3}
	copy(key.Root[:], a.PolyfsRoot)
	copy(key.Integrity[:], a.IntegrityRoot)
	copy(key.Setup[:], a.SetupDigest)
	seen := make(map[[20]byte]struct{}, len(a.Providers))
	for i, raw := range a.Providers {
		address, err := sdk.AccAddressFromBech32(raw)
		if err != nil || len(address) != 20 || address.String() != raw {
			return retrievalGenerationKey{}, providers, fmt.Errorf("invalid v3 provider %d", i)
		}
		copy(providers[i][:], address)
		if _, duplicate := seen[providers[i]]; duplicate {
			return retrievalGenerationKey{}, providers, fmt.Errorf("duplicate v3 provider %d", i)
		}
		seen[providers[i]] = struct{}{}
	}
	return key, providers, nil
}

type contextReaderV3 struct {
	ctx context.Context
	r   io.Reader
}

func (r contextReaderV3) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.r.Read(p)
}

func verifyIntegrityVectorV3(ctx context.Context, dir string, key retrievalGenerationKey, slot uint32, metadata *authenticatedGeneration) error {
	path := filepath.Join(dir, integrityLeavesV3File)
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	wantSize := int64(key.Users * retrievalchallenge.IntegrityLeavesPerUserMDU * 32)
	if err != nil || !info.Mode().IsRegular() || info.Size() != wantSize {
		return fmt.Errorf("integrity leaf vector has invalid type or size")
	}
	root, err := retrievalchallenge.IntegrityRootV3Reader(bufio.NewReaderSize(contextReaderV3{ctx, f}, 1<<20), key.Users*retrievalchallenge.IntegrityLeavesPerUserMDU)
	if err != nil || root != key.Integrity {
		return fmt.Errorf("integrity leaf vector does not match authenticated header")
	}
	started := time.Now()
	nextProgress := started.Add(generationVerificationProgressEveryV3)
	for user := uint64(0); user < key.Users; user++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		mdu := key.Metadata + user
		authenticated, err := metadata.userMDUFor(ctx, dir, key, mdu)
		if err != nil {
			return err
		}
		shard, err := readExactArtifactRange(filepath.Join(dir, fmt.Sprintf("mdu_%d_slot_%d.bin", mdu, slot)), 8*types.BLOB_SIZE, 0, 8*types.BLOB_SIZE)
		if err != nil {
			return err
		}
		for row := uint32(0); row < 8; row++ {
			if err := ctx.Err(); err != nil {
				return err
			}
			leaf := slot*8 + row
			blob := shard[uint64(row)*types.BLOB_SIZE : uint64(row+1)*types.BLOB_SIZE]
			commitment, err := crypto_ffi.CommitReceivedBlob(blob)
			if err != nil || !bytes.Equal(commitment, authenticated.commitments[uint64(leaf)*48:uint64(leaf+1)*48]) {
				return fmt.Errorf("slot blob %d/%d does not match authenticated KZG commitment", mdu, leaf)
			}
			hash, err := retrievalchallenge.IntegrityLeafV3(mdu, leaf, blob)
			if err != nil {
				return err
			}
			position := user*retrievalchallenge.IntegrityLeavesPerUserMDU + uint64(leaf)
			var expected [32]byte
			if _, err := f.ReadAt(expected[:], int64(position*32)); err != nil || hash != expected {
				return fmt.Errorf("slot blob %d/%d does not match integrity vector", mdu, leaf)
			}
		}
		if now := time.Now(); !now.Before(nextProgress) {
			log.Printf("v3 generation verification progress deal=%d generation=%d slot=%d user_mdus=%d/%d elapsed=%s", key.Deal, key.Generation, slot, user+1, key.Users, now.Sub(started).Round(time.Second))
			nextProgress = now.Add(generationVerificationProgressEveryV3)
		}
	}
	return nil
}

func generationVerificationTimeoutV3(users uint64) (time.Duration, error) {
	maxUsers := retrievalchallenge.MaxIntegrityLeaves / retrievalchallenge.IntegrityLeavesPerUserMDU
	if users == 0 || users > maxUsers {
		return 0, fmt.Errorf("invalid v3 generation user MDU count")
	}
	return generationVerificationBaseTimeoutV3 + time.Duration(users)*generationVerificationPerUserMDUV3, nil
}

func claimGenerationVerificationV3(deal uint64, signer string) (func(), error) {
	return claimRetrievalOperations([]string{
		"generation-v3:" + strconv.FormatUint(deal, 10),
		"generation-verification-v3:" + signer,
	}, "")
}

type generationAcceptanceViewV3 struct {
	response   *types.QueryGetDealGenerationV3Response
	candidate  *types.DealGenerationAdmissionV3
	generation retrievalGenerationKey
	providers  [12][20]byte
	provider   [20]byte
	slot       int
	digest     [32]byte
	id         string
	root       ManifestRoot
}

func queryGenerationAcceptanceViewV3(ctx context.Context, deal uint64, signer string) (*generationAcceptanceViewV3, error) {
	response, height, err := queryDealGenerationV3(ctx, deal)
	if err != nil {
		return nil, err
	}
	candidate := response.Pending
	if candidate == nil {
		candidate = response.Admitted
	}
	generation, providers, err := validateGenerationAdmissionV3(candidate, deal)
	if err != nil || height == 0 || candidate == nil || uint64(candidate.ProposedHeight) > height {
		if err == nil {
			err = fmt.Errorf("v3 generation query lacks a committed proposal height")
		}
		return nil, err
	}
	provider, err := rawProviderV3(signer)
	if err != nil {
		return nil, err
	}
	slot := -1
	for i := range providers {
		if providers[i] == provider {
			if slot != -1 {
				return nil, fmt.Errorf("provider occupies multiple frozen slots")
			}
			slot = i
		}
	}
	if slot < 0 {
		return nil, errProviderNotAssignedV3
	}
	digest, err := generationAcceptanceDigestV3(generation, uint32(slot), provider)
	if err != nil {
		return nil, err
	}
	root, err := parseManifestRoot("0x" + hex.EncodeToString(candidate.PolyfsRoot))
	if err != nil {
		return nil, err
	}
	return &generationAcceptanceViewV3{
		response: response, candidate: candidate, generation: generation, providers: providers,
		provider: provider, slot: slot, digest: digest, id: hex.EncodeToString(digest[:]), root: root,
	}, nil
}

func (v *generationAcceptanceViewV3) accepted() bool {
	return v.response.Pending == nil || v.candidate.AcceptedSlotsMask&(1<<uint(v.slot)) != 0
}

func (v *generationAcceptanceViewV3) sameFrozenCandidate(other *generationAcceptanceViewV3) bool {
	return other != nil && v.generation == other.generation && v.providers == other.providers &&
		v.provider == other.provider && v.slot == other.slot && v.digest == other.digest && v.root == other.root
}

func updatePendingSignerV3(signer string, op pendingSignerOperation, clear bool) error {
	if sessionDB == nil {
		return fmt.Errorf("session DB unavailable")
	}
	return sessionDB.Update(func(tx *bolt.Tx) error {
		if clear {
			return clearPendingSigner(tx, signer, op.Kind, op.IDs)
		}
		return claimPendingSigner(tx, signer, op)
	})
}

func generationAcceptanceDigestV3(generation retrievalGenerationKey, slot uint32, provider [20]byte) ([32]byte, error) {
	return (retrievalchallenge.GenerationAcceptanceV3{ChainID: generation.Chain, SetupDigest: generation.Setup, DealID: generation.Deal, Generation: generation.Generation, PolyFSRoot: generation.Root, IntegrityRoot: generation.Integrity, MetadataMDUs: generation.Metadata, UserMDUs: generation.Users, Slot: slot, Provider: provider}).Hash()
}

func writeGenerationAcceptanceV3Outcome(w http.ResponseWriter, status, hash string, slot int, cleanup string, err error) {
	w.Header().Set("Content-Type", "application/json")
	if status == "pending" {
		w.WriteHeader(http.StatusAccepted)
	} else if status == "failed" {
		w.WriteHeader(http.StatusConflict)
	}
	errorText := ""
	if err != nil {
		errorText = err.Error()
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"status": status, "tx_hash": hash, "slot": slot, "cleanup_status": cleanup, "error": errorText})
}

func SpAcceptDealGenerationV3(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if !isGatewayAuthorized(r) {
		writeJSONError(w, http.StatusForbidden, "forbidden", "")
		return
	}
	var request generationAcceptanceV3Request
	body, err := io.ReadAll(io.LimitReader(r.Body, maxSessionProofRequestBytes+1))
	if err != nil || len(body) > maxSessionProofRequestBytes || validateJSONObject(body) != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid v3 generation acceptance request", "")
		return
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid v3 generation acceptance request", "")
		return
	}
	keyName, signer, err := retrievalSigner(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusServiceUnavailable, "provider signing key unavailable", err.Error())
		return
	}
	if request.Provider != "" && request.Provider != signer {
		writeJSONError(w, http.StatusForbidden, "routing provider differs from actual signing key", "")
		return
	}
	releaseDeal, err := claimGenerationVerificationV3(request.DealID, signer)
	if err != nil {
		writeJSONError(w, http.StatusTooManyRequests, "generation verification busy", err.Error())
		return
	}
	defer releaseDeal()
	releaseSigner, err := claimRetrievalOperations(nil, signer)
	if err != nil {
		writeJSONError(w, http.StatusTooManyRequests, "provider signer busy", err.Error())
		return
	}
	defer func() {
		if releaseSigner != nil {
			releaseSigner()
		}
	}()
	pending, err := loadPendingSigner(signer)
	if err != nil {
		writeJSONError(w, http.StatusConflict, "generation acceptance cleanup state unavailable", err.Error())
		return
	}
	if pending != nil && pending.Kind != "generation-v3" {
		writeJSONError(w, http.StatusConflict, "provider signer has unresolved operation", fmt.Sprintf("actual signer awaits %s reconciliation", pending.Kind))
		return
	}
	if pending != nil && pending.TxHash != "" {
		hash, waitErr := waitForCommittedTx(r.Context(), pending.TxHash)
		if waitErr == nil || errors.Is(waitErr, errTxFailed) {
			if clearErr := updatePendingSignerV3(signer, *pending, true); clearErr != nil {
				writeJSONError(w, http.StatusConflict, "generation acceptance cleanup pending", clearErr.Error())
				return
			}
		}
		if waitErr != nil {
			if errors.Is(waitErr, errTxFailed) {
				writeJSONError(w, http.StatusConflict, "generation acceptance failed", waitErr.Error())
				return
			}
			writeJSONError(w, http.StatusAccepted, "generation acceptance pending", waitErr.Error())
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "reconciled", "tx_hash": hash, "cleanup_status": "complete"})
		return
	}
	view, err := queryGenerationAcceptanceViewV3(r.Context(), request.DealID, signer)
	if err != nil {
		if errors.Is(err, errProviderNotAssignedV3) {
			writeJSONError(w, http.StatusForbidden, err.Error(), "")
			return
		}
		writeJSONError(w, http.StatusConflict, "invalid v3 generation admission", err.Error())
		return
	}
	op := pendingSignerOperation{Kind: "generation-v3", IDs: []string{view.id}}
	if view.accepted() {
		if pending != nil && len(pending.IDs) == 1 && pending.IDs[0] == view.id {
			if err := updatePendingSignerV3(signer, *pending, true); err != nil {
				writeJSONError(w, http.StatusConflict, "generation acceptance cleanup pending", err.Error())
				return
			}
			pending = nil
		}
		if pending != nil {
			writeJSONError(w, http.StatusConflict, "provider signer has unresolved generation acceptance", "stored acceptance identity differs from current generation")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "already_accepted", "slot": view.slot})
		return
	}
	if pending != nil {
		if len(pending.IDs) != 1 || pending.IDs[0] != view.id {
			writeJSONError(w, http.StatusConflict, "provider signer has unresolved generation acceptance", "stored acceptance identity differs from current generation")
			return
		}
		writeJSONError(w, http.StatusAccepted, "generation acceptance outcome unknown", "broadcast hash was not persisted")
		return
	}
	// The durable signer marker is clear. Release the shared signer while the
	// deal-specific verification lock and immutable generation lease bound the
	// expensive scan; audits and retrieval proofs can continue signing.
	releaseSigner()
	releaseSigner = nil
	dir, releaseGeneration, err := openFrozenGeneration(view.candidate.DealId, view.root)
	if err != nil {
		writeJSONError(w, http.StatusConflict, "frozen generation artifacts unavailable", err.Error())
		return
	}
	defer releaseGeneration()
	verificationTimeout, err := generationVerificationTimeoutV3(view.generation.Users)
	if err != nil {
		writeJSONError(w, http.StatusConflict, "invalid v3 generation verification bound", err.Error())
		return
	}
	verificationCtx, cancelVerification := context.WithTimeout(r.Context(), verificationTimeout)
	defer cancelVerification()
	metadata, err := authenticatedRetrievalMetadataFor(verificationCtx, dir, view.generation)
	if err == nil {
		err = verifyIntegrityVectorV3(verificationCtx, dir, view.generation, uint32(view.slot), metadata)
	}
	if err != nil {
		writeJSONError(w, http.StatusConflict, "v3 generation ingest verification failed", err.Error())
		return
	}
	cancelVerification()

	releaseSigner, err = claimRetrievalOperations(nil, signer)
	if err != nil {
		writeJSONError(w, http.StatusTooManyRequests, "provider signer busy after generation verification", err.Error())
		return
	}
	pending, err = loadPendingSigner(signer)
	if err != nil {
		writeJSONError(w, http.StatusConflict, "generation acceptance cleanup state unavailable", err.Error())
		return
	}
	if pending != nil {
		writeJSONError(w, http.StatusConflict, "provider signer has unresolved operation", fmt.Sprintf("actual signer awaits %s reconciliation", pending.Kind))
		return
	}
	submissionCtx, cancelSubmission := context.WithTimeout(r.Context(), generationSubmissionTimeoutV3)
	defer cancelSubmission()
	fresh, err := queryGenerationAcceptanceViewV3(submissionCtx, request.DealID, signer)
	if err != nil || !view.sameFrozenCandidate(fresh) {
		if err == nil {
			err = fmt.Errorf("v3 generation candidate changed during verification")
		}
		writeJSONError(w, http.StatusConflict, "v3 generation revalidation failed", err.Error())
		return
	}
	if freshDir, lookupErr := lookupDealGeneration(fresh.candidate.DealId, fresh.root, fresh.root.Canonical); lookupErr != nil || filepath.Clean(freshDir) != filepath.Clean(dir) {
		if lookupErr == nil {
			lookupErr = fmt.Errorf("frozen generation artifact identity changed")
		}
		writeJSONError(w, http.StatusConflict, "v3 generation artifact revalidation failed", lookupErr.Error())
		return
	}
	if fresh.accepted() {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "already_accepted", "slot": fresh.slot})
		return
	}
	view = fresh
	op = pendingSignerOperation{Kind: "generation-v3", IDs: []string{view.id}}
	if err := updatePendingSignerV3(signer, op, false); err != nil {
		writeJSONError(w, http.StatusConflict, "cannot persist generation acceptance intent", err.Error())
		return
	}
	hash, err := submitTxAndRecord(submissionCtx, func(hash string) error {
		op.TxHash = hash
		return updatePendingSignerV3(signer, op, false)
	}, "tx", "polystorechain", "accept-deal-generation-v3", "--deal-id", strconv.FormatUint(view.candidate.DealId, 10), "--slot", strconv.Itoa(view.slot), "--acceptance-digest", hex.EncodeToString(view.digest[:]), "--from", keyName, "--chain-id", chainID, "--home", homeDir, "--keyring-backend", "test", "--yes", "--gas", "auto", "--gas-adjustment", "1.6", "--gas-prices", gasPrices, "--broadcast-mode", "sync", "--output", "json")
	cleanup := "retained"
	if err == nil || errors.Is(err, errTxFailed) || errors.Is(err, errTxRejected) || errors.Is(err, errTxNotSubmitted) {
		if clearErr := updatePendingSignerV3(signer, op, true); clearErr != nil {
			if err == nil {
				err = fmt.Errorf("transaction committed but local acceptance cleanup remains pending: %w", clearErr)
			} else {
				err = fmt.Errorf("%w; local acceptance cleanup remains pending: %v", err, clearErr)
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
	writeGenerationAcceptanceV3Outcome(w, status, hash, view.slot, cleanup, err)
}

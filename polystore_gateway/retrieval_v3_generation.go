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

func validateGenerationAdmissionV3(a *types.DealGenerationAdmissionV3) (retrievalGenerationKey, [12][20]byte, error) {
	var providers [12][20]byte
	setup, setupErr := hex.DecodeString(types.RetrievalSetupDigest)
	if a == nil || a.ChainId != chainID || a.Generation == 0 || a.ProposedHeight <= 0 || len(a.PolyfsRoot) != 32 || len(a.IntegrityRoot) != 32 || len(a.SetupDigest) != 32 || setupErr != nil || !bytes.Equal(a.SetupDigest, setup) || len(a.Providers) != 12 || a.MetadataMdus < 2 || a.WitnessMdus != a.MetadataMdus-1 || a.UserMdus == 0 || a.MetadataMdus > 65536 || a.UserMdus > 65536-a.MetadataMdus || a.TotalMdus != a.MetadataMdus+a.UserMdus || a.UserMdus > retrievalchallenge.MaxIntegrityLeaves/retrievalchallenge.IntegrityLeavesPerUserMDU || a.IntegrityLeafCount != a.UserMdus*retrievalchallenge.IntegrityLeavesPerUserMDU || a.AcceptedSlotsMask&^uint32(0xfff) != 0 {
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
	}
	return nil
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
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()
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
	keyName, signer, err := retrievalSigner(ctx)
	if err != nil {
		writeJSONError(w, http.StatusServiceUnavailable, "provider signing key unavailable", err.Error())
		return
	}
	if request.Provider != "" && request.Provider != signer {
		writeJSONError(w, http.StatusForbidden, "routing provider differs from actual signing key", "")
		return
	}
	response, height, err := queryDealGenerationV3(ctx, request.DealID)
	if err != nil {
		writeJSONError(w, http.StatusConflict, "v3 generation admission unavailable", err.Error())
		return
	}
	candidate := response.Pending
	if candidate == nil {
		candidate = response.Admitted
	}
	generation, providers, err := validateGenerationAdmissionV3(candidate)
	if err != nil || height == 0 || uint64(candidate.ProposedHeight) > height {
		if err == nil {
			err = fmt.Errorf("v3 generation query lacks a committed proposal height")
		}
		writeJSONError(w, http.StatusConflict, "invalid v3 generation admission", err.Error())
		return
	}
	var providerRaw [20]byte
	providerAddress, _ := sdk.AccAddressFromBech32(signer)
	copy(providerRaw[:], providerAddress)
	slot := -1
	for i := range providers {
		if providers[i] == providerRaw {
			if slot != -1 {
				writeJSONError(w, http.StatusConflict, "provider occupies multiple frozen slots", "")
				return
			}
			slot = i
		}
	}
	if slot < 0 {
		writeJSONError(w, http.StatusForbidden, "provider is not assigned to the generation", "")
		return
	}
	digest, err := (retrievalchallenge.GenerationAcceptanceV3{ChainID: generation.Chain, SetupDigest: generation.Setup, DealID: generation.Deal, Generation: generation.Generation, PolyFSRoot: generation.Root, IntegrityRoot: generation.Integrity, MetadataMDUs: generation.Metadata, UserMDUs: generation.Users, Slot: uint32(slot), Provider: providerRaw}).Hash()
	if err != nil {
		writeJSONError(w, http.StatusConflict, "invalid v3 generation acceptance digest", err.Error())
		return
	}
	id := hex.EncodeToString(digest[:])
	release, err := claimRetrievalOperations([]string{id}, signer)
	if err != nil {
		writeJSONError(w, http.StatusTooManyRequests, "provider signer busy", err.Error())
		return
	}
	defer release()
	op := pendingSignerOperation{Kind: "generation-v3", IDs: []string{id}}
	if candidate.AcceptedSlotsMask&(1<<uint(slot)) != 0 || response.Pending == nil {
		if pending, err := loadPendingSigner(signer); err == nil && pending != nil && pending.Kind == op.Kind && len(pending.IDs) == 1 && pending.IDs[0] == id {
			_ = updatePendingSignerV3(signer, op, true)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "already_accepted", "slot": slot})
		return
	}
	if pending, err := loadPendingSigner(signer); err != nil || pending != nil {
		if err != nil || pending.Kind != op.Kind || len(pending.IDs) != 1 || pending.IDs[0] != id {
			if err == nil {
				err = fmt.Errorf("actual signer awaits %s reconciliation", pending.Kind)
			}
			writeJSONError(w, http.StatusConflict, "provider signer has unresolved operation", err.Error())
			return
		}
		if pending.TxHash == "" {
			writeJSONError(w, http.StatusAccepted, "generation acceptance outcome unknown", "broadcast hash was not persisted")
			return
		}
		hash, waitErr := waitForCommittedTx(ctx, pending.TxHash)
		if waitErr == nil || errors.Is(waitErr, errTxFailed) {
			_ = updatePendingSignerV3(signer, op, true)
		}
		if waitErr != nil {
			if errors.Is(waitErr, errTxFailed) {
				writeJSONError(w, http.StatusConflict, "generation acceptance failed", waitErr.Error())
				return
			}
			writeJSONError(w, http.StatusAccepted, "generation acceptance pending", waitErr.Error())
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "reconciled", "tx_hash": hash})
		return
	}
	root, err := parseManifestRoot("0x" + hex.EncodeToString(candidate.PolyfsRoot))
	if err != nil {
		writeJSONError(w, http.StatusConflict, "invalid frozen generation root", err.Error())
		return
	}
	dir, releaseGeneration, err := openFrozenGeneration(candidate.DealId, root)
	if err != nil {
		writeJSONError(w, http.StatusConflict, "frozen generation artifacts unavailable", err.Error())
		return
	}
	defer releaseGeneration()
	metadata, err := authenticatedRetrievalMetadataFor(ctx, dir, generation)
	if err == nil {
		err = verifyIntegrityVectorV3(ctx, dir, generation, uint32(slot), metadata)
	}
	if err != nil {
		writeJSONError(w, http.StatusConflict, "v3 generation ingest verification failed", err.Error())
		return
	}
	if err := updatePendingSignerV3(signer, op, false); err != nil {
		writeJSONError(w, http.StatusConflict, "cannot persist generation acceptance intent", err.Error())
		return
	}
	hash, err := submitTxAndRecord(ctx, func(hash string) error {
		op.TxHash = hash
		return updatePendingSignerV3(signer, op, false)
	}, "tx", "polystorechain", "accept-deal-generation-v3", "--deal-id", strconv.FormatUint(candidate.DealId, 10), "--slot", strconv.Itoa(slot), "--acceptance-digest", hex.EncodeToString(digest[:]), "--from", keyName, "--chain-id", chainID, "--home", homeDir, "--keyring-backend", "test", "--yes", "--gas", "auto", "--gas-adjustment", "1.6", "--gas-prices", gasPrices, "--broadcast-mode", "sync", "--output", "json")
	if err == nil || errors.Is(err, errTxFailed) || errors.Is(err, errTxRejected) || errors.Is(err, errTxNotSubmitted) {
		_ = updatePendingSignerV3(signer, op, true)
	}
	status := "success"
	if err != nil {
		status = "pending"
		if errors.Is(err, errTxFailed) || errors.Is(err, errTxRejected) || errors.Is(err, errTxNotSubmitted) {
			status = "failed"
		}
	}
	w.Header().Set("Content-Type", "application/json")
	errorText := ""
	if err != nil {
		errorText = err.Error()
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"status": status, "tx_hash": hash, "slot": slot, "error": errorText})
}

package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/bits"
	"os"
	"path/filepath"
	"strconv"

	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/gogoproto/jsonpb"
	bolt "go.etcd.io/bbolt"
	"polystorechain/pkg/retrievalchallenge"
	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/types"
)

// Read activation and the frozen inventory at the same committed height. An
// unavailable v2 inventory must never send the provider down the legacy path.
func systemAuditActivation(ctx context.Context) (bool, uint64, error) {
	body, height, err := readLCDJSON(ctx, "/polystorechain/polystorechain/v1/params", 0, 64*1024)
	if err != nil {
		return false, 0, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		return false, 0, err
	}
	if validateJSONObject(fields["params"]) != nil || height == 0 {
		return false, 0, fmt.Errorf("audit activation query lacks params or committed height")
	}
	var params map[string]json.RawMessage
	if err := json.Unmarshal(fields["params"], &params); err != nil {
		return false, 0, err
	}
	var activationText string
	if err := json.Unmarshal(params["retrieval_v2_activation_height"], &activationText); err != nil {
		return false, 0, fmt.Errorf("activation height must be explicit")
	}
	activationValue, err := strconv.ParseUint(activationText, 10, 64)
	if err != nil || strconv.FormatUint(activationValue, 10) != activationText {
		return false, 0, fmt.Errorf("invalid activation height")
	}
	var response types.QueryParamsResponse
	if err := jsonpb.Unmarshal(bytes.NewReader(body), &response); err != nil {
		return false, 0, err
	}
	activation := response.Params.RetrievalV2ActivationHeight
	if activation > math.MaxInt64 {
		return false, 0, fmt.Errorf("invalid retrieval activation height")
	}
	return activation != 0 && height >= activation, height, nil
}

type frozenSystemAudit struct {
	context   retrievalchallenge.Context
	hash      [32]byte
	seed      []byte
	coverage  []byte
	finalized bool
}

func queryFrozenSystemAudits(ctx context.Context, signer string, height uint64) ([]frozenSystemAudit, uint64, error) {
	// At most two retained epochs of 64 assignments. Each has <=512 coverage
	// bytes and one bounded C2 transcript; this cap also bounds malformed input.
	body, committed, err := readLCDJSON(ctx, "/polystorechain/polystorechain/v1/storage-audits/by-provider/"+signer, height, 1024*1024)
	if err != nil {
		return nil, 0, err
	}
	if committed == 0 {
		return nil, 0, fmt.Errorf("audit query lacks committed height")
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		return nil, 0, err
	}
	list := bytes.TrimSpace(fields["audits"])
	if len(list) == 0 || list[0] != '[' {
		return nil, 0, fmt.Errorf("audit inventory must be an explicit array")
	}
	var response types.QueryListStorageAuditsByProviderResponse
	if err := jsonpb.Unmarshal(bytes.NewReader(body), &response); err != nil {
		return nil, 0, err
	}
	if len(response.Audits) > 2*types.MaxStorageAuditAssignments {
		return nil, 0, fmt.Errorf("audit inventory exceeds retained bound")
	}
	out := make([]frozenSystemAudit, 0, len(response.Audits))
	seen := make(map[[32]byte]bool, len(response.Audits))
	for _, view := range response.Audits {
		if view.Audit == nil {
			return nil, 0, fmt.Errorf("audit snapshot missing")
		}
		c, err := types.StorageAuditContext(*view.Audit, view.EpochLength)
		if err != nil {
			return nil, 0, err
		}
		if c.ChainID != chainID || view.Audit.Assignment.Provider != signer {
			return nil, 0, fmt.Errorf("audit chain or signer mismatch")
		}
		canonical, _ := c.Bytes()
		hash, _ := c.Hash()
		if !bytes.Equal(canonical, view.CanonicalContext) || seen[hash] {
			return nil, 0, fmt.Errorf("audit context mismatch or duplicate")
		}
		seen[hash] = true
		coverage := view.Audit.Coverage
		if len(coverage) != int((c.SampleCount+7)/8) {
			return nil, 0, fmt.Errorf("invalid audit coverage length")
		}
		var accepted uint64
		for _, b := range coverage {
			accepted += uint64(bits.OnesCount8(b))
		}
		if accepted != view.Audit.AcceptedCount || (c.SampleCount%8 != 0 && coverage[len(coverage)-1]>>(c.SampleCount%8) != 0) {
			return nil, 0, fmt.Errorf("invalid audit coverage count or padding")
		}
		if len(view.Seed) != 0 && len(view.Seed) != 32 {
			return nil, 0, fmt.Errorf("invalid audit seed")
		}
		if !view.Finalized && committed >= c.Window.Anchor && len(view.Seed) != 32 {
			return nil, 0, fmt.Errorf("eligible audit anchor missing")
		}
		out = append(out, frozenSystemAudit{c, hash, view.Seed, coverage, view.Finalized})
	}
	return out, committed, nil
}

func auditCovered(a frozenSystemAudit, ordinal uint64) bool {
	return ordinal < a.context.SampleCount && a.coverage[ordinal/8]&(1<<(ordinal%8)) != 0
}

func generateFrozenSystemProof(ctx context.Context, dir string, c retrievalchallenge.Context, challenge retrievalchallenge.Challenge) (*types.ChainedProof, error) {
	ctx, release, err := admitRetrievalResponse(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	releaseGeneration, err := leaseGenerationPaths(dir)
	if err != nil {
		return nil, err
	}
	defer releaseGeneration()
	metadata, err := authenticatedRetrievalMetadata(ctx, dir, c)
	if err != nil {
		return nil, err
	}
	user, err := metadata.userMDU(ctx, dir, c, challenge.MDUIndex)
	if err != nil {
		return nil, err
	}
	rows := uint64(64 / c.K)
	path := filepath.Join(dir, fmt.Sprintf("mdu_%d.bin", challenge.MDUIndex))
	if c.Layout == retrievalchallenge.Stripe {
		path = filepath.Join(dir, fmt.Sprintf("mdu_%d_slot_%d.bin", challenge.MDUIndex, c.Slot))
	}
	blob, err := readExactArtifactRange(path, rows*types.BLOB_SIZE, uint64(challenge.LeafIndex)%rows*types.BLOB_SIZE, types.BLOB_SIZE)
	if err != nil {
		return nil, err
	}
	proof, err := buildFrozenBlobProof(ctx, challenge, user, blob)
	if err != nil {
		return nil, err
	}
	flat, err := flattenMerkleProof32(proof.MerklePath)
	if err != nil {
		return nil, err
	}
	valid, err := crypto_ffi.VerifyMduProof(proof.MduRootFr, proof.BlobCommitment, flat, proof.BlobIndex, rows*uint64(c.K+c.M), proof.ZValue, proof.YValue, proof.KzgOpeningProof)
	if err != nil {
		return nil, err
	}
	if !valid {
		return nil, fmt.Errorf("generated audit proof failed native verification")
	}
	return &proof, nil
}

// One bounded intent per actual signer survives a crash between broadcasting
// and recording a hash. Terminal failures release the account but remain until
// this obligation expires, preventing an automatic repeat of the failed proof.
type systemAuditIntent struct {
	Version uint32                     `json:"version"`
	Signer  string                     `json:"signer"`
	Context retrievalchallenge.Context `json:"context"`
	Seed    []byte                     `json:"seed"`
	Ordinal uint64                     `json:"ordinal"`
	TxHash  string                     `json:"tx_hash,omitempty"`
	State   string                     `json:"state"`
	Failure string                     `json:"failure,omitempty"`
}

var auditIntentPrefix = []byte("audit-v2:")

func auditIntentKey(signer string) []byte { return append(bytes.Clone(auditIntentPrefix), signer...) }
func (in *systemAuditIntent) operationID() string {
	hash, _ := in.Context.Hash()
	return hex.EncodeToString(hash[:]) + ":" + strconv.FormatUint(in.Ordinal, 10)
}
func decodeSystemAuditIntent(raw []byte, signer string) (*systemAuditIntent, error) {
	if len(raw) == 0 || len(raw) > 8192 || validateJSONObject(raw) != nil {
		return nil, fmt.Errorf("invalid audit intent encoding")
	}
	var in systemAuditIntent
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&in); err != nil {
		return nil, err
	}
	if _, err := in.Context.Bytes(); err != nil {
		return nil, err
	}
	address, err := sdk.AccAddressFromBech32(signer)
	if err != nil || len(address) != 20 || address.String() != signer || !bytes.Equal(address, in.Context.Assigned[:]) {
		return nil, fmt.Errorf("invalid audit intent signer")
	}
	if in.Version != 1 || in.Signer != signer || in.Context.ChainID != chainID || (in.Context.Kind != retrievalchallenge.Audit && in.Context.Kind != retrievalchallenge.Repair) || len(in.Seed) != 32 || in.Ordinal >= in.Context.SampleCount {
		return nil, fmt.Errorf("invalid audit intent identity")
	}
	if len(in.Failure) > 2048 || (in.State != "failed" && in.Failure != "") || (in.State != "pending" && in.State != "committed" && in.State != "failed") {
		return nil, fmt.Errorf("invalid audit intent state")
	}
	if in.TxHash != "" {
		hash, err := normalizeTxHash(in.TxHash)
		if err != nil || hash != in.TxHash {
			return nil, fmt.Errorf("invalid audit intent hash")
		}
	}
	if in.State == "committed" && in.TxHash == "" {
		return nil, fmt.Errorf("committed audit intent lacks hash")
	}
	return &in, nil
}
func loadSystemAuditIntent(signer string) (*systemAuditIntent, error) {
	if sessionDB == nil {
		return nil, fmt.Errorf("session DB unavailable")
	}
	var in *systemAuditIntent
	err := sessionDB.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(onChainSessionProofsBucket)
		if b == nil {
			return fmt.Errorf("proof bucket missing")
		}
		raw := b.Get(auditIntentKey(signer))
		if raw == nil {
			return nil
		}
		var err error
		in, err = decodeSystemAuditIntent(raw, signer)
		return err
	})
	return in, err
}
func storeSystemAuditIntent(in *systemAuditIntent) error {
	if sessionDB == nil {
		return fmt.Errorf("session DB unavailable")
	}
	raw, err := json.Marshal(in)
	if err != nil {
		return err
	}
	if _, err := decodeSystemAuditIntent(raw, in.Signer); err != nil {
		return err
	}
	return sessionDB.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(onChainSessionProofsBucket)
		if b == nil {
			return fmt.Errorf("proof bucket missing")
		}
		if previous := b.Get(auditIntentKey(in.Signer)); previous != nil {
			old, err := decodeSystemAuditIntent(previous, in.Signer)
			if err != nil {
				return err
			}
			if old.operationID() != in.operationID() || !bytes.Equal(old.Seed, in.Seed) || (old.TxHash != "" && old.TxHash != in.TxHash) || (old.State != "pending" && old.State != in.State) {
				return fmt.Errorf("audit intent cannot replace unresolved or terminal operation")
			}
		} else {
			if in.State != "pending" {
				return fmt.Errorf("audit intent must start pending")
			}
			count := 0
			cursor := b.Cursor()
			for k, _ := cursor.Seek(auditIntentPrefix); k != nil && bytes.HasPrefix(k, auditIntentPrefix); k, _ = cursor.Next() {
				count++
				if count >= 4 {
					return fmt.Errorf("audit signer capacity reached")
				}
			}
		}
		ids := []string{in.operationID()}
		if in.State == "pending" {
			err = claimPendingSigner(tx, in.Signer, pendingSignerOperation{Kind: "audit", IDs: ids, TxHash: in.TxHash})
		} else {
			err = clearPendingSigner(tx, in.Signer, "audit", ids)
		}
		if err != nil {
			return err
		}
		return b.Put(auditIntentKey(in.Signer), raw)
	})
}
func deleteSystemAuditIntent(in *systemAuditIntent, resolved bool) error {
	return sessionDB.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(onChainSessionProofsBucket)
		if b == nil {
			return fmt.Errorf("proof bucket missing")
		}
		old, err := decodeSystemAuditIntent(b.Get(auditIntentKey(in.Signer)), in.Signer)
		if err != nil {
			return err
		}
		if old.operationID() != in.operationID() || !bytes.Equal(old.Seed, in.Seed) || old.TxHash != in.TxHash || old.State != in.State {
			return fmt.Errorf("audit intent changed during reconciliation")
		}
		if old.State == "pending" {
			if !resolved {
				return fmt.Errorf("audit intent is unresolved")
			}
			var marker pendingSignerOperation
			if err := decodePendingSigner(b.Get(pendingSignerKey(in.Signer)), &marker); err != nil {
				return err
			}
			if marker.TxHash != old.TxHash {
				return fmt.Errorf("audit signer hash changed during reconciliation")
			}
			if err := clearPendingSigner(tx, in.Signer, "audit", []string{in.operationID()}); err != nil {
				return err
			}
		}
		// Terminal intents already released their marker. A retrieval operation may
		// have used this signer since then; never clear that newer operation here.
		return b.Delete(auditIntentKey(in.Signer))
	})
}

func finishSystemAuditIntent(in *systemAuditIntent, outcome error) error {
	in.State = "committed"
	if outcome != nil {
		in.State = "failed"
		in.Failure = outcome.Error()
		if len(in.Failure) > 2048 {
			in.Failure = in.Failure[:2048]
		}
	}
	return storeSystemAuditIntent(in)
}

func reconcileSystemAudit(ctx context.Context, in *systemAuditIntent, height uint64) (bool, uint64, error) {
	if in.State == "failed" {
		if height > in.Context.Window.Deadline {
			return false, height, deleteSystemAuditIntent(in, false)
		}
		return false, height, fmt.Errorf("audit %s failed; automatic retry disabled until frozen deadline: %s", in.operationID(), in.Failure)
	}
	// Frozen accepted coverage is authoritative even if the broadcast hash was
	// lost or the transaction index is unavailable. Bind all original fields;
	// coverage for another generation, seed, or ordinal cannot release a signer.
	audits, committed, coverageErr := queryFrozenSystemAudits(ctx, in.Signer, 0)
	if coverageErr == nil && committed >= in.Context.Window.First {
		hash, err := in.Context.Hash()
		if err != nil {
			return false, height, err
		}
		for _, a := range audits {
			if a.hash == hash && bytes.Equal(a.seed, in.Seed) && auditCovered(a, in.Ordinal) {
				if err := deleteSystemAuditIntent(in, true); err != nil {
					return false, committed, err
				}
				return true, committed, nil
			}
		}
	}
	if in.State == "pending" {
		if in.TxHash == "" {
			return false, height, fmt.Errorf("%w: audit broadcast hash is unknown and matching committed coverage is unavailable", errTxPending)
		}
		_, err := waitForCommittedTx(ctx, in.TxHash)
		if err != nil && !errors.Is(err, errTxFailed) {
			return false, height, err
		}
		if saveErr := finishSystemAuditIntent(in, err); saveErr != nil {
			return false, height, saveErr
		}
		if err != nil {
			return false, height, err
		}
		// The hash has now resolved to a committed transaction. Read coverage
		// once more, since the first observation may have preceded inclusion.
		return reconcileSystemAudit(ctx, in, height)
	}
	if coverageErr != nil {
		return false, height, coverageErr
	}
	if committed > in.Context.Window.Deadline {
		if err := deleteSystemAuditIntent(in, false); err != nil {
			return false, height, err
		}
	}
	return false, height, fmt.Errorf("committed audit transaction lacks matching frozen coverage")
}

func submitFrozenSystemAudit(ctx context.Context, key string, in *systemAuditIntent, proof *types.ChainedProof) error {
	file, err := os.CreateTemp("", "polystore-system-audit-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	err = json.NewEncoder(file).Encode(proof)
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err := storeSystemAuditIntent(in); err != nil {
		return err
	}
	_, err = submitTxAndRecord(ctx, func(hash string) error { in.TxHash = hash; return storeSystemAuditIntent(in) },
		"tx", "polystorechain", "prove-liveness-system", strconv.FormatUint(in.Context.DealID, 10), strconv.FormatUint(in.Context.EpochID, 10), file.Name(),
		"--from", key, "--chain-id", chainID, "--home", homeDir, "--keyring-backend", "test", "--yes",
		// Includes 500k native verification and <=409,600 bounded sample derivation.
		"--gas", "2000000", "--gas-prices", gasPrices, "--broadcast-mode", "sync", "--output", "json")
	if errors.Is(err, errTxNotSubmitted) {
		// No transaction exists to reconcile. Release the exact intent and allow
		// the still-live obligation to try again after the local problem is fixed.
		if clearErr := deleteSystemAuditIntent(in, true); clearErr != nil {
			return fmt.Errorf("%w; intent recovery: %v", err, clearErr)
		}
	} else if err == nil || errors.Is(err, errTxFailed) || errors.Is(err, errTxRejected) {
		if saveErr := finishSystemAuditIntent(in, err); saveErr != nil {
			return saveErr
		}
	}
	return err
}

func runFrozenSystemLiveness(ctx context.Context, height uint64, snapshot *systemLivenessSnapshot) error {
	key, signer, err := retrievalSigner(ctx)
	if err != nil {
		return err
	}
	release, err := claimRetrievalOperations(nil, signer)
	if err != nil {
		return err
	}
	defer release()
	pending, err := loadPendingSigner(signer)
	if err != nil {
		return err
	}
	in, err := loadSystemAuditIntent(signer)
	if err != nil {
		return err
	}
	if pending != nil && (pending.Kind != "audit" || in == nil || len(pending.IDs) != 1 || pending.IDs[0] != in.operationID() || pending.TxHash != in.TxHash || in.State != "pending") {
		return fmt.Errorf("%w: actual signer has another unresolved operation", errTxPending)
	}
	if in != nil {
		if in.State == "pending" && pending == nil {
			return fmt.Errorf("pending audit lacks signer marker")
		}
		accepted, _, err := reconcileSystemAudit(ctx, in, height)
		if accepted {
			snapshot.ProofsSubmitted++
		}
		if err != nil {
			return err
		}
		// Reconciliation queried latest coverage, so fetch a fresh activation height
		// on the next tick instead of reusing this pass's earlier inventory height.
		return nil
	}
	audits, _, err := queryFrozenSystemAudits(ctx, signer, height)
	if err != nil {
		return err
	}
	for _, a := range audits {
		snapshot.DealsScanned++
		c := a.context
		if a.finalized || height >= c.Window.Deadline {
			snapshot.DealsExpired++
			continue
		}
		// A seed observed after committed S can first be included at S+1.
		// Waiting for committed First would lose the entire L=2 window.
		if height < c.Window.Anchor || len(a.seed) != 32 {
			continue
		}
		challenges, err := c.Challenges(a.seed)
		if err != nil {
			return err
		}
		root, err := parseManifestRoot(hex.EncodeToString(c.Root[:]))
		if err != nil {
			return err
		}
		dir, err := resolveDealDirForDeal(c.DealID, root, root.Canonical)
		if err != nil {
			snapshot.MissingDataSkips++
			snapshot.LastError = err.Error()
			continue
		}
		for _, challenge := range challenges {
			if err := ctx.Err(); err != nil {
				return err
			}
			if auditCovered(a, challenge.Ordinal) {
				snapshot.ProofsAlreadyDone++
				continue
			}
			proof, err := generateFrozenSystemProof(ctx, dir, c, challenge)
			if err != nil {
				snapshot.ProofGenFailures++
				snapshot.LastError = err.Error()
				break
			}
			in := &systemAuditIntent{Version: 1, Signer: signer, Context: c, Seed: a.seed, Ordinal: challenge.Ordinal, State: "pending"}
			if err := submitFrozenSystemAudit(ctx, key, in, proof); err != nil {
				snapshot.TxFailures++
				return err
			}
			accepted, committed, err := reconcileSystemAudit(ctx, in, height)
			if err != nil {
				return err
			}
			if accepted {
				snapshot.ProofsSubmitted++
			}
			height = committed
			if height >= c.Window.Deadline {
				break
			}
		}
	}
	return nil
}

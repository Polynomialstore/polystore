package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"math/big"
	"path/filepath"

	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/gogoproto/jsonpb"
	"polystorechain/pkg/retrievalchallenge"
	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/types"
)

const v3SampleBitmapBytes = int((retrievalchallenge.MaxLargeSessionSamples + 7) / 8)

type frozenRetrievalSessionV3 struct {
	Session    types.RetrievalSessionV3
	Height     uint64
	Context    retrievalchallenge.ContextV3
	Hash       [32]byte
	Seed       [32]byte
	Challenges []retrievalchallenge.ChallengeV3
	Plan       retrievalchallenge.PlanV3
}

func queryRetrievalSessionV3(ctx context.Context, sessionID string) (*types.QueryGetRetrievalSessionV3Response, uint64, error) {
	_, id, err := parseSessionIDHex(sessionID)
	if err != nil {
		return nil, 0, err
	}
	path := "/polystorechain/polystorechain/v1/retrieval-sessions-v3/" + base64.URLEncoding.EncodeToString(id)
	body, height, err := readLCDJSON(ctx, path, 0, maxSessionQueryBytes)
	if errors.Is(err, errLCDNotFound) {
		return nil, 0, ErrSessionNotFound
	}
	if err != nil {
		return nil, 0, err
	}
	var response types.QueryGetRetrievalSessionV3Response
	if err := jsonpb.Unmarshal(bytes.NewReader(body), &response); err != nil {
		return nil, 0, fmt.Errorf("invalid v3 session query: %w", err)
	}
	if !bytes.Equal(response.Session.SessionId, id) {
		return nil, 0, fmt.Errorf("v3 session query returned a different identity")
	}
	return &response, height, nil
}

func rawProviderV3(address string) ([20]byte, error) {
	var out [20]byte
	raw, err := sdk.AccAddressFromBech32(address)
	if err != nil || len(raw) != len(out) || raw.String() != address {
		return out, fmt.Errorf("invalid canonical v3 address")
	}
	copy(out[:], raw)
	return out, nil
}

func contextV3FromSession(s types.RetrievalSessionV3) (retrievalchallenge.ContextV3, error) {
	var setup, id, root, integrity, plan [32]byte
	if len(s.SetupDigest) != 32 || len(s.SessionId) != 32 || len(s.PolyfsRoot) != 32 || len(s.IntegrityRoot) != 32 || len(s.PlanHash) != 32 {
		return retrievalchallenge.ContextV3{}, fmt.Errorf("invalid v3 session hashes")
	}
	copy(setup[:], s.SetupDigest)
	copy(id[:], s.SessionId)
	copy(root[:], s.PolyfsRoot)
	copy(integrity[:], s.IntegrityRoot)
	copy(plan[:], s.PlanHash)
	owner, err := rawProviderV3(s.Owner)
	if err != nil {
		return retrievalchallenge.ContextV3{}, err
	}
	payer, err := rawProviderV3(s.Payer)
	if err != nil {
		return retrievalchallenge.ContextV3{}, err
	}
	c := retrievalchallenge.ContextV3{
		ChainID: s.ChainId, SetupDigest: setup, SessionID: id, SessionOwner: owner,
		DealID: s.DealId, Generation: s.Generation, PolyFSRoot: root, IntegrityRoot: integrity,
		FileRecordIndex: s.FileRecordIndex, FileStartOffset: s.FileStartOffset, FileLength: s.FileLength,
		RangeStart: s.RangeStart, RangeLength: s.RangeLength, MetadataMDUs: s.MetadataMdus, UserMDUs: s.UserMdus,
		PlanHash: plan, Population: s.Population, SampleCount: s.SampleCount, Nonce: s.Nonce,
		PriceDenom: s.PriceDenom, PricePerBlob: s.PricePerBlob.String(), BaseFee: s.BaseFee.String(),
		CompletionBurnBPS: s.CompletionBurnBps, FundingKind: uint8(s.Funding), FundingPayer: payer,
		Window:  retrievalchallenge.Window{Snapshot: s.SnapshotHeight, Anchor: s.AnchorHeight, First: s.FirstResponseHeight, Deadline: s.DeadlineHeight},
		DealEnd: s.DealEndHeight,
	}
	if _, err := c.Bytes(); err != nil {
		return retrievalchallenge.ContextV3{}, err
	}
	return c, nil
}

func v3BitmapSet(bitmap []byte, ordinal uint64) bool {
	return bitmap[ordinal/8]&(byte(1)<<uint(ordinal%8)) != 0
}

func freezeRetrievalSessionV3Response(r *types.QueryGetRetrievalSessionV3Response, height uint64) (*frozenRetrievalSessionV3, error) {
	if r == nil || height == 0 {
		return nil, fmt.Errorf("v3 session query lacks committed state")
	}
	s := r.Session
	if s.OpenedHeight < 1 || s.SnapshotHeight != uint64(s.OpenedHeight) || s.UpdatedHeight < s.OpenedHeight || uint64(s.UpdatedHeight) > height || s.Expired || height < s.FirstResponseHeight || height > s.DeadlineHeight {
		return nil, fmt.Errorf("v3 session is malformed, terminal, or outside its response window")
	}
	if s.PricePerBlob.IsNil() || s.PricePerBlob.IsNegative() || s.BaseFee.IsNil() || s.BaseFee.IsNegative() || s.LockedFee.IsNil() || s.LockedFee.IsNegative() || s.Funding != types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_DEAL_ESCROW && s.Funding != types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_REQUESTER {
		return nil, fmt.Errorf("invalid v3 session economics")
	}
	if len(s.ContextHash) != 32 || len(s.AcceptedSampleBitmap) != v3SampleBitmapBytes || s.AcceptedSampleBitmap[v3SampleBitmapBytes-1]&0xf0 != 0 || len(s.Obligations) == 0 || len(s.Obligations) > 8 {
		return nil, fmt.Errorf("invalid v3 session bounds")
	}
	c, err := contextV3FromSession(s)
	if err != nil {
		return nil, fmt.Errorf("invalid v3 session context: %w", err)
	}
	setup, setupErr := hex.DecodeString(types.RetrievalSetupDigest)
	if c.ChainID != chainID || setupErr != nil || !bytes.Equal(c.SetupDigest[:], setup) {
		return nil, fmt.Errorf("v3 session chain or setup mismatch")
	}
	hash, err := c.Hash()
	if err != nil || !bytes.Equal(hash[:], s.ContextHash) {
		return nil, fmt.Errorf("v3 session context hash mismatch")
	}
	rng, err := retrievalchallenge.CheckedRangeV3(s.FileStartOffset, s.FileLength, s.RangeStart, s.RangeLength, s.UserMdus)
	if err != nil || rng.First != s.FirstBlob || rng.Last != s.LastBlob || rng.Population != s.Population {
		return nil, fmt.Errorf("v3 session range mismatch")
	}
	var providers [8][20]byte
	var represented uint32
	remaining := new(big.Int)
	for i := range s.Obligations {
		o := s.Obligations[i]
		if o.Slot >= 8 || (i > 0 && s.Obligations[i-1].Slot >= o.Slot) || o.AssignedProvider != o.Payee || o.BlobCount == 0 || o.LockedFee.IsNil() || o.LockedFee.IsNegative() {
			return nil, fmt.Errorf("invalid v3 obligation")
		}
		expected := new(big.Int).Mul(s.PricePerBlob.BigInt(), new(big.Int).SetUint64(o.BlobCount))
		if expected.BitLen() > 256 || expected.Cmp(o.LockedFee.BigInt()) != 0 {
			return nil, fmt.Errorf("invalid v3 obligation fee")
		}
		provider, err := rawProviderV3(o.AssignedProvider)
		if err != nil {
			return nil, err
		}
		providers[o.Slot] = provider
		represented |= uint32(1) << o.Slot
		bit := uint32(1) << o.Slot
		if s.SettledSlotsMask&bit == 0 && s.RefundedSlotsMask&bit == 0 {
			remaining.Add(remaining, o.LockedFee.BigInt())
			if remaining.BitLen() > 256 {
				return nil, fmt.Errorf("v3 remaining fee exceeds uint256")
			}
		}
	}
	if masks := s.AckedSlotsMask | s.SettledSlotsMask | s.RefundedSlotsMask; masks&^represented != 0 || s.SettledSlotsMask&s.RefundedSlotsMask != 0 || s.SettledSlotsMask&^s.AckedSlotsMask != 0 {
		return nil, fmt.Errorf("invalid v3 settlement masks")
	}
	if remaining.Cmp(s.LockedFee.BigInt()) != 0 {
		return nil, fmt.Errorf("v3 locked fee does not match unsettled obligations")
	}
	plan, err := retrievalchallenge.BuildPlanV3(rng, providers)
	if err != nil || len(plan.Obligations) != len(s.Obligations) {
		return nil, fmt.Errorf("invalid v3 session plan")
	}
	for i, want := range plan.Obligations {
		got := s.Obligations[i]
		if got.Slot != want.Slot || got.BlobCount != want.BlobCount {
			return nil, fmt.Errorf("v3 obligation does not match compact plan")
		}
	}
	planHash, err := plan.Hash()
	if err != nil || !bytes.Equal(planHash[:], s.PlanHash) {
		return nil, fmt.Errorf("v3 plan hash mismatch")
	}
	if len(r.AnchorSeed) != 32 {
		return nil, fmt.Errorf("v3 session anchor is unavailable or malformed")
	}
	seed, err := c.Seed(r.AnchorSeed)
	if err != nil {
		return nil, err
	}
	challenges, err := c.Challenges(seed[:])
	if err != nil {
		return nil, err
	}
	counts := make(map[uint32]uint64, len(s.Obligations))
	for _, challenge := range challenges {
		counts[challenge.Slot]++
	}
	var storedSamples uint64
	for _, obligation := range s.Obligations {
		storedSamples += obligation.SampleCount
		if obligation.SampleCount != 0 && obligation.SampleCount != counts[obligation.Slot] {
			return nil, fmt.Errorf("v3 sample partition mismatch")
		}
	}
	if storedSamples != 0 && storedSamples != s.SampleCount {
		return nil, fmt.Errorf("v3 stored sample count mismatch")
	}
	return &frozenRetrievalSessionV3{Session: s, Height: height, Context: c, Hash: hash, Seed: seed, Challenges: challenges, Plan: plan}, nil
}

func providerChallengesV3(f *frozenRetrievalSessionV3, signer string, limit int) (uint32, []retrievalchallenge.ChallengeV3, int, error) {
	if f == nil || limit < 1 || limit > 64 {
		return 0, nil, 0, fmt.Errorf("invalid v3 proof selection bounds")
	}
	slot := uint32(math.MaxUint32)
	for _, obligation := range f.Session.Obligations {
		if obligation.AssignedProvider == signer {
			if slot != math.MaxUint32 {
				return 0, nil, 0, fmt.Errorf("signer occupies multiple v3 obligations")
			}
			slot = obligation.Slot
		}
	}
	if slot == math.MaxUint32 {
		return 0, nil, 0, fmt.Errorf("signer is not a frozen v3 provider")
	}
	bit := uint32(1) << slot
	if f.Session.SettledSlotsMask&bit != 0 || f.Session.RefundedSlotsMask&bit != 0 {
		return slot, nil, 0, nil
	}
	selected := make([]retrievalchallenge.ChallengeV3, 0, limit)
	remaining := 0
	for _, challenge := range f.Challenges {
		if challenge.Slot != slot || v3BitmapSet(f.Session.AcceptedSampleBitmap, challenge.Ordinal) {
			continue
		}
		remaining++
		if len(selected) < limit {
			selected = append(selected, challenge)
		}
	}
	return slot, selected, remaining - len(selected), nil
}

func buildProviderProofBatchV3(ctx context.Context, f *frozenRetrievalSessionV3, signer string) (uint32, []types.RetrievalSampleProofV3, int, error) {
	slot, challenges, remaining, err := providerChallengesV3(f, signer, 64)
	if err != nil || len(challenges) == 0 {
		return slot, nil, remaining, err
	}
	root, err := parseManifestRoot("0x" + hex.EncodeToString(f.Context.PolyFSRoot[:]))
	if err != nil {
		return 0, nil, 0, err
	}
	dir, release, err := openFrozenGeneration(f.Context.DealID, root)
	if err != nil {
		return 0, nil, 0, err
	}
	defer release()
	key := retrievalGenerationKey{Chain: f.Context.ChainID, Setup: f.Context.SetupDigest, Root: f.Context.PolyFSRoot, Integrity: f.Context.IntegrityRoot, Deal: f.Context.DealID, Generation: f.Context.Generation, Metadata: f.Context.MetadataMDUs, Users: f.Context.UserMDUs, Layout: retrievalchallenge.StripeK8M4, K: 8, M: 4, Version: 3}
	metadata, err := authenticatedRetrievalMetadataFor(ctx, dir, key)
	if err != nil {
		return 0, nil, 0, err
	}
	proofs := make([]types.RetrievalSampleProofV3, len(challenges))
	for i, challenge := range challenges {
		if err := ctx.Err(); err != nil {
			return 0, nil, 0, err
		}
		user, err := metadata.userMDUFor(ctx, dir, key, challenge.MDUIndex)
		if err != nil {
			return 0, nil, 0, err
		}
		row := uint64(challenge.LeafIndex % 8)
		path := filepath.Join(dir, fmt.Sprintf("mdu_%d_slot_%d.bin", challenge.MDUIndex, slot))
		blob, err := readExactArtifactRange(path, 8*types.BLOB_SIZE, row*types.BLOB_SIZE, types.BLOB_SIZE)
		if err != nil {
			return 0, nil, 0, err
		}
		proof, err := buildFrozenBlobProofAt(ctx, challenge.MDUIndex, challenge.LeafIndex, challenge.Z, user, blob)
		if err != nil {
			return 0, nil, 0, err
		}
		flat, err := flattenMerkleProof32(proof.MerklePath)
		if err != nil {
			return 0, nil, 0, err
		}
		valid, err := crypto_ffi.VerifyMduProof(proof.MduRootFr, proof.BlobCommitment, flat, proof.BlobIndex, retrievalchallenge.IntegrityLeavesPerUserMDU, proof.ZValue, proof.YValue, proof.KzgOpeningProof)
		if err != nil || !valid {
			return 0, nil, 0, fmt.Errorf("generated v3 proof failed native verification")
		}
		proofs[i] = types.RetrievalSampleProofV3{Ordinal: challenge.Ordinal, Proof: proof}
	}
	return slot, proofs, remaining, nil
}

func fetchFrozenRetrievalSessionV3(ctx context.Context, sessionID string) (*frozenRetrievalSessionV3, error) {
	r, height, err := queryRetrievalSessionV3(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	return freezeRetrievalSessionV3Response(r, height)
}

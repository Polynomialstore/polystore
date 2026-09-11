package keeper

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"math/big"
	"runtime"
	"sync"

	"cosmossdk.io/collections"
	cosmosmath "cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"
	gethCommon "github.com/ethereum/go-ethereum/common"
	gethCrypto "github.com/ethereum/go-ethereum/crypto"

	"polystorechain/pkg/retrievalchallenge"
	"polystorechain/x/polystorechain/types"
)

const v3SampleBitmapBytes = int((retrievalchallenge.MaxLargeSessionSamples + 7) / 8)

func rawAddress(address, field string) ([20]byte, error) {
	var out [20]byte
	canonical, err := requireCanonicalAddress(address, field)
	if err != nil {
		return out, err
	}
	addr, _ := sdk.AccAddressFromBech32(canonical)
	if len(addr) != len(out) {
		return out, sdkerrors.ErrInvalidAddress.Wrapf("%s must decode to 20 bytes", field)
	}
	copy(out[:], addr)
	return out, nil
}

func sessionPlanV3(admitted types.DealGenerationAdmissionV3, r retrievalchallenge.RangeV3) (retrievalchallenge.PlanV3, error) {
	if len(admitted.Providers) != int(v3GenerationSlots) {
		return retrievalchallenge.PlanV3{}, sdkerrors.ErrInvalidRequest.Wrap("admitted generation provider vector is invalid")
	}
	var providers [8][20]byte
	for i := range providers {
		addr, err := rawAddress(admitted.Providers[i], fmt.Sprintf("slot %d provider", i))
		if err != nil {
			return retrievalchallenge.PlanV3{}, err
		}
		providers[i] = addr
	}
	return retrievalchallenge.BuildPlanV3(r, providers)
}

func sessionContextV3(s types.RetrievalSessionV3) (retrievalchallenge.ContextV3, error) {
	var setup, id, root, integrity, plan [32]byte
	if len(s.SetupDigest) != 32 || len(s.SessionId) != 32 || len(s.PolyfsRoot) != 32 || len(s.IntegrityRoot) != 32 || len(s.PlanHash) != 32 {
		return retrievalchallenge.ContextV3{}, fmt.Errorf("invalid stored v3 session hashes")
	}
	copy(setup[:], s.SetupDigest)
	copy(id[:], s.SessionId)
	copy(root[:], s.PolyfsRoot)
	copy(integrity[:], s.IntegrityRoot)
	copy(plan[:], s.PlanHash)
	owner20, err := rawAddress(s.Owner, "session owner")
	if err != nil {
		return retrievalchallenge.ContextV3{}, err
	}
	payer20, err := rawAddress(s.Payer, "session payer")
	if err != nil {
		return retrievalchallenge.ContextV3{}, err
	}
	c := retrievalchallenge.ContextV3{
		ChainID: s.ChainId, SetupDigest: setup, SessionID: id, SessionOwner: owner20,
		DealID: s.DealId, Generation: s.Generation, PolyFSRoot: root, IntegrityRoot: integrity,
		FileRecordIndex: s.FileRecordIndex, FileStartOffset: s.FileStartOffset, FileLength: s.FileLength,
		RangeStart: s.RangeStart, RangeLength: s.RangeLength, MetadataMDUs: s.MetadataMdus, UserMDUs: s.UserMdus,
		PlanHash: plan, Population: s.Population, SampleCount: s.SampleCount, Nonce: s.Nonce,
		PriceDenom: s.PriceDenom, PricePerBlob: s.PricePerBlob.String(), BaseFee: s.BaseFee.String(),
		CompletionBurnBPS: s.CompletionBurnBps, FundingKind: uint8(s.Funding), FundingPayer: payer20,
		Window:  retrievalchallenge.Window{Snapshot: s.SnapshotHeight, Anchor: s.AnchorHeight, First: s.FirstResponseHeight, Deadline: s.DeadlineHeight},
		DealEnd: s.DealEndHeight,
	}
	if _, err := c.Bytes(); err != nil {
		return retrievalchallenge.ContextV3{}, err
	}
	return c, nil
}

func sessionObligationV3(s *types.RetrievalSessionV3, slot uint32) (*types.RetrievalObligationV3, uint32, error) {
	for i := range s.Obligations {
		if s.Obligations[i].Slot == slot {
			return &s.Obligations[i], uint32(i), nil
		}
	}
	return nil, 0, sdkerrors.ErrInvalidRequest.Wrap("slot is not represented by this session")
}

func v3BitSet(bitmap []byte, ordinal uint64) bool {
	return bitmap[ordinal/8]&(byte(1)<<uint(ordinal%8)) != 0
}
func v3SetBit(bitmap []byte, ordinal uint64) { bitmap[ordinal/8] |= byte(1) << uint(ordinal%8) }

func validateStoredSessionV3(s types.RetrievalSessionV3) (retrievalchallenge.ContextV3, error) {
	if len(s.SessionId) != 32 || len(s.ContextHash) != 32 || len(s.AcceptedSampleBitmap) != v3SampleBitmapBytes || s.AcceptedSampleBitmap[len(s.AcceptedSampleBitmap)-1]&0xf0 != 0 || len(s.Obligations) == 0 || len(s.Obligations) > 8 {
		return retrievalchallenge.ContextV3{}, fmt.Errorf("invalid stored v3 session bounds")
	}
	if s.LockedFee.IsNil() || s.LockedFee.IsNegative() || s.PricePerBlob.IsNil() || s.PricePerBlob.IsNegative() || s.BaseFee.IsNil() || s.BaseFee.IsNegative() {
		return retrievalchallenge.ContextV3{}, fmt.Errorf("invalid stored v3 session economics")
	}
	if s.Funding != types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_DEAL_ESCROW && s.Funding != types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_REQUESTER {
		return retrievalchallenge.ContextV3{}, fmt.Errorf("invalid stored v3 funding")
	}
	c, err := sessionContextV3(s)
	if err != nil {
		return c, err
	}
	r := retrievalchallenge.RangeV3{First: s.FirstBlob, Last: s.LastBlob, Population: s.Population}
	var providers [8][20]byte
	var represented uint32
	remaining := cosmosmath.ZeroInt()
	var storedSamples uint64
	for i := range s.Obligations {
		o := &s.Obligations[i]
		if o.Slot >= 8 || (i > 0 && s.Obligations[i-1].Slot >= o.Slot) || o.AssignedProvider != o.Payee || o.LockedFee.IsNil() || o.LockedFee.IsNegative() {
			return c, fmt.Errorf("invalid stored v3 obligation")
		}
		represented |= uint32(1) << o.Slot
		expected, err := checkedMulAmountV3(s.PricePerBlob, o.BlobCount)
		if err != nil || !expected.Equal(o.LockedFee) {
			return c, fmt.Errorf("invalid stored v3 obligation fee")
		}
		storedSamples += o.SampleCount
		bit := uint32(1) << o.Slot
		if s.SettledSlotsMask&bit == 0 && s.RefundedSlotsMask&bit == 0 {
			remaining, err = checkedAddAmountV3(remaining, o.LockedFee)
			if err != nil {
				return c, err
			}
		}
		p, err := rawAddress(o.AssignedProvider, "assigned provider")
		if err != nil {
			return c, err
		}
		providers[o.Slot] = p
	}
	allMasks := s.AckedSlotsMask | s.SettledSlotsMask | s.RefundedSlotsMask
	if allMasks&^represented != 0 || s.SettledSlotsMask&s.RefundedSlotsMask != 0 || s.SettledSlotsMask&^s.AckedSlotsMask != 0 || !remaining.Equal(s.LockedFee) {
		return c, fmt.Errorf("invalid stored v3 settlement state")
	}
	if storedSamples != 0 && storedSamples != s.SampleCount {
		return c, fmt.Errorf("invalid stored v3 sample partition")
	}
	p, err := retrievalchallenge.BuildPlanV3(r, providers)
	if err != nil || len(p.Obligations) != len(s.Obligations) {
		return c, fmt.Errorf("invalid stored v3 plan")
	}
	for i, po := range p.Obligations {
		so := s.Obligations[i]
		if po.Slot != so.Slot || po.BlobCount != so.BlobCount {
			return c, fmt.Errorf("stored v3 plan mismatch")
		}
	}
	h, err := p.Hash()
	if err != nil || !bytes.Equal(h[:], s.PlanHash) {
		return c, fmt.Errorf("stored v3 plan hash mismatch")
	}
	contextHash, err := c.Hash()
	if err != nil || !bytes.Equal(contextHash[:], s.ContextHash) {
		return c, fmt.Errorf("stored v3 context hash mismatch")
	}
	return c, nil
}

func checkedMulAmountV3(amount cosmosmath.Int, multiplier uint64) (cosmosmath.Int, error) {
	if amount.IsNil() || amount.IsNegative() {
		return cosmosmath.Int{}, fmt.Errorf("invalid v3 amount")
	}
	v := new(big.Int).Mul(amount.BigInt(), new(big.Int).SetUint64(multiplier))
	if v.BitLen() > 256 {
		return cosmosmath.Int{}, fmt.Errorf("v3 amount exceeds uint256")
	}
	return cosmosmath.NewIntFromBigInt(v), nil
}

func checkedAddAmountV3(a, b cosmosmath.Int) (cosmosmath.Int, error) {
	if a.IsNil() || b.IsNil() || a.IsNegative() || b.IsNegative() {
		return cosmosmath.Int{}, fmt.Errorf("invalid v3 amount")
	}
	v := new(big.Int).Add(a.BigInt(), b.BigInt())
	if v.BitLen() > 256 {
		return cosmosmath.Int{}, fmt.Errorf("v3 amount exceeds uint256")
	}
	return cosmosmath.NewIntFromBigInt(v), nil
}

func (k Keeper) retrievalSessionV3(ctx sdk.Context, sessionID []byte) (types.RetrievalSessionV3, error) {
	if len(sessionID) != 32 {
		return types.RetrievalSessionV3{}, sdkerrors.ErrInvalidRequest.Wrap("session_id must be 32 bytes")
	}
	s, err := k.RetrievalSessionsV3.Get(ctx, sessionID)
	if err != nil {
		return types.RetrievalSessionV3{}, err
	}
	if !bytes.Equal(s.SessionId, sessionID) || s.ChainId != ctx.ChainID() {
		return types.RetrievalSessionV3{}, sdkerrors.ErrInvalidRequest.Wrap("v3 session key or chain ID mismatch")
	}
	if _, err := validateStoredSessionV3(s); err != nil {
		return types.RetrievalSessionV3{}, sdkerrors.ErrInvalidRequest.Wrap(err.Error())
	}
	return s, nil
}

func materializeV3Samples(s *types.RetrievalSessionV3, anchor []byte) ([]retrievalchallenge.ChallengeV3, error) {
	c, err := validateStoredSessionV3(*s)
	if err != nil {
		return nil, err
	}
	seed, err := c.Seed(anchor)
	if err != nil {
		return nil, err
	}
	challenges, err := c.Challenges(seed[:])
	if err != nil {
		return nil, err
	}
	counts := make(map[uint32]uint64, len(s.Obligations))
	for _, ch := range challenges {
		counts[ch.Slot]++
	}
	var stored uint64
	for i := range s.Obligations {
		stored += s.Obligations[i].SampleCount
	}
	if stored != 0 && stored != s.SampleCount {
		return nil, fmt.Errorf("invalid stored v3 sample partition")
	}
	if stored == 0 {
		for i := range s.Obligations {
			s.Obligations[i].SampleCount = counts[s.Obligations[i].Slot]
		}
	} else {
		for i := range s.Obligations {
			if s.Obligations[i].SampleCount != counts[s.Obligations[i].Slot] {
				return nil, fmt.Errorf("stored v3 sample partition mismatch")
			}
		}
	}
	return challenges, nil
}

func (k Keeper) v3AnchorAndChallenges(ctx sdk.Context, s *types.RetrievalSessionV3) ([]retrievalchallenge.ChallengeV3, error) {
	if s.ChainId != ctx.ChainID() {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("v3 session chain ID mismatch")
	}
	if ctx.BlockHeight() < 0 || uint64(ctx.BlockHeight()) < s.FirstResponseHeight || uint64(ctx.BlockHeight()) > s.DeadlineHeight || s.Expired {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("outside v3 session response window")
	}
	anchor, err := k.ChallengeAnchors.Get(ctx, s.AnchorHeight)
	if err != nil || len(anchor.Seed) != 32 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("v3 session challenge seed unavailable")
	}
	return materializeV3Samples(s, anchor.Seed)
}

func openRequestMatchesV3(s types.RetrievalSessionV3, creator string, dealID, generation uint64, r types.RetrievalRangeV3, nonce, deadline uint64, funding types.RetrievalSessionFunding) bool {
	return s.Owner == creator && s.DealId == dealID && s.Generation == generation && s.FileRecordIndex == r.FileRecordIndex && s.FileStartOffset == r.FileStartOffset && s.FileLength == r.FileLength && s.RangeStart == r.RangeStart && s.RangeLength == r.RangeLength && s.Nonce == nonce && s.DeadlineHeight == deadline && s.Funding == funding
}

func (k msgServer) prepareRetrievalSessionV3(ctx sdk.Context, creator string, dealID, generation uint64, rr types.RetrievalRangeV3, nonce, deadline uint64, funding types.RetrievalSessionFunding) (types.RetrievalSessionV3, types.Deal, error) {
	var empty types.RetrievalSessionV3
	if err := k.requireRetrievalV3(ctx); err != nil {
		return empty, types.Deal{}, err
	}
	owner, err := requireCanonicalAddress(creator, "creator")
	if err != nil {
		return empty, types.Deal{}, err
	}
	nonceIDKey := collections.Join(collections.Join(owner, dealID), nonce)
	if priorID, e := k.RetrievalSessionV3NonceIDs.Get(ctx, nonceIDKey); e == nil {
		prior, e := k.retrievalSessionV3(ctx, priorID)
		if e == nil && openRequestMatchesV3(prior, owner, dealID, generation, rr, nonce, deadline, funding) {
			return prior, types.Deal{}, nil
		}
		return empty, types.Deal{}, sdkerrors.ErrInvalidRequest.Wrap("v3 nonce replay with different terms")
	} else if !errors.Is(e, collections.ErrNotFound) {
		return empty, types.Deal{}, e
	}
	deal, err := k.Deals.Get(ctx, dealID)
	if err != nil {
		return empty, deal, sdkerrors.ErrNotFound.Wrap("deal not found")
	}
	eligible, err := k.DealGenerationV3Eligible(ctx, deal)
	if err != nil || !eligible {
		return empty, deal, sdkerrors.ErrInvalidRequest.Wrap("deal generation is not eligible for v3 retrieval")
	}
	admitted, err := k.AdmittedDealGenerationsV3.Get(ctx, dealID)
	if err != nil || generation != admitted.Generation {
		return empty, deal, sdkerrors.ErrInvalidRequest.Wrap("generation does not match admitted v3 content")
	}
	if funding == types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_DEAL_ESCROW && owner != deal.Owner {
		return empty, deal, sdkerrors.ErrUnauthorized.Wrap("only the deal owner may use deal escrow")
	}
	if ctx.BlockHeight() < 1 {
		return empty, deal, sdkerrors.ErrInvalidRequest.Wrap("v3 session requires a positive snapshot height")
	}
	window, err := retrievalchallenge.SessionWindow(uint64(ctx.BlockHeight()), deadline, deal.EndBlock)
	if err != nil || deadline-uint64(ctx.BlockHeight()) > types.MaxRetrievalSessionTTL {
		return empty, deal, sdkerrors.ErrInvalidRequest.Wrap("invalid v3 session deadline")
	}
	r, err := retrievalchallenge.CheckedRangeV3(rr.FileStartOffset, rr.FileLength, rr.RangeStart, rr.RangeLength, admitted.UserMdus)
	if err != nil {
		return empty, deal, sdkerrors.ErrInvalidRequest.Wrap(err.Error())
	}
	plan, err := sessionPlanV3(admitted, r)
	if err != nil {
		return empty, deal, err
	}
	planHash, err := plan.Hash()
	if err != nil {
		return empty, deal, err
	}
	owner20, err := rawAddress(owner, "creator")
	if err != nil {
		return empty, deal, err
	}
	id, err := (retrievalchallenge.SessionBindingV3{ChainID: ctx.ChainID(), Owner: owner20, DealID: dealID, Generation: generation, FileRecordIndex: rr.FileRecordIndex, RangeStart: rr.RangeStart, RangeLength: rr.RangeLength, PlanHash: planHash, Nonce: nonce}).ID()
	if err != nil {
		return empty, deal, err
	}
	lastNonce, err := optionalSessionCount(k.RetrievalSessionV3Nonces.Get(ctx, collections.Join(owner, dealID)))
	if err != nil || nonce <= lastNonce {
		return empty, deal, sdkerrors.ErrInvalidRequest.Wrap("v3 nonce replay rejected")
	}
	params := k.GetParams(ctx)
	if !params.RetrievalPricePerBlob.IsValid() || !params.BaseRetrievalFee.IsValid() || params.RetrievalPricePerBlob.Denom != params.BaseRetrievalFee.Denom || params.RetrievalBurnBps > 10000 {
		return empty, deal, sdkerrors.ErrInvalidRequest.Wrap("invalid v3 retrieval pricing")
	}
	variable, err := checkedMulAmountV3(params.RetrievalPricePerBlob.Amount, r.Population)
	if err != nil {
		return empty, deal, sdkerrors.ErrInvalidRequest.Wrap(err.Error())
	}
	if _, err := checkedAddAmountV3(variable, params.BaseRetrievalFee.Amount); err != nil {
		return empty, deal, sdkerrors.ErrInvalidRequest.Wrap(err.Error())
	}
	obligations := make([]types.RetrievalObligationV3, len(plan.Obligations))
	for i, o := range plan.Obligations {
		provider := sdk.AccAddress(o.Assigned[:]).String()
		locked, err := checkedMulAmountV3(params.RetrievalPricePerBlob.Amount, o.BlobCount)
		if err != nil {
			return empty, deal, sdkerrors.ErrInvalidRequest.Wrap(err.Error())
		}
		obligations[i] = types.RetrievalObligationV3{Slot: o.Slot, AssignedProvider: provider, Payee: provider, BlobCount: o.BlobCount, LockedFee: locked}
	}
	s := types.RetrievalSessionV3{SessionId: append([]byte(nil), id[:]...), DealId: dealID, Generation: generation, Owner: owner, Payer: owner,
		PolyfsRoot: append([]byte(nil), admitted.PolyfsRoot...), IntegrityRoot: append([]byte(nil), admitted.IntegrityRoot...), SetupDigest: append([]byte(nil), admitted.SetupDigest...),
		FileRecordIndex: rr.FileRecordIndex, FileStartOffset: rr.FileStartOffset, FileLength: rr.FileLength, RangeStart: rr.RangeStart, RangeLength: rr.RangeLength,
		MetadataMdus: admitted.MetadataMdus, UserMdus: admitted.UserMdus, PlanHash: append([]byte(nil), planHash[:]...), FirstBlob: r.First, LastBlob: r.Last,
		Population: r.Population, SampleCount: min(r.Population, retrievalchallenge.MaxLargeSessionSamples), Nonce: nonce,
		PriceDenom: params.RetrievalPricePerBlob.Denom, PricePerBlob: params.RetrievalPricePerBlob.Amount, BaseFee: params.BaseRetrievalFee.Amount,
		CompletionBurnBps: uint32(params.RetrievalBurnBps), Funding: funding, SnapshotHeight: window.Snapshot, AnchorHeight: window.Anchor, FirstResponseHeight: window.First,
		DeadlineHeight: window.Deadline, DealEndHeight: deal.EndBlock, Obligations: obligations, AcceptedSampleBitmap: make([]byte, v3SampleBitmapBytes), LockedFee: variable,
		OpenedHeight: ctx.BlockHeight(), UpdatedHeight: ctx.BlockHeight(), ChainId: ctx.ChainID()}
	c, err := sessionContextV3(s)
	if err != nil {
		return empty, deal, sdkerrors.ErrInvalidRequest.Wrap(err.Error())
	}
	h, err := c.Hash()
	if err != nil {
		return empty, deal, err
	}
	s.ContextHash = append([]byte(nil), h[:]...)
	if _, err := validateStoredSessionV3(s); err != nil {
		return empty, deal, sdkerrors.ErrInvalidRequest.Wrap(err.Error())
	}
	if _, err := k.RetrievalSessions.Get(ctx, id[:]); err == nil {
		return empty, deal, sdkerrors.ErrInvalidRequest.Wrap("session ID collides with v2")
	} else if !errors.Is(err, collections.ErrNotFound) {
		return empty, deal, err
	}
	if _, err := k.RetrievalSessionsV3.Get(ctx, id[:]); err == nil {
		return empty, deal, sdkerrors.ErrInvalidRequest.Wrap("v3 session ID already exists without nonce index")
	} else if !errors.Is(err, collections.ErrNotFound) {
		return empty, deal, err
	}
	if err := k.checkSessionChallengeCapacityFields(ctx, uint64(s.OpenedHeight), s.DeadlineHeight, s.DealId, s.Generation); err != nil {
		return empty, deal, err
	}
	return s, deal, nil
}

func (k msgServer) storeRetrievalSessionV3(ctx sdk.Context, s types.RetrievalSessionV3) error {
	if err := k.retainSessionChallengeFields(ctx, uint64(s.OpenedHeight), s.DeadlineHeight, s.DealId, s.Generation, s.AnchorHeight, s.SessionId); err != nil {
		return err
	}
	if err := k.RetrievalSessionsV3.Set(ctx, s.SessionId, s); err != nil {
		return err
	}
	if err := k.RetrievalSessionV3Nonces.Set(ctx, collections.Join(s.Owner, s.DealId), s.Nonce); err != nil {
		return err
	}
	return k.RetrievalSessionV3NonceIDs.Set(ctx, collections.Join(collections.Join(s.Owner, s.DealId), s.Nonce), s.SessionId)
}

func v3OpenResponse(s types.RetrievalSessionV3) *types.MsgOpenRetrievalSessionV3Response {
	return &types.MsgOpenRetrievalSessionV3Response{SessionId: s.SessionId, LogicalRequestedBytes: s.RangeLength, BilledEncodedBytes: s.Population * retrievalchallenge.EncodedBlobBytes, SampleCount: s.SampleCount}
}

func (k msgServer) OpenRetrievalSessionV3(goCtx context.Context, msg *types.MsgOpenRetrievalSessionV3) (*types.MsgOpenRetrievalSessionV3Response, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)
	if msg == nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("message is required")
	}
	s, deal, err := k.prepareRetrievalSessionV3(ctx, msg.Creator, msg.DealId, msg.Generation, msg.Range, msg.Nonce, msg.DeadlineHeight, types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_DEAL_ESCROW)
	if err != nil {
		return nil, err
	}
	if _, err := k.RetrievalSessionsV3.Get(ctx, s.SessionId); err == nil {
		return v3OpenResponse(s), nil
	}
	total, err := checkedAddAmountV3(s.LockedFee, s.BaseFee)
	if err != nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrap(err.Error())
	}
	if deal.EscrowBalance.LT(total) {
		return nil, sdkerrors.ErrInsufficientFunds.Wrap("insufficient deal escrow for v3 retrieval")
	}
	deal.EscrowBalance = deal.EscrowBalance.Sub(total)
	if err := k.setDealWithAssignmentCollateralLocks(ctx, deal.Id, deal); err != nil {
		return nil, err
	}
	if s.BaseFee.IsPositive() {
		if err := k.BankKeeper.BurnCoins(ctx, types.ModuleName, sdk.NewCoins(sdk.NewCoin(s.PriceDenom, s.BaseFee))); err != nil {
			return nil, err
		}
	}
	if err := k.storeRetrievalSessionV3(ctx, s); err != nil {
		return nil, err
	}
	if err := k.recordRetrievalDemand(ctx, s.Population); err != nil {
		return nil, err
	}
	return v3OpenResponse(s), nil
}

func v3VoucherLegacyRange(s types.RetrievalSessionV3) (string, uint64, uint32, uint64, error) {
	if len(s.Obligations) != 1 || s.Population != 1 || s.Obligations[0].BlobCount != 1 {
		return "", 0, 0, 0, sdkerrors.ErrUnauthorized.Wrap("voucher cannot authorize multiple v3 provider obligations")
	}
	o := s.Obligations[0]
	mdu, leaf, slot, err := retrievalchallenge.SystematicCoordinateV3(s.FirstBlob, s.MetadataMdus, s.UserMdus)
	if err != nil || slot != o.Slot {
		return "", 0, 0, 0, sdkerrors.ErrUnauthorized.Wrap("voucher range does not match the frozen v3 obligation")
	}
	return o.AssignedProvider, mdu, leaf, 1, nil
}

func (k msgServer) consumeVoucherV3(ctx sdk.Context, deal *types.Deal, s types.RetrievalSessionV3, v *types.VoucherAuth) error {
	provider, mdu, leaf, count, err := v3VoucherLegacyRange(s)
	if err != nil {
		return err
	}
	legacy := &types.MsgOpenRetrievalSessionSponsored{
		Creator: s.Owner, DealId: s.DealId, Provider: provider, AuthorizedProofProvider: provider,
		ManifestRoot: append([]byte(nil), s.PolyfsRoot...), StartMduIndex: mdu, StartBlobIndex: leaf,
		BlobCount: count, Nonce: s.Nonce, ExpiresAt: s.DeadlineHeight, ChallengeVersion: retrievalchallenge.Version,
	}
	return k.verifyAndConsumeVoucher(ctx, deal, legacy, v)
}

func (k msgServer) OpenRetrievalSessionV3Sponsored(goCtx context.Context, msg *types.MsgOpenRetrievalSessionV3Sponsored) (*types.MsgOpenRetrievalSessionV3Response, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)
	if msg == nil || msg.MaxTotalFee.IsNil() || msg.MaxTotalFee.IsNegative() {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("max_total_fee must be nonnegative")
	}
	s, deal, err := k.prepareRetrievalSessionV3(ctx, msg.Creator, msg.DealId, msg.Generation, msg.Range, msg.Nonce, msg.DeadlineHeight, types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_REQUESTER)
	if err != nil {
		return nil, err
	}
	total, err := checkedAddAmountV3(s.LockedFee, s.BaseFee)
	if err != nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrap(err.Error())
	}
	if msg.MaxTotalFee.IsPositive() && total.GT(msg.MaxTotalFee) {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("total fee exceeds max_total_fee")
	}
	if _, err := k.RetrievalSessionsV3.Get(ctx, s.SessionId); err == nil {
		return v3OpenResponse(s), nil
	}
	creatorAddr, err := sdk.AccAddressFromBech32(s.Owner)
	if err != nil {
		return nil, sdkerrors.ErrInvalidAddress.Wrap("invalid v3 requester")
	}
	mode := normalizeRetrievalPolicyMode(deal.RetrievalPolicy.Mode)
	if mode == types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_OWNER_ONLY {
		return nil, sdkerrors.ErrUnauthorized.Wrap("sponsored retrieval sessions are not allowed for owner-only deals")
	}
	var voucher *types.VoucherAuth
	if s.Owner != deal.Owner {
		allowlisted := func() bool {
			proof := msg.GetAllowlistProof()
			if proof == nil || len(deal.RetrievalPolicy.AllowlistRoot) != 32 {
				return false
			}
			return types.VerifyKeccakMerklePath(gethCommon.BytesToHash(deal.RetrievalPolicy.AllowlistRoot), gethCrypto.Keccak256Hash(creatorAddr.Bytes()), proof.LeafIndex, proof.MerklePath)
		}
		switch mode {
		case types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_PUBLIC:
		case types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_ALLOWLIST:
			if !allowlisted() {
				return nil, sdkerrors.ErrUnauthorized.Wrap("valid allowlist proof is required")
			}
		case types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_VOUCHER:
			voucher = msg.GetVoucher()
			if voucher == nil {
				return nil, sdkerrors.ErrUnauthorized.Wrap("voucher is required")
			}
		case types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_ALLOWLIST_OR_VOUCHER:
			if !allowlisted() {
				voucher = msg.GetVoucher()
				if voucher == nil {
					return nil, sdkerrors.ErrUnauthorized.Wrap("allowlist proof or voucher is required")
				}
			}
		default:
			return nil, sdkerrors.ErrUnauthorized.Wrap("unsupported retrieval policy mode")
		}
	}
	if voucher != nil {
		if _, _, _, _, err := v3VoucherLegacyRange(s); err != nil {
			return nil, err
		}
	}
	if k.BankKeeper.SpendableCoins(ctx, creatorAddr).AmountOf(s.PriceDenom).LT(total) {
		return nil, sdkerrors.ErrInsufficientFunds.Wrap("insufficient requester balance for v3 retrieval")
	}
	if voucher != nil {
		if err := k.consumeVoucherV3(ctx, &deal, s, voucher); err != nil {
			return nil, err
		}
	}
	if total.IsPositive() {
		if err := k.BankKeeper.SendCoinsFromAccountToModule(ctx, creatorAddr, types.ModuleName, sdk.NewCoins(sdk.NewCoin(s.PriceDenom, total))); err != nil {
			return nil, err
		}
	}
	if s.BaseFee.IsPositive() {
		if err := k.BankKeeper.BurnCoins(ctx, types.ModuleName, sdk.NewCoins(sdk.NewCoin(s.PriceDenom, s.BaseFee))); err != nil {
			return nil, err
		}
	}
	if err := k.storeRetrievalSessionV3(ctx, s); err != nil {
		return nil, err
	}
	if err := k.recordRetrievalDemand(ctx, s.Population); err != nil {
		return nil, err
	}
	return v3OpenResponse(s), nil
}

func ceilBPS(amount cosmosmath.Int, bps uint32) cosmosmath.Int {
	if !amount.IsPositive() || bps == 0 {
		return cosmosmath.ZeroInt()
	}
	quotient := amount.QuoRaw(10000).MulRaw(int64(bps))
	remainder := amount.ModRaw(10000).MulRaw(int64(bps))
	return quotient.Add(remainder.AddRaw(9999).QuoRaw(10000))
}

func (k msgServer) settleRetrievalObligationV3(ctx sdk.Context, s *types.RetrievalSessionV3, obligationIndex uint32, challenges []retrievalchallenge.ChallengeV3) (settled, changed bool, err error) {
	o := &s.Obligations[obligationIndex]
	bit := uint32(1) << o.Slot
	if s.SettledSlotsMask&bit != 0 {
		return true, false, nil
	}
	if s.RefundedSlotsMask&bit != 0 || s.AckedSlotsMask&bit == 0 {
		return false, false, nil
	}
	for _, ch := range challenges {
		if ch.Slot == o.Slot && !v3BitSet(s.AcceptedSampleBitmap, ch.Ordinal) {
			return false, false, nil
		}
	}
	burn := ceilBPS(o.LockedFee, s.CompletionBurnBps)
	pay := o.LockedFee.Sub(burn)
	if burn.IsPositive() {
		if err := k.BankKeeper.BurnCoins(ctx, types.ModuleName, sdk.NewCoins(sdk.NewCoin(s.PriceDenom, burn))); err != nil {
			return false, false, err
		}
	}
	if pay.IsPositive() {
		addr, err := sdk.AccAddressFromBech32(o.Payee)
		if err != nil {
			return false, false, err
		}
		if err := k.BankKeeper.SendCoinsFromModuleToAccount(ctx, types.ModuleName, addr, sdk.NewCoins(sdk.NewCoin(s.PriceDenom, pay))); err != nil {
			return false, false, err
		}
	}
	s.LockedFee = s.LockedFee.Sub(o.LockedFee)
	s.SettledSlotsMask |= bit
	return true, true, nil
}

func (k msgServer) SubmitRetrievalSessionProofV3(goCtx context.Context, msg *types.MsgSubmitRetrievalSessionProofV3) (*types.MsgSubmitRetrievalSessionProofV3Response, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)
	if err := k.requireRetrievalV3(ctx); err != nil {
		return nil, err
	}
	if msg == nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("session_id must be 32 bytes")
	}
	prepared, err := k.prepareRetrievalSessionProofV3(ctx, msg.Creator, msg.SessionId, msg.Slot, msg.Proofs)
	if err != nil {
		return nil, err
	}
	if err := PrepayProofCrypto(ctx, uint64(len(msg.Proofs))); err != nil {
		return nil, err
	}
	for i := range msg.Proofs {
		ok, err := verifyPolyFSChainedProof(prepared.session.PolyfsRoot, &msg.Proofs[i].Proof, v3IntegrityLeavesPerMDU)
		if err != nil || !ok {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("invalid v3 chained proof")
		}
	}
	return k.applyPreparedRetrievalSessionProofV3(ctx, prepared, &prepared.session)
}

type preparedRetrievalSessionProofV3 struct {
	session         types.RetrievalSessionV3
	obligationIndex uint32
	challenges      []retrievalchallenge.ChallengeV3
	proofs          []types.RetrievalSampleProofV3
}

type retrievalProofVerificationV3 struct {
	root  []byte
	proof *types.ChainedProof
}

type retrievalProofVerificationResultV3 struct {
	ok  bool
	err error
}

type retrievalSessionProofKeyV3 struct {
	sessionID string
	slot      uint32
}

func (k msgServer) prepareRetrievalSessionProofV3(ctx sdk.Context, creator string, sessionID []byte, slot uint32, proofs []types.RetrievalSampleProofV3) (preparedRetrievalSessionProofV3, error) {
	if len(sessionID) != 32 {
		return preparedRetrievalSessionProofV3{}, sdkerrors.ErrInvalidRequest.Wrap("session_id must be 32 bytes")
	}
	canonicalCreator, err := requireCanonicalProviderCreator(creator)
	if err != nil {
		return preparedRetrievalSessionProofV3{}, err
	}
	s, err := k.retrievalSessionV3(ctx, sessionID)
	if err != nil {
		return preparedRetrievalSessionProofV3{}, err
	}
	o, oi, err := sessionObligationV3(&s, slot)
	if err != nil {
		return preparedRetrievalSessionProofV3{}, err
	}
	if canonicalCreator != o.AssignedProvider {
		return preparedRetrievalSessionProofV3{}, sdkerrors.ErrUnauthorized.Wrap("creator is not the frozen provider for this obligation")
	}
	if err := ValidateProofCount(uint64(len(proofs))); err != nil {
		return preparedRetrievalSessionProofV3{}, sdkerrors.ErrInvalidRequest.Wrap(err.Error())
	}
	challenges, err := k.v3AnchorAndChallenges(ctx, &s)
	if err != nil {
		return preparedRetrievalSessionProofV3{}, err
	}
	seen := make(map[uint64]struct{}, len(proofs))
	for i := range proofs {
		sp := &proofs[i]
		if sp.Ordinal >= uint64(len(challenges)) {
			return preparedRetrievalSessionProofV3{}, sdkerrors.ErrInvalidRequest.Wrap("sample ordinal out of range")
		}
		if _, ok := seen[sp.Ordinal]; ok {
			return preparedRetrievalSessionProofV3{}, sdkerrors.ErrInvalidRequest.Wrap("sample ordinal repeated within message")
		}
		seen[sp.Ordinal] = struct{}{}
		ch := challenges[sp.Ordinal]
		p := &sp.Proof
		if ch.Slot != slot || p.MduIndex != ch.MDUIndex || p.BlobIndex != ch.LeafIndex || !bytes.Equal(p.ZValue, ch.Z[:]) {
			return preparedRetrievalSessionProofV3{}, sdkerrors.ErrInvalidRequest.Wrap("proof does not match selected v3 sample")
		}
		if err := ValidateChainedProofShape(s.PolyfsRoot, p, v3IntegrityLeavesPerMDU); err != nil {
			return preparedRetrievalSessionProofV3{}, sdkerrors.ErrInvalidRequest.Wrap(err.Error())
		}
	}
	return preparedRetrievalSessionProofV3{session: s, obligationIndex: oi, challenges: challenges, proofs: proofs}, nil
}

func retrievalProofWorkerCountV3(total int) int {
	workers := runtime.GOMAXPROCS(0)
	if workers > 8 {
		workers = 8
	}
	if workers > total {
		workers = total
	}
	if workers < 1 {
		workers = 1
	}
	return workers
}

// verifyRetrievalProofsV3 performs only the pure native proof check in workers.
// Results retain input order; no keeper, bank, gas-meter or event access occurs here.
func verifyRetrievalProofsV3(jobs []retrievalProofVerificationV3, workers int) []retrievalProofVerificationResultV3 {
	results := make([]retrievalProofVerificationResultV3, len(jobs))
	if len(jobs) == 0 {
		return results
	}
	if workers > len(jobs) {
		workers = len(jobs)
	}
	if workers < 1 {
		workers = 1
	}
	indices := make(chan int)
	var group sync.WaitGroup
	group.Add(workers)
	for i := 0; i < workers; i++ {
		go func() {
			defer group.Done()
			for index := range indices {
				results[index].ok, results[index].err = verifyPolyFSChainedProof(jobs[index].root, jobs[index].proof, v3IntegrityLeavesPerMDU)
			}
		}()
	}
	for i := range jobs {
		indices <- i
	}
	close(indices)
	group.Wait()
	return results
}

func (k msgServer) applyPreparedRetrievalSessionProofV3(ctx sdk.Context, prepared preparedRetrievalSessionProofV3, session *types.RetrievalSessionV3) (*types.MsgSubmitRetrievalSessionProofV3Response, error) {
	var samplesBefore uint64
	for i := range session.Obligations {
		samplesBefore += session.Obligations[i].SampleCount
	}
	var added uint32
	for _, sp := range prepared.proofs {
		if !v3BitSet(session.AcceptedSampleBitmap, sp.Ordinal) {
			v3SetBit(session.AcceptedSampleBitmap, sp.Ordinal)
			added++
		}
	}
	settled, settlementChanged, err := k.settleRetrievalObligationV3(ctx, session, prepared.obligationIndex, prepared.challenges)
	if err != nil {
		return nil, err
	}
	if samplesBefore == 0 || added != 0 || settlementChanged {
		session.UpdatedHeight = ctx.BlockHeight()
		if err := k.RetrievalSessionsV3.Set(ctx, session.SessionId, *session); err != nil {
			return nil, err
		}
	}
	return &types.MsgSubmitRetrievalSessionProofV3Response{NewlyAccepted: added, Settled: settled}, nil
}

// SubmitRetrievalSessionProofBatchV3 verifies bounded, same-provider session
// proofs concurrently, then applies every state transition in input order.
func (k msgServer) SubmitRetrievalSessionProofBatchV3(goCtx context.Context, msg *types.MsgSubmitRetrievalSessionProofBatchV3) (*types.MsgSubmitRetrievalSessionProofBatchV3Response, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)
	if err := k.requireRetrievalV3(ctx); err != nil {
		return nil, err
	}
	if msg == nil || len(msg.Sessions) == 0 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("batch must contain at least one session")
	}
	if msg.Size() > MaxProofEnvelopeBytes {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("proof envelope exceeds %d bytes", MaxProofEnvelopeBytes)
	}
	totalProofs := 0
	seen := make(map[retrievalSessionProofKeyV3]struct{}, len(msg.Sessions))
	for i := range msg.Sessions {
		entry := &msg.Sessions[i]
		if len(entry.SessionId) != 32 {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("session_id must be 32 bytes")
		}
		key := retrievalSessionProofKeyV3{sessionID: string(entry.SessionId), slot: entry.Slot}
		if _, ok := seen[key]; ok {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("duplicate session_id and slot in batch")
		}
		seen[key] = struct{}{}
		if len(entry.Proofs) == 0 || totalProofs > MaxProofsPerMessage-len(entry.Proofs) {
			return nil, sdkerrors.ErrInvalidRequest.Wrapf("proof count must be 1..%d", MaxProofsPerMessage)
		}
		totalProofs += len(entry.Proofs)
	}

	prepared := make([]preparedRetrievalSessionProofV3, len(msg.Sessions))
	jobs := make([]retrievalProofVerificationV3, 0, totalProofs)
	jobPositions := make([][2]int, 0, totalProofs)
	for i := range msg.Sessions {
		entry := &msg.Sessions[i]
		entryPrepared, err := k.prepareRetrievalSessionProofV3(ctx, msg.Creator, entry.SessionId, entry.Slot, entry.Proofs)
		if err != nil {
			return nil, err
		}
		prepared[i] = entryPrepared
		for j := range entry.Proofs {
			jobs = append(jobs, retrievalProofVerificationV3{root: prepared[i].session.PolyfsRoot, proof: &entry.Proofs[j].Proof})
			jobPositions = append(jobPositions, [2]int{i, j})
		}
	}
	if err := PrepayProofCrypto(ctx, uint64(totalProofs)); err != nil {
		return nil, err
	}
	verification := verifyRetrievalProofsV3(jobs, retrievalProofWorkerCountV3(totalProofs))
	for i := range verification {
		if verification[i].err != nil || !verification[i].ok {
			return nil, sdkerrors.ErrInvalidRequest.Wrapf("batch entry %d proof %d: invalid v3 chained proof", jobPositions[i][0], jobPositions[i][1])
		}
	}

	response := &types.MsgSubmitRetrievalSessionProofBatchV3Response{Results: make([]types.MsgSubmitRetrievalSessionProofV3Response, len(prepared))}
	updated := make(map[string]types.RetrievalSessionV3, len(prepared))
	for i := range prepared {
		key := string(prepared[i].session.SessionId)
		session, ok := updated[key]
		if !ok {
			session = prepared[i].session
		}
		result, err := k.applyPreparedRetrievalSessionProofV3(ctx, prepared[i], &session)
		if err != nil {
			return nil, err
		}
		updated[key] = session
		response.Results[i] = *result
	}
	return response, nil
}

func (k msgServer) AcknowledgeRetrievalObligationV3(goCtx context.Context, msg *types.MsgAcknowledgeRetrievalObligationV3) (*types.MsgAcknowledgeRetrievalObligationV3Response, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)
	if err := k.requireRetrievalV3(ctx); err != nil {
		return nil, err
	}
	if msg == nil || len(msg.SessionId) != 32 || len(msg.AckDigest) != 32 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("invalid v3 ACK envelope")
	}
	creator, err := requireCanonicalAddress(msg.Creator, "creator")
	if err != nil {
		return nil, err
	}
	s, err := k.retrievalSessionV3(ctx, msg.SessionId)
	if err != nil {
		return nil, err
	}
	if creator != s.Owner {
		return nil, sdkerrors.ErrUnauthorized.Wrap("only the frozen session owner may acknowledge")
	}
	o, oi, err := sessionObligationV3(&s, msg.Slot)
	if err != nil {
		return nil, err
	}
	var samplesBefore uint64
	for i := range s.Obligations {
		samplesBefore += s.Obligations[i].SampleCount
	}
	challenges, err := k.v3AnchorAndChallenges(ctx, &s)
	if err != nil {
		return nil, err
	}
	assigned, _ := rawAddress(o.AssignedProvider, "assigned provider")
	payee, _ := rawAddress(o.Payee, "payee")
	var sid, contextHash, planHash, integrity [32]byte
	copy(sid[:], s.SessionId)
	copy(contextHash[:], s.ContextHash)
	copy(planHash[:], s.PlanHash)
	copy(integrity[:], s.IntegrityRoot)
	digest, err := (retrievalchallenge.ObligationAckV3{ChainID: s.ChainId, SessionID: sid, ContextHash: contextHash, PlanHash: planHash, Slot: o.Slot, Assigned: assigned, Payee: payee, BlobCount: o.BlobCount, BilledEncodedBytes: o.BlobCount * retrievalchallenge.EncodedBlobBytes, IntegrityRoot: integrity}).Hash()
	if err != nil || !bytes.Equal(digest[:], msg.AckDigest) {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("ACK digest does not match frozen obligation")
	}
	bit := uint32(1) << o.Slot
	ackChanged := s.AckedSlotsMask&bit == 0
	s.AckedSlotsMask |= bit
	settled, settlementChanged, err := k.settleRetrievalObligationV3(ctx, &s, oi, challenges)
	if err != nil {
		return nil, err
	}
	if samplesBefore == 0 || ackChanged || settlementChanged {
		s.UpdatedHeight = ctx.BlockHeight()
		if err := k.RetrievalSessionsV3.Set(ctx, s.SessionId, s); err != nil {
			return nil, err
		}
	}
	return &types.MsgAcknowledgeRetrievalObligationV3Response{Settled: settled}, nil
}

func (k msgServer) RefundRetrievalSessionV3(goCtx context.Context, msg *types.MsgRefundRetrievalSessionV3) (*types.MsgRefundRetrievalSessionV3Response, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)
	if err := k.requireRetrievalV3(ctx); err != nil {
		return nil, err
	}
	if msg == nil || len(msg.SessionId) != 32 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("session_id must be 32 bytes")
	}
	creator, err := requireCanonicalAddress(msg.Creator, "creator")
	if err != nil {
		return nil, err
	}
	s, err := k.retrievalSessionV3(ctx, msg.SessionId)
	if err != nil {
		return nil, err
	}
	if creator != s.Owner {
		return nil, sdkerrors.ErrUnauthorized.Wrap("only the frozen session owner may refund")
	}
	if ctx.BlockHeight() < 0 || uint64(ctx.BlockHeight()) <= s.DeadlineHeight {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("v3 session has not expired")
	}
	var refund cosmosmath.Int = cosmosmath.ZeroInt()
	changed := false
	for i := range s.Obligations {
		o := &s.Obligations[i]
		bit := uint32(1) << o.Slot
		if s.SettledSlotsMask&bit == 0 && s.RefundedSlotsMask&bit == 0 {
			refund, err = checkedAddAmountV3(refund, o.LockedFee)
			if err != nil {
				return nil, sdkerrors.ErrInvalidRequest.Wrap("invalid frozen v3 refund total")
			}
			s.RefundedSlotsMask |= bit
			changed = true
		}
	}
	if refund.IsPositive() {
		switch s.Funding {
		case types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_DEAL_ESCROW:
			deal, err := k.Deals.Get(ctx, s.DealId)
			if err != nil {
				return nil, err
			}
			if deal.Owner != s.Payer || s.Payer != s.Owner {
				return nil, sdkerrors.ErrInvalidRequest.Wrap("invalid frozen deal escrow payer")
			}
			deal.EscrowBalance, err = checkedAddAmountV3(deal.EscrowBalance, refund)
			if err != nil {
				return nil, sdkerrors.ErrInvalidRequest.Wrap("deal escrow refund overflows")
			}
			if err := k.setDealWithAssignmentCollateralLocks(ctx, deal.Id, deal); err != nil {
				return nil, err
			}
		case types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_REQUESTER:
			payer, err := sdk.AccAddressFromBech32(s.Payer)
			if err != nil || s.Payer != s.Owner {
				return nil, sdkerrors.ErrInvalidRequest.Wrap("invalid frozen requester payer")
			}
			if err := k.BankKeeper.SendCoinsFromModuleToAccount(ctx, types.ModuleName, payer, sdk.NewCoins(sdk.NewCoin(s.PriceDenom, refund))); err != nil {
				return nil, err
			}
		default:
			return nil, sdkerrors.ErrInvalidRequest.Wrap("invalid frozen funding kind")
		}
		s.LockedFee = s.LockedFee.Sub(refund)
	}
	if !changed {
		return &types.MsgRefundRetrievalSessionV3Response{Refunded: false}, nil
	}
	s.Expired = true
	s.UpdatedHeight = ctx.BlockHeight()
	if err := k.RetrievalSessionsV3.Set(ctx, s.SessionId, s); err != nil {
		return nil, err
	}
	return &types.MsgRefundRetrievalSessionV3Response{Refunded: true}, nil
}

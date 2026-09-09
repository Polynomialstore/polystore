package keeper

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"math"

	"cosmossdk.io/collections"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"

	"polystorechain/pkg/retrievalchallenge"
	"polystorechain/x/polystorechain/types"
)

const (
	v3GenerationSlots       = uint32(12)
	v3GenerationAcceptedAll = uint32(1<<v3GenerationSlots) - 1
	v3IntegrityLeavesPerMDU = uint64(96)
)

func (k Keeper) requireRetrievalV3(ctx sdk.Context) error {
	active, err := k.RetrievalV3Active(ctx)
	if err != nil {
		return err
	}
	if !active {
		return sdkerrors.ErrInvalidRequest.Wrap("retrieval v3 is not active")
	}
	return nil
}

func setupDigestV3() ([32]byte, error) {
	var out [32]byte
	raw, err := hex.DecodeString(types.RetrievalSetupDigest)
	if err != nil || len(raw) != len(out) {
		return out, fmt.Errorf("invalid compiled retrieval setup digest")
	}
	copy(out[:], raw)
	return out, nil
}

func activeK8M4Providers(deal types.Deal) ([]string, error) {
	if deal.RedundancyMode != 2 || deal.Mode2Profile == nil || deal.Mode2Profile.K != 8 || deal.Mode2Profile.M != 4 || len(deal.Mode2Slots) != int(v3GenerationSlots) {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("FAT v3 requires the fixed Mode 2 K=8,M=4 profile with 12 slots")
	}
	providers := make([]string, v3GenerationSlots)
	seen := make(map[string]struct{}, v3GenerationSlots)
	for i, slot := range deal.Mode2Slots {
		if slot == nil || slot.Slot != uint32(i) || slot.Status != types.SlotStatus_SLOT_STATUS_ACTIVE || slot.PendingProvider != "" {
			return nil, sdkerrors.ErrInvalidRequest.Wrapf("slot %d must be active, ordered, and not repairing", i)
		}
		provider, err := requireCanonicalAddress(slot.Provider, fmt.Sprintf("slot %d provider", i))
		if err != nil {
			return nil, err
		}
		if _, duplicate := seen[provider]; duplicate {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("FAT v3 requires twelve distinct slot providers")
		}
		seen[provider] = struct{}{}
		providers[i] = provider
	}
	return providers, nil
}

func generationSnapshotEqual(a, b types.DealGenerationAdmissionV3) bool {
	if a.DealId != b.DealId || a.Owner != b.Owner || a.Generation != b.Generation ||
		a.Size_ != b.Size_ || a.TotalMdus != b.TotalMdus || a.WitnessMdus != b.WitnessMdus ||
		a.MetadataMdus != b.MetadataMdus || a.UserMdus != b.UserMdus ||
		a.IntegrityLeafCount != b.IntegrityLeafCount || a.ChainId != b.ChainId ||
		!bytes.Equal(a.PreviousPolyfsRoot, b.PreviousPolyfsRoot) || !bytes.Equal(a.PolyfsRoot, b.PolyfsRoot) ||
		!bytes.Equal(a.IntegrityRoot, b.IntegrityRoot) || !bytes.Equal(a.SetupDigest, b.SetupDigest) ||
		len(a.Providers) != len(b.Providers) {
		return false
	}
	for i := range a.Providers {
		if a.Providers[i] != b.Providers[i] {
			return false
		}
	}
	return true
}

func (k Keeper) validateGenerationSnapshot(ctx sdk.Context, deal types.Deal, snapshot types.DealGenerationAdmissionV3, pending bool) error {
	if snapshot.DealId != deal.Id || snapshot.Owner != deal.Owner || snapshot.ChainId != ctx.ChainID() {
		return sdkerrors.ErrInvalidRequest.Wrap("generation admission identity no longer matches the deal")
	}
	if ctx.BlockHeight() < 0 || uint64(ctx.BlockHeight()) >= deal.EndBlock {
		return sdkerrors.ErrInvalidRequest.Wrap("deal is expired")
	}
	if pending {
		if snapshot.Generation == 0 || deal.CurrentGen == math.MaxUint64 || snapshot.Generation != deal.CurrentGen+1 {
			return sdkerrors.ErrInvalidRequest.Wrap("generation admission no longer follows the current generation")
		}
		if !bytes.Equal(snapshot.PreviousPolyfsRoot, deal.ManifestRoot) {
			return sdkerrors.ErrInvalidRequest.Wrap("generation admission previous root no longer matches")
		}
	} else if snapshot.Generation != deal.CurrentGen || !bytes.Equal(snapshot.PolyfsRoot, deal.ManifestRoot) || snapshot.Size_ != deal.Size_ || snapshot.TotalMdus != deal.TotalMdus || snapshot.WitnessMdus != deal.WitnessMdus {
		return sdkerrors.ErrInvalidRequest.Wrap("admitted generation no longer matches current deal content")
	}
	if len(snapshot.PolyfsRoot) != types.POLYFS_ROOT_SIZE || len(snapshot.IntegrityRoot) != 32 || (pending && bytes.Equal(snapshot.PolyfsRoot, deal.ManifestRoot)) {
		return sdkerrors.ErrInvalidRequest.Wrap("invalid generation roots")
	}
	if snapshot.Size_ == 0 || snapshot.Size_ > types.MAX_DEAL_BYTES {
		return sdkerrors.ErrInvalidRequest.Wrap("invalid generation size")
	}
	if err := validatePolyFSContentLayout(deal, snapshot.Size_, snapshot.TotalMdus, snapshot.WitnessMdus); err != nil {
		return err
	}
	if pending && deal.TotalMdus != 0 && snapshot.TotalMdus < deal.TotalMdus {
		return sdkerrors.ErrInvalidRequest.Wrap("total_mdus cannot decrease")
	}
	metadata, overflow := addUint64(1, snapshot.WitnessMdus)
	if overflow || metadata != snapshot.MetadataMdus || snapshot.TotalMdus <= metadata || snapshot.UserMdus != snapshot.TotalMdus-metadata {
		return sdkerrors.ErrInvalidRequest.Wrap("invalid generation MDU counts")
	}
	leaves, overflow := mulUint64(snapshot.UserMdus, v3IntegrityLeavesPerMDU)
	if overflow || leaves != snapshot.IntegrityLeafCount {
		return sdkerrors.ErrInvalidRequest.Wrap("invalid integrity leaf count")
	}
	setup, err := setupDigestV3()
	if err != nil || !bytes.Equal(snapshot.SetupDigest, setup[:]) {
		return sdkerrors.ErrInvalidRequest.Wrap("generation setup digest no longer matches")
	}
	providers, err := activeK8M4Providers(deal)
	if err != nil || len(providers) != len(snapshot.Providers) {
		return sdkerrors.ErrInvalidRequest.Wrap("generation provider assignments no longer match")
	}
	for i := range providers {
		if providers[i] != snapshot.Providers[i] {
			return sdkerrors.ErrInvalidRequest.Wrapf("generation provider assignment changed at slot %d", i)
		}
		if _, err := k.Providers.Get(ctx, providers[i]); err != nil {
			return sdkerrors.ErrInvalidRequest.Wrapf("slot %d provider is not registered", i)
		}
	}
	if snapshot.AcceptedSlotsMask&^v3GenerationAcceptedAll != 0 || (!pending && snapshot.AcceptedSlotsMask != v3GenerationAcceptedAll) {
		return sdkerrors.ErrInvalidRequest.Wrap("invalid generation acceptance bitmap")
	}
	return nil
}

// DealGenerationV3Eligible compares the admitted provider consent snapshot to
// current deal state. Existing sessions retain their own frozen generation;
// this helper is only for new v3 admission.
func (k Keeper) DealGenerationV3Eligible(ctx sdk.Context, deal types.Deal) (bool, error) {
	admitted, err := k.AdmittedDealGenerationsV3.Get(ctx, deal.Id)
	if errors.Is(err, collections.ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if err := k.validateGenerationSnapshot(ctx, deal, admitted, false); err != nil {
		return false, nil
	}
	return true, nil
}

func (k msgServer) ProposeDealGenerationV3(goCtx context.Context, msg *types.MsgProposeDealGenerationV3) (*types.MsgProposeDealGenerationV3Response, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)
	if err := k.requireRetrievalV3(ctx); err != nil {
		return nil, err
	}
	creator, err := requireCanonicalAddress(msg.Creator, "creator")
	if err != nil {
		return nil, err
	}
	deal, err := k.Deals.Get(ctx, msg.DealId)
	if err != nil {
		return nil, sdkerrors.ErrNotFound.Wrapf("deal %d not found", msg.DealId)
	}
	if creator != deal.Owner {
		return nil, sdkerrors.ErrUnauthorized.Wrap("only the deal owner may propose a generation")
	}
	if ctx.BlockHeight() < 0 || uint64(ctx.BlockHeight()) >= deal.EndBlock {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("deal is expired")
	}
	if msg.ExpectedCurrentGeneration != deal.CurrentGen || deal.CurrentGen == math.MaxUint64 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("stale or overflowing current generation")
	}
	providers, err := activeK8M4Providers(deal)
	if err != nil {
		return nil, err
	}
	metadata, overflow := addUint64(1, msg.WitnessMdus)
	if overflow || msg.TotalMdus <= metadata {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("invalid generation MDU counts")
	}
	setup, err := setupDigestV3()
	if err != nil {
		return nil, err
	}
	candidate := types.DealGenerationAdmissionV3{
		DealId: msg.DealId, Owner: creator, Generation: deal.CurrentGen + 1,
		PreviousPolyfsRoot: append([]byte(nil), msg.PreviousPolyfsRoot...), PolyfsRoot: append([]byte(nil), msg.PolyfsRoot...),
		IntegrityRoot: append([]byte(nil), msg.IntegrityRoot...), Size_: msg.Size_, TotalMdus: msg.TotalMdus,
		WitnessMdus: msg.WitnessMdus, MetadataMdus: metadata, UserMdus: msg.TotalMdus - metadata,
		IntegrityLeafCount: msg.IntegrityLeafCount, SetupDigest: append([]byte(nil), setup[:]...),
		Providers: providers, ProposedHeight: ctx.BlockHeight(), ChainId: ctx.ChainID(),
	}
	if err := k.validateGenerationSnapshot(ctx, deal, candidate, true); err != nil {
		return nil, err
	}
	if existing, err := k.PendingDealGenerationsV3.Get(ctx, msg.DealId); err == nil && generationSnapshotEqual(existing, candidate) {
		return &types.MsgProposeDealGenerationV3Response{Generation: existing.Generation}, nil
	} else if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return nil, err
	}
	if err := k.PendingDealGenerationsV3.Set(ctx, msg.DealId, candidate); err != nil {
		return nil, err
	}
	return &types.MsgProposeDealGenerationV3Response{Generation: candidate.Generation}, nil
}

func (k msgServer) AcceptDealGenerationV3(goCtx context.Context, msg *types.MsgAcceptDealGenerationV3) (*types.MsgAcceptDealGenerationV3Response, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)
	if err := k.requireRetrievalV3(ctx); err != nil {
		return nil, err
	}
	creator, err := requireCanonicalProviderCreator(msg.Creator)
	if err != nil {
		return nil, err
	}
	candidate, err := k.PendingDealGenerationsV3.Get(ctx, msg.DealId)
	if err != nil {
		return nil, sdkerrors.ErrNotFound.Wrap("pending v3 generation not found")
	}
	deal, err := k.Deals.Get(ctx, msg.DealId)
	if err != nil || k.validateGenerationSnapshot(ctx, deal, candidate, true) != nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("pending v3 generation is stale")
	}
	if msg.Slot >= v3GenerationSlots || candidate.Providers[msg.Slot] != creator {
		return nil, sdkerrors.ErrUnauthorized.Wrap("creator is not the frozen provider for this slot")
	}
	providerAddr, _ := sdk.AccAddressFromBech32(creator)
	var provider [20]byte
	copy(provider[:], providerAddr)
	var setup, root, integrity [32]byte
	copy(setup[:], candidate.SetupDigest)
	copy(root[:], candidate.PolyfsRoot)
	copy(integrity[:], candidate.IntegrityRoot)
	digest, err := (retrievalchallenge.GenerationAcceptanceV3{
		ChainID: candidate.ChainId, SetupDigest: setup, DealID: candidate.DealId, Generation: candidate.Generation,
		PolyFSRoot: root, IntegrityRoot: integrity, MetadataMDUs: candidate.MetadataMdus, UserMDUs: candidate.UserMdus,
		Slot: msg.Slot, Provider: provider,
	}).Hash()
	if err != nil || len(msg.AcceptanceDigest) != 32 || !bytes.Equal(msg.AcceptanceDigest, digest[:]) {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("acceptance digest does not match the pending generation")
	}
	bit := uint32(1) << msg.Slot
	if candidate.AcceptedSlotsMask&bit != 0 {
		return &types.MsgAcceptDealGenerationV3Response{Accepted: true}, nil
	}
	candidate.AcceptedSlotsMask |= bit
	if err := k.PendingDealGenerationsV3.Set(ctx, msg.DealId, candidate); err != nil {
		return nil, err
	}
	return &types.MsgAcceptDealGenerationV3Response{Accepted: true}, nil
}

func (k msgServer) FinalizeDealGenerationV3(goCtx context.Context, msg *types.MsgFinalizeDealGenerationV3) (*types.MsgFinalizeDealGenerationV3Response, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)
	if err := k.requireRetrievalV3(ctx); err != nil {
		return nil, err
	}
	creator, err := requireCanonicalAddress(msg.Creator, "creator")
	if err != nil {
		return nil, err
	}
	deal, err := k.Deals.Get(ctx, msg.DealId)
	if err != nil {
		return nil, sdkerrors.ErrNotFound.Wrapf("deal %d not found", msg.DealId)
	}
	if creator != deal.Owner {
		return nil, sdkerrors.ErrUnauthorized.Wrap("only the deal owner may finalize a generation")
	}
	candidate, err := k.PendingDealGenerationsV3.Get(ctx, msg.DealId)
	if errors.Is(err, collections.ErrNotFound) {
		admitted, admittedErr := k.AdmittedDealGenerationsV3.Get(ctx, msg.DealId)
		if admittedErr == nil && admitted.Generation == msg.Generation && bytes.Equal(admitted.PolyfsRoot, msg.PolyfsRoot) {
			eligible, eligibilityErr := k.DealGenerationV3Eligible(ctx, deal)
			if eligibilityErr == nil && eligible {
				return &types.MsgFinalizeDealGenerationV3Response{Success: true}, nil
			}
		}
		return nil, sdkerrors.ErrInvalidRequest.Wrap("generation is not pending")
	}
	if err != nil {
		return nil, err
	}
	if candidate.Generation != msg.Generation || !bytes.Equal(candidate.PolyfsRoot, msg.PolyfsRoot) {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("finalize binding does not match pending generation")
	}
	if err := k.validateGenerationSnapshot(ctx, deal, candidate, true); err != nil {
		return nil, err
	}
	if candidate.AcceptedSlotsMask != v3GenerationAcceptedAll {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("all twelve frozen providers must accept before finalization")
	}
	cost, err := contentGrowthTermDeposit(k.GetParams(ctx), deal, candidate.Size_)
	if err != nil {
		return nil, err
	}
	if cost.IsPositive() {
		owner, _ := sdk.AccAddressFromBech32(creator)
		coins := sdk.NewCoins(sdk.NewCoin(sdk.DefaultBondDenom, cost))
		if err := k.BankKeeper.SendCoinsFromAccountToModule(ctx, owner, types.ModuleName, coins); err != nil {
			return nil, fmt.Errorf("failed to pay term deposit: %w", err)
		}
		deal.EscrowBalance = deal.EscrowBalance.Add(cost)
	}
	deal.ManifestRoot = append([]byte(nil), candidate.PolyfsRoot...)
	deal.Size_ = candidate.Size_
	deal.TotalMdus = candidate.TotalMdus
	deal.WitnessMdus = candidate.WitnessMdus
	deal.CurrentGen = candidate.Generation
	if err := k.setDealWithAssignmentCollateralLocks(ctx, msg.DealId, deal); err != nil {
		return nil, fmt.Errorf("failed to finalize deal generation: %w", err)
	}
	if err := k.AdmittedDealGenerationsV3.Set(ctx, msg.DealId, candidate); err != nil {
		return nil, err
	}
	if err := k.PendingDealGenerationsV3.Remove(ctx, msg.DealId); err != nil {
		return nil, err
	}
	return &types.MsgFinalizeDealGenerationV3Response{Success: true}, nil
}

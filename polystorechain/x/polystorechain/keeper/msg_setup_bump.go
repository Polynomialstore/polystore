package keeper

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"strings"

	"cosmossdk.io/collections"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"

	"polystorechain/x/polystorechain/types"
)

func isSetupPhaseDeal(deal types.Deal) bool {
	return deal.RedundancyMode == 2 &&
		deal.CurrentGen == 0 &&
		deal.TotalMdus == 0 &&
		deal.Size_ == 0
}

func providerHasUsableEndpoints(provider types.Provider) bool {
	for _, endpoint := range provider.Endpoints {
		if strings.TrimSpace(endpoint) != "" {
			return true
		}
	}
	return false
}

func setupBumpSeed(dealID uint64, slot uint32, bumpNonce uint64) [32]byte {
	buf := make([]byte, 0, len("polystore/setup-bump/v1")+8+4+8)
	buf = append(buf, []byte("polystore/setup-bump/v1")...)
	buf = binary.BigEndian.AppendUint64(buf, dealID)
	var slotBytes [4]byte
	binary.BigEndian.PutUint32(slotBytes[:], slot)
	buf = append(buf, slotBytes[:]...)
	buf = binary.BigEndian.AppendUint64(buf, bumpNonce)
	return sha256.Sum256(buf)
}

func setupBumpRank(seed [32]byte, provider string) [32]byte {
	buf := make([]byte, 0, len(seed)+len(provider))
	buf = append(buf, seed[:]...)
	buf = append(buf, provider...)
	return sha256.Sum256(buf)
}

func (k Keeper) currentSetupBumpNonce(ctx sdk.Context, dealID uint64, slot uint32) (uint64, error) {
	nonce, err := k.SetupBumpNonce.Get(ctx, collections.Join(dealID, slot))
	if err == nil {
		return nonce, nil
	}
	if errors.Is(err, collections.ErrNotFound) {
		return 0, nil
	}
	return 0, err
}

func (k Keeper) setupTriedProvider(ctx sdk.Context, dealID uint64, slot uint32, provider string) (bool, error) {
	tried, err := k.SetupTriedProvider.Get(ctx, collections.Join(collections.Join(dealID, slot), provider))
	if err == nil {
		return tried, nil
	}
	if errors.Is(err, collections.ErrNotFound) {
		return false, nil
	}
	return false, err
}

func (k Keeper) selectSetupBumpProvider(ctx sdk.Context, deal types.Deal, slot uint32) (string, uint64, error) {
	if deal.RedundancyMode != 2 || deal.Mode2Profile == nil || len(deal.Mode2Slots) == 0 {
		return "", 0, fmt.Errorf("mode2 slot map is not initialized")
	}
	if int(slot) < 0 || int(slot) >= len(deal.Mode2Slots) {
		return "", 0, fmt.Errorf("invalid slot %d", slot)
	}

	currentSlot := deal.Mode2Slots[int(slot)]
	if currentSlot == nil {
		return "", 0, fmt.Errorf("mode2 slot %d is nil", slot)
	}
	currentProvider := strings.TrimSpace(currentSlot.Provider)

	info, err := types.ParseServiceHint(deal.ServiceHint)
	if err != nil {
		return "", 0, err
	}
	baseHint := normalizeServiceHintBase(info.Base)
	nonce, err := k.currentSetupBumpNonce(ctx, deal.Id, slot)
	if err != nil {
		return "", 0, fmt.Errorf("failed to load setup bump nonce: %w", err)
	}
	seed := setupBumpSeed(deal.Id, slot, nonce)

	excluded := make(map[string]struct{}, len(deal.Providers)+len(deal.Mode2Slots))
	for _, provider := range deal.Providers {
		addr := strings.TrimSpace(provider)
		if addr != "" {
			excluded[addr] = struct{}{}
		}
	}
	for _, entry := range deal.Mode2Slots {
		if entry == nil {
			continue
		}
		if addr := strings.TrimSpace(entry.Provider); addr != "" {
			excluded[addr] = struct{}{}
		}
		if addr := strings.TrimSpace(entry.PendingProvider); addr != "" {
			excluded[addr] = struct{}{}
		}
	}

	bestProvider := ""
	var bestRank [32]byte
	found := false
	if err := k.Providers.Walk(ctx, nil, func(_ string, provider types.Provider) (stop bool, err error) {
		addr := strings.TrimSpace(provider.Address)
		if addr == "" {
			return false, nil
		}
		if strings.TrimSpace(provider.Status) != "Active" {
			return false, nil
		}
		if provider.Draining {
			return false, nil
		}
		if !providerMatchesBaseHint(provider, baseHint) {
			return false, nil
		}
		if !providerHasUsableEndpoints(provider) {
			return false, nil
		}
		if addr == currentProvider {
			return false, nil
		}
		if _, blocked := excluded[addr]; blocked {
			return false, nil
		}
		tried, err := k.setupTriedProvider(ctx, deal.Id, slot, addr)
		if err != nil {
			return false, err
		}
		if tried {
			return false, nil
		}

		rank := setupBumpRank(seed, addr)
		if !found || bytes.Compare(rank[:], bestRank[:]) < 0 || (bytes.Equal(rank[:], bestRank[:]) && addr < bestProvider) {
			bestProvider = addr
			bestRank = rank
			found = true
		}
		return false, nil
	}); err != nil {
		return "", 0, err
	}

	if !found {
		return "", 0, fmt.Errorf("no setup bump provider candidates available")
	}
	return bestProvider, nonce, nil
}

func (k msgServer) BumpDealSetupSlot(goCtx context.Context, msg *types.MsgBumpDealSetupSlot) (*types.MsgBumpDealSetupSlotResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	deal, err := k.Deals.Get(ctx, msg.DealId)
	if err != nil {
		return nil, sdkerrors.ErrNotFound.Wrapf("deal %d not found", msg.DealId)
	}
	if uint64(ctx.BlockHeight()) >= deal.EndBlock {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("deal %d expired at end_block=%d", msg.DealId, deal.EndBlock)
	}
	if deal.Owner != msg.Creator {
		return nil, sdkerrors.ErrUnauthorized.Wrap("only deal owner can bump setup slot")
	}
	if !isSetupPhaseDeal(deal) {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("setup slot bump is only allowed before the first content commit")
	}
	if deal.Mode2Profile == nil || len(deal.Mode2Slots) == 0 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("mode2 slot map is not initialized")
	}

	slotIdx := int(msg.Slot)
	if slotIdx < 0 || slotIdx >= len(deal.Mode2Slots) {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid slot %d", msg.Slot)
	}
	slot := deal.Mode2Slots[slotIdx]
	if slot == nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("mode2 slot %d is nil", msg.Slot)
	}
	if slot.Status != types.SlotStatus_SLOT_STATUS_ACTIVE {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("slot %d is not active", msg.Slot)
	}
	if strings.TrimSpace(slot.PendingProvider) != "" {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("slot %d has a pending provider", msg.Slot)
	}

	expectedProvider := strings.TrimSpace(msg.ExpectedProvider)
	if expectedProvider != "" && expectedProvider != strings.TrimSpace(slot.Provider) {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("expected_provider does not match current slot provider")
	}

	params := k.GetParams(ctx)
	if params.MaxSetupBumpsPerSlot == 0 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("setup slot bump is disabled")
	}
	currentNonce, err := k.currentSetupBumpNonce(ctx, deal.Id, msg.Slot)
	if err != nil {
		return nil, fmt.Errorf("failed to load setup bump nonce: %w", err)
	}
	if currentNonce >= params.MaxSetupBumpsPerSlot {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("slot %d exceeded max setup bumps (%d)", msg.Slot, params.MaxSetupBumpsPerSlot)
	}

	oldProvider := strings.TrimSpace(slot.Provider)
	newProvider, selectionNonce, err := k.selectSetupBumpProvider(ctx, deal, msg.Slot)
	if err != nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrap(err.Error())
	}

	if err := k.SetupTriedProvider.Set(ctx, collections.Join(collections.Join(deal.Id, msg.Slot), oldProvider), true); err != nil {
		return nil, fmt.Errorf("failed to record tried provider: %w", err)
	}
	if err := k.SetupBumpNonce.Set(ctx, collections.Join(deal.Id, msg.Slot), selectionNonce+1); err != nil {
		return nil, fmt.Errorf("failed to persist setup bump nonce: %w", err)
	}

	slot.Provider = newProvider
	slot.Status = types.SlotStatus_SLOT_STATUS_ACTIVE
	slot.PendingProvider = ""
	slot.StatusSinceHeight = ctx.BlockHeight()
	slot.RepairTargetGen = 0
	deal.Mode2Slots[slotIdx] = slot
	if slotIdx < len(deal.Providers) {
		deal.Providers[slotIdx] = newProvider
	}

	if err := k.Deals.Set(ctx, deal.Id, deal); err != nil {
		return nil, fmt.Errorf("failed to update deal: %w", err)
	}

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			types.TypeMsgBumpDealSetupSlot,
			sdk.NewAttribute(types.AttributeKeyDealID, fmt.Sprintf("%d", deal.Id)),
			sdk.NewAttribute("slot", fmt.Sprintf("%d", msg.Slot)),
			sdk.NewAttribute("old_provider", oldProvider),
			sdk.NewAttribute("new_provider", newProvider),
			sdk.NewAttribute("bump_nonce", fmt.Sprintf("%d", selectionNonce+1)),
		),
	)

	return &types.MsgBumpDealSetupSlotResponse{
		Success:     true,
		NewProvider: newProvider,
	}, nil
}

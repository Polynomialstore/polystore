package keeper

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"cosmossdk.io/collections"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"

	"nilchain/x/nilchain/types"
)

func (k msgServer) StartSlotRepair(goCtx context.Context, msg *types.MsgStartSlotRepair) (*types.MsgStartSlotRepairResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	deal, err := k.Deals.Get(ctx, msg.DealId)
	if err != nil {
		return nil, sdkerrors.ErrNotFound.Wrapf("deal %d not found", msg.DealId)
	}
	if deal.Owner != msg.Creator {
		return nil, sdkerrors.ErrUnauthorized.Wrap("only deal owner can start slot repair")
	}
	if deal.RedundancyMode != 2 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("slot repair is only supported for Mode 2 deals")
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
	if slot.Status == types.SlotStatus_SLOT_STATUS_REPAIRING {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("slot %d is already repairing", msg.Slot)
	}

	pending := strings.TrimSpace(msg.PendingProvider)
	if pending == "" {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("pending_provider is required")
	}
	if strings.TrimSpace(slot.Provider) == pending {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("pending_provider must differ from current provider")
	}
	if _, err := k.Providers.Get(ctx, pending); err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return nil, sdkerrors.ErrNotFound.Wrapf("pending provider %q not registered", pending)
		}
		return nil, fmt.Errorf("failed to load pending provider: %w", err)
	}

	slot.Status = types.SlotStatus_SLOT_STATUS_REPAIRING
	slot.PendingProvider = pending
	slot.StatusSinceHeight = ctx.BlockHeight()
	slot.RepairTargetGen = deal.CurrentGen
	deal.Mode2Slots[slotIdx] = slot

	if err := k.Deals.Set(ctx, deal.Id, deal); err != nil {
		return nil, fmt.Errorf("failed to update deal: %w", err)
	}

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			"start_slot_repair",
			sdk.NewAttribute(types.AttributeKeyDealID, fmt.Sprintf("%d", deal.Id)),
			sdk.NewAttribute("slot", fmt.Sprintf("%d", msg.Slot)),
			sdk.NewAttribute("provider", slot.Provider),
			sdk.NewAttribute("pending_provider", slot.PendingProvider),
			sdk.NewAttribute("repair_target_gen", fmt.Sprintf("%d", slot.RepairTargetGen)),
		),
	)

	return &types.MsgStartSlotRepairResponse{Success: true}, nil
}

func (k msgServer) CompleteSlotRepair(goCtx context.Context, msg *types.MsgCompleteSlotRepair) (*types.MsgCompleteSlotRepairResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	deal, err := k.Deals.Get(ctx, msg.DealId)
	if err != nil {
		return nil, sdkerrors.ErrNotFound.Wrapf("deal %d not found", msg.DealId)
	}
	if deal.Owner != msg.Creator {
		return nil, sdkerrors.ErrUnauthorized.Wrap("only deal owner can complete slot repair")
	}
	if deal.RedundancyMode != 2 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("slot repair is only supported for Mode 2 deals")
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
	if slot.Status != types.SlotStatus_SLOT_STATUS_REPAIRING || strings.TrimSpace(slot.PendingProvider) == "" {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("slot %d has no pending repair", msg.Slot)
	}

	oldProvider := slot.Provider
	slot.Provider = slot.PendingProvider
	slot.PendingProvider = ""
	slot.Status = types.SlotStatus_SLOT_STATUS_ACTIVE
	slot.StatusSinceHeight = ctx.BlockHeight()
	slot.RepairTargetGen = 0
	deal.Mode2Slots[slotIdx] = slot

	// Keep legacy providers[] aligned with the canonical slots map when possible.
	if slotIdx >= 0 && slotIdx < len(deal.Providers) {
		deal.Providers[slotIdx] = slot.Provider
	}

	if err := k.Deals.Set(ctx, deal.Id, deal); err != nil {
		return nil, fmt.Errorf("failed to update deal: %w", err)
	}

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			"complete_slot_repair",
			sdk.NewAttribute(types.AttributeKeyDealID, fmt.Sprintf("%d", deal.Id)),
			sdk.NewAttribute("slot", fmt.Sprintf("%d", msg.Slot)),
			sdk.NewAttribute("old_provider", oldProvider),
			sdk.NewAttribute("new_provider", slot.Provider),
		),
	)

	return &types.MsgCompleteSlotRepairResponse{Success: true}, nil
}

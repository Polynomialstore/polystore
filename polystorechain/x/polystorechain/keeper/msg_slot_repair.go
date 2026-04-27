package keeper

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"cosmossdk.io/collections"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"

	"polystorechain/x/polystorechain/types"
)

func (k msgServer) StartSlotRepair(goCtx context.Context, msg *types.MsgStartSlotRepair) (*types.MsgStartSlotRepairResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	deal, err := k.Deals.Get(ctx, msg.DealId)
	if err != nil {
		return nil, sdkerrors.ErrNotFound.Wrapf("deal %d not found", msg.DealId)
	}
	if uint64(ctx.BlockHeight()) >= deal.EndBlock {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("deal %d expired at end_block=%d", msg.DealId, deal.EndBlock)
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
	provider, err := k.Providers.Get(ctx, pending)
	if err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return nil, sdkerrors.ErrNotFound.Wrapf("pending provider %q not registered", pending)
		}
		return nil, fmt.Errorf("failed to load pending provider: %w", err)
	}
	reason, err := k.mode2ReplacementProviderIneligibility(ctx, provider, deal.ServiceHint)
	if err != nil {
		return nil, fmt.Errorf("failed to check pending provider health: %w", err)
	}
	if reason != "" {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("pending_provider is not eligible for slot repair: %s", reason)
	}

	slot.Status = types.SlotStatus_SLOT_STATUS_REPAIRING
	slot.PendingProvider = pending
	slot.StatusSinceHeight = ctx.BlockHeight()
	slot.RepairTargetGen = deal.CurrentGen
	deal.Mode2Slots[slotIdx] = slot

	if err := k.clearMode2RepairReadiness(ctx, deal.Id, msg.Slot); err != nil {
		return nil, fmt.Errorf("failed to clear stale repair readiness: %w", err)
	}
	if err := k.Deals.Set(ctx, deal.Id, deal); err != nil {
		return nil, fmt.Errorf("failed to update deal: %w", err)
	}

	params := k.GetParams(ctx)
	epochID := epochIDAtHeight(ctx.BlockHeight(), params.EpochLenBlocks)
	eid := deriveEvidenceID("manual_slot_repair_started", deal.Id, epochID, []byte(fmt.Sprintf("%d:%s", msg.Slot, pending)))
	if err := k.recordEvidenceSummary(ctx, deal.Id, slot.Provider, "manual_slot_repair_started", eid[:], msg.Creator, false); err != nil {
		ctx.Logger().Error("failed to record evidence summary", "error", err)
	}
	caseID, err := k.recordEvidenceCase(ctx, evidenceCaseInput{
		DealID:             deal.Id,
		Slot:               msg.Slot,
		Provider:           slot.Provider,
		Reporter:           msg.Creator,
		Reason:             "manual_slot_repair_started",
		Class:              types.EvidenceClass_EVIDENCE_CLASS_OPERATIONAL,
		Severity:           types.EvidenceSeverity_EVIDENCE_SEVERITY_REPAIR,
		Status:             types.EvidenceCaseStatus_EVIDENCE_CASE_STATUS_OBSERVED,
		EvidenceID:         eid[:],
		EpochID:            epochID,
		Summary:            fmt.Sprintf("manual repair started with pending provider %s", pending),
		ConsequenceCeiling: "operator-directed repair; no slash by itself",
	})
	if err != nil {
		ctx.Logger().Error("failed to record structured evidence", "error", err)
	} else if err := k.setSlotHealthState(ctx, slotHealthUpdate{
		DealID:          deal.Id,
		Slot:            msg.Slot,
		Provider:        slot.Provider,
		Status:          types.SlotHealthStatus_SLOT_HEALTH_STATUS_REPAIRING,
		Reason:          "manual_slot_repair_started",
		Class:           types.EvidenceClass_EVIDENCE_CLASS_OPERATIONAL,
		Severity:        types.EvidenceSeverity_EVIDENCE_SEVERITY_REPAIR,
		EpochID:         epochID,
		EvidenceCaseID:  caseID,
		PendingProvider: pending,
		RepairTargetGen: slot.RepairTargetGen,
	}); err != nil {
		ctx.Logger().Error("failed to update slot health", "error", err)
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
	if uint64(ctx.BlockHeight()) >= deal.EndBlock {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("deal %d expired at end_block=%d", msg.DealId, deal.EndBlock)
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

	creator := strings.TrimSpace(msg.Creator)
	if creator == "" {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("creator is required")
	}
	if creator != deal.Owner && creator != strings.TrimSpace(slot.PendingProvider) {
		return nil, sdkerrors.ErrUnauthorized.Wrap("only deal owner or pending provider can complete slot repair")
	}

	ready, err := k.mode2RepairReady(ctx, deal.Id, msg.Slot, slot.RepairTargetGen)
	if err != nil {
		return nil, fmt.Errorf("failed to check repair readiness: %w", err)
	}
	if !ready {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("slot repair is not ready; pending provider must submit repair readiness proof before promotion")
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

	// Rotate the deterministic challenge set after replacement so a failing provider
	// cannot keep replaying historical proofs.
	deal.CurrentGen++

	if err := k.clearMode2RepairReadiness(ctx, deal.Id, msg.Slot); err != nil {
		return nil, fmt.Errorf("failed to clear consumed repair readiness: %w", err)
	}
	if err := k.Deals.Set(ctx, deal.Id, deal); err != nil {
		return nil, fmt.Errorf("failed to update deal: %w", err)
	}

	params := k.GetParams(ctx)
	epochID := epochIDAtHeight(ctx.BlockHeight(), params.EpochLenBlocks)
	eid := deriveEvidenceID("slot_repair_completed", deal.Id, epochID, []byte(fmt.Sprintf("%d:%s", msg.Slot, slot.Provider)))
	if err := k.recordEvidenceSummary(ctx, deal.Id, oldProvider, "slot_repair_completed", eid[:], msg.Creator, true); err != nil {
		ctx.Logger().Error("failed to record evidence summary", "error", err)
	}
	caseID, err := k.recordEvidenceCase(ctx, evidenceCaseInput{
		DealID:             deal.Id,
		Slot:               msg.Slot,
		Provider:           oldProvider,
		Reporter:           msg.Creator,
		Reason:             "slot_repair_completed",
		Class:              types.EvidenceClass_EVIDENCE_CLASS_POSITIVE_READINESS,
		Severity:           types.EvidenceSeverity_EVIDENCE_SEVERITY_REPAIR,
		Status:             types.EvidenceCaseStatus_EVIDENCE_CASE_STATUS_RESOLVED,
		EvidenceID:         eid[:],
		EpochID:            epochID,
		Summary:            fmt.Sprintf("manual repair completed; new provider %s", slot.Provider),
		ConsequenceCeiling: "repair completed; no penalty by itself",
	})
	if err != nil {
		ctx.Logger().Error("failed to record structured evidence", "error", err)
	} else if err := k.setSlotHealthState(ctx, slotHealthUpdate{
		DealID:         deal.Id,
		Slot:           msg.Slot,
		Provider:       slot.Provider,
		Status:         types.SlotHealthStatus_SLOT_HEALTH_STATUS_ACTIVE_PROMOTED,
		Reason:         "slot_repair_completed",
		Class:          types.EvidenceClass_EVIDENCE_CLASS_POSITIVE_READINESS,
		Severity:       types.EvidenceSeverity_EVIDENCE_SEVERITY_REPAIR,
		EpochID:        epochID,
		EvidenceCaseID: caseID,
		ResetCounters:  true,
	}); err != nil {
		ctx.Logger().Error("failed to update slot health", "error", err)
	}

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			"complete_slot_repair",
			sdk.NewAttribute(types.AttributeKeyDealID, fmt.Sprintf("%d", deal.Id)),
			sdk.NewAttribute("slot", fmt.Sprintf("%d", msg.Slot)),
			sdk.NewAttribute("old_provider", oldProvider),
			sdk.NewAttribute("new_provider", slot.Provider),
			sdk.NewAttribute("current_gen", fmt.Sprintf("%d", deal.CurrentGen)),
		),
	)

	return &types.MsgCompleteSlotRepairResponse{Success: true}, nil
}

package keeper

import (
	"context"
	"errors"
	"strings"

	"cosmossdk.io/collections"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"polystorechain/x/polystorechain/types"
)

func (k queryServer) GetSlotHealth(goCtx context.Context, req *types.QueryGetSlotHealthRequest) (*types.QueryGetSlotHealthResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}

	ctx := sdk.UnwrapSDKContext(goCtx)
	health, err := k.k.SlotHealthStates.Get(ctx, collections.Join(req.DealId, req.Slot))
	if err == nil {
		return &types.QueryGetSlotHealthResponse{Health: health}, nil
	}
	if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return nil, status.Error(codes.Internal, err.Error())
	}

	deal, err := k.k.Deals.Get(ctx, req.DealId)
	if err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return nil, status.Error(codes.NotFound, "deal not found")
		}
		return nil, status.Error(codes.Internal, err.Error())
	}
	if int(req.Slot) >= len(deal.Mode2Slots) || deal.Mode2Slots[req.Slot] == nil {
		return nil, status.Error(codes.NotFound, "slot not found")
	}

	return &types.QueryGetSlotHealthResponse{Health: slotHealthFromDealSlot(deal, req.Slot)}, nil
}

func (k queryServer) ListSlotHealthByDeal(goCtx context.Context, req *types.QueryListSlotHealthByDealRequest) (*types.QueryListSlotHealthByDealResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}

	ctx := sdk.UnwrapSDKContext(goCtx)
	deal, err := k.k.Deals.Get(ctx, req.DealId)
	if err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return nil, status.Error(codes.NotFound, "deal not found")
		}
		return nil, status.Error(codes.Internal, err.Error())
	}

	healthBySlot := make(map[uint32]types.SlotHealthState)
	if err := k.k.SlotHealthStates.Walk(ctx, nil, func(key collections.Pair[uint64, uint32], health types.SlotHealthState) (bool, error) {
		if key.K1() == req.DealId {
			healthBySlot[key.K2()] = health
		}
		return false, nil
	}); err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}

	health := make([]types.SlotHealthState, 0, len(deal.Mode2Slots))
	for idx, slot := range deal.Mode2Slots {
		if slot == nil {
			continue
		}
		slotID := uint32(idx)
		if explicit, ok := healthBySlot[slotID]; ok {
			health = append(health, explicit)
			continue
		}
		health = append(health, slotHealthFromDealSlot(deal, slotID))
	}

	return &types.QueryListSlotHealthByDealResponse{Health: health}, nil
}

func (k queryServer) ListEvidenceCases(goCtx context.Context, req *types.QueryListEvidenceCasesRequest) (*types.QueryListEvidenceCasesResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}

	ctx := sdk.UnwrapSDKContext(goCtx)
	evidence := make([]types.EvidenceCase, 0)
	if err := k.k.EvidenceCases.Walk(ctx, nil, func(_ uint64, item types.EvidenceCase) (bool, error) {
		if req.DealId != 0 && item.DealId != req.DealId {
			return false, nil
		}
		evidence = append(evidence, item)
		return false, nil
	}); err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}

	return &types.QueryListEvidenceCasesResponse{Evidence: evidence}, nil
}

func slotHealthFromDealSlot(deal types.Deal, slot uint32) types.SlotHealthState {
	entry := deal.Mode2Slots[slot]
	status := types.SlotHealthStatus_SLOT_HEALTH_STATUS_HEALTHY
	reason := "slot_active"
	if entry.Status == types.SlotStatus_SLOT_STATUS_REPAIRING {
		status = types.SlotHealthStatus_SLOT_HEALTH_STATUS_REPAIRING
		reason = "slot_repairing"
	}

	return types.SlotHealthState{
		DealId:          deal.Id,
		Slot:            slot,
		Provider:        strings.TrimSpace(entry.Provider),
		Status:          status,
		Reason:          reason,
		EvidenceClass:   types.EvidenceClass_EVIDENCE_CLASS_OPERATIONAL,
		Severity:        types.EvidenceSeverity_EVIDENCE_SEVERITY_INFO,
		UpdatedHeight:   entry.StatusSinceHeight,
		PendingProvider: strings.TrimSpace(entry.PendingProvider),
		RepairTargetGen: entry.RepairTargetGen,
	}
}

package keeper

import (
	"context"
	"errors"
	"strings"

	"cosmossdk.io/collections"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkquery "github.com/cosmos/cosmos-sdk/types/query"
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

	health := make([]types.SlotHealthState, 0, len(deal.Mode2Slots))
	for idx, slot := range deal.Mode2Slots {
		if slot == nil {
			continue
		}
		slotID := uint32(idx)
		explicit, err := k.k.SlotHealthStates.Get(ctx, collections.Join(req.DealId, slotID))
		if err == nil {
			health = append(health, explicit)
			continue
		}
		if err != nil && !errors.Is(err, collections.ErrNotFound) {
			return nil, status.Error(codes.Internal, err.Error())
		}
		health = append(health, slotHealthFromDealSlot(deal, slotID))
	}

	pagedHealth, pageRes, err := paginateSlotHealthStates(health, req.Pagination)
	if err != nil {
		return nil, err
	}

	return &types.QueryListSlotHealthByDealResponse{Health: pagedHealth, Pagination: pageRes}, nil
}

func (k queryServer) GetRepairAttempt(goCtx context.Context, req *types.QueryGetRepairAttemptRequest) (*types.QueryGetRepairAttemptResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}

	ctx := sdk.UnwrapSDKContext(goCtx)
	attempt, err := k.k.RepairAttemptStates.Get(ctx, repairAttemptKey(req.DealId, req.Slot))
	if err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return nil, status.Error(codes.NotFound, "repair attempt state not found")
		}
		return nil, status.Error(codes.Internal, err.Error())
	}

	return &types.QueryGetRepairAttemptResponse{RepairAttempt: attempt}, nil
}

func (k queryServer) ListRepairAttemptsByDeal(goCtx context.Context, req *types.QueryListRepairAttemptsByDealRequest) (*types.QueryListRepairAttemptsByDealResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}

	ctx := sdk.UnwrapSDKContext(goCtx)
	if _, err := k.k.Deals.Get(ctx, req.DealId); err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return nil, status.Error(codes.NotFound, "deal not found")
		}
		return nil, status.Error(codes.Internal, err.Error())
	}

	attempts, pageRes, err := sdkquery.CollectionPaginate(
		goCtx,
		k.k.RepairAttemptStates,
		req.Pagination,
		func(_ collections.Pair[uint64, uint32], item types.RepairAttemptState) (types.RepairAttemptState, error) {
			return item, nil
		},
		sdkquery.WithCollectionPaginationPairPrefix[uint64, uint32](req.DealId),
	)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}

	return &types.QueryListRepairAttemptsByDealResponse{RepairAttempts: attempts, Pagination: pageRes}, nil
}

func (k queryServer) ListEvidenceCases(goCtx context.Context, req *types.QueryListEvidenceCasesRequest) (*types.QueryListEvidenceCasesResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}

	ctx := sdk.UnwrapSDKContext(goCtx)
	if req.DealId != 0 {
		evidence, pageRes, err := sdkquery.CollectionPaginate(
			goCtx,
			k.k.EvidenceCasesByDeal,
			req.Pagination,
			func(key collections.Pair[uint64, uint64], _ bool) (types.EvidenceCase, error) {
				return k.k.EvidenceCases.Get(ctx, key.K2())
			},
			sdkquery.WithCollectionPaginationPairPrefix[uint64, uint64](req.DealId),
		)
		if err != nil {
			return nil, status.Error(codes.Internal, err.Error())
		}

		return &types.QueryListEvidenceCasesResponse{Evidence: evidence, Pagination: pageRes}, nil
	}

	evidence, pageRes, err := sdkquery.CollectionPaginate(
		goCtx,
		k.k.EvidenceCases,
		req.Pagination,
		func(_ uint64, item types.EvidenceCase) (types.EvidenceCase, error) {
			return item, nil
		},
	)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}

	return &types.QueryListEvidenceCasesResponse{Evidence: evidence, Pagination: pageRes}, nil
}

func paginateSlotHealthStates(health []types.SlotHealthState, pageReq *sdkquery.PageRequest) ([]types.SlotHealthState, *sdkquery.PageResponse, error) {
	if pageReq != nil && len(pageReq.Key) != 0 {
		return nil, nil, status.Error(codes.InvalidArgument, "slot health list supports offset pagination only")
	}

	req := sdkquery.PageRequest{}
	if pageReq != nil {
		req = *pageReq
	}
	if req.Limit == 0 {
		req.Limit = sdkquery.DefaultLimit
		req.CountTotal = true
	}

	if req.Reverse {
		reversed := make([]types.SlotHealthState, len(health))
		for i := range health {
			reversed[len(health)-1-i] = health[i]
		}
		health = reversed
	}

	total := uint64(len(health))
	start := req.Offset
	if start > total {
		start = total
	}
	end := start + req.Limit
	if end > total {
		end = total
	}

	pageRes := &sdkquery.PageResponse{}
	if req.CountTotal {
		pageRes.Total = total
	}

	return append([]types.SlotHealthState(nil), health[int(start):int(end)]...), pageRes, nil
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

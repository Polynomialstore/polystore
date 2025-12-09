package keeper

import (
	"context"
    "errors"

	"cosmossdk.io/collections"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"nilchain/x/nilchain/types"
)

var _ types.QueryServer = queryServer{}

// NewQueryServerImpl returns an implementation of the QueryServer interface
// for the provided Keeper.
func NewQueryServerImpl(k Keeper) types.QueryServer {
	return queryServer{k}
}

type queryServer struct {
	k Keeper
}

// GetDealHeat implements types.QueryServer.
func (q queryServer) GetDealHeat(goCtx context.Context, req *types.QueryGetDealHeatRequest) (*types.QueryGetDealHeatResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}

	ctx := sdk.UnwrapSDKContext(goCtx)

	heat, err := q.k.DealHeatStates.Get(ctx, req.DealId)
	if err != nil {
		if errors.Is(err, collections.ErrNotFound) {
             // Return empty heat state instead of error for UX
             return &types.QueryGetDealHeatResponse{
                 Heat: types.DealHeatState{
                     BytesServedTotal: 0,
                     FailedChallengesTotal: 0,
                     LastUpdateHeight: 0,
                 },
             }, nil
		}
		return nil, status.Error(codes.Internal, err.Error())
	}

	return &types.QueryGetDealHeatResponse{Heat: heat}, nil
}
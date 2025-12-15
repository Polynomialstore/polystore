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

func (k queryServer) GetDeal(goCtx context.Context, req *types.QueryGetDealRequest) (*types.QueryGetDealResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}

	ctx := sdk.UnwrapSDKContext(goCtx)
	deal, err := k.k.Deals.Get(ctx, req.Id)
	if err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return nil, status.Error(codes.NotFound, "deal not found")
		}
		return nil, status.Error(codes.Internal, "internal error")
	}

	return &types.QueryGetDealResponse{Deal: &deal}, nil
}

func (k queryServer) ListDeals(goCtx context.Context, req *types.QueryListDealsRequest) (*types.QueryListDealsResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}

	ctx := sdk.UnwrapSDKContext(goCtx)

	var deals []*types.Deal
	err := k.k.Deals.Walk(ctx, nil, func(key uint64, deal types.Deal) (bool, error) {
		d := deal
		deals = append(deals, &d)
		return false, nil
	})
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}

	return &types.QueryListDealsResponse{Deals: deals}, nil
}

func (k queryServer) GetProvider(goCtx context.Context, req *types.QueryGetProviderRequest) (*types.QueryGetProviderResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}

	ctx := sdk.UnwrapSDKContext(goCtx)
	val, err := k.k.Providers.Get(ctx, req.Address)
	if err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return nil, status.Error(codes.NotFound, "provider not found")
		}
		return nil, status.Error(codes.Internal, "internal error")
	}

	return &types.QueryGetProviderResponse{Provider: &val}, nil
}

func (k queryServer) ListProviders(goCtx context.Context, req *types.QueryListProvidersRequest) (*types.QueryListProvidersResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}

	ctx := sdk.UnwrapSDKContext(goCtx)

	var providers []*types.Provider
	err := k.k.Providers.Walk(ctx, nil, func(key string, val types.Provider) (bool, error) {
		p := val
		providers = append(providers, &p)
		return false, nil
	})
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}

	return &types.QueryListProvidersResponse{Providers: providers}, nil
}

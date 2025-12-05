package keeper

import (
	"context"

	"cosmossdk.io/collections"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"nilchain/x/nilchain/types"
)

func (k queryServer) GetDeal(ctx context.Context, req *types.QueryGetDealRequest) (*types.QueryGetDealResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}

	deal, err := k.k.Deals.Get(ctx, req.Id)
	if err != nil {
		if err == collections.ErrNotFound {
			return nil, status.Error(codes.NotFound, "deal not found")
		}
		return nil, status.Error(codes.Internal, "internal error")
	}

	return &types.QueryGetDealResponse{Deal: &deal}, nil
}

func (k queryServer) ListDeals(ctx context.Context, req *types.QueryListDealsRequest) (*types.QueryListDealsResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}

	var deals []*types.Deal
    err := k.k.Deals.Walk(ctx, nil, func(key uint64, deal types.Deal) (bool, error) {
        // Make a copy or use pointer carefully if using loop variable in Walk (collections Walk passes value)
        d := deal
        deals = append(deals, &d)
        return false, nil
    })
    if err != nil {
        return nil, status.Error(codes.Internal, err.Error())
    }

	return &types.QueryListDealsResponse{Deals: deals}, nil
}

func (k queryServer) GetProvider(ctx context.Context, req *types.QueryGetProviderRequest) (*types.QueryGetProviderResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}

	val, err := k.k.Providers.Get(ctx, req.Address)
	if err != nil {
		if err == collections.ErrNotFound {
			return nil, status.Error(codes.NotFound, "provider not found")
		}
		return nil, status.Error(codes.Internal, "internal error")
	}

	return &types.QueryGetProviderResponse{Provider: &val}, nil
}

func (k queryServer) ListProviders(ctx context.Context, req *types.QueryListProvidersRequest) (*types.QueryListProvidersResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}

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
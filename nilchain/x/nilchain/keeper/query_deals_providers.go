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
	address, err := canonicalProviderAddress(req.Address)
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	val, err := k.k.Providers.Get(ctx, address)
	if err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return nil, status.Error(codes.NotFound, "provider not found")
		}
		return nil, status.Error(codes.Internal, "internal error")
	}

	return &types.QueryGetProviderResponse{Provider: &val}, nil
}

func (k queryServer) GetProviderPairing(goCtx context.Context, req *types.QueryGetProviderPairingRequest) (*types.QueryGetProviderPairingResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}

	provider, err := canonicalAddress(req.Provider, "provider")
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}

	ctx := sdk.UnwrapSDKContext(goCtx)
	pairing, err := k.k.ProviderPairings.Get(ctx, provider)
	if err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return nil, status.Error(codes.NotFound, "provider pairing not found")
		}
		return nil, status.Error(codes.Internal, "internal error")
	}

	return &types.QueryGetProviderPairingResponse{Pairing: pairing}, nil
}

func (k queryServer) ListProvidersByOperator(goCtx context.Context, req *types.QueryListProvidersByOperatorRequest) (*types.QueryListProvidersByOperatorResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}

	operator, err := canonicalAddress(req.Operator, "operator")
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}

	ctx := sdk.UnwrapSDKContext(goCtx)
	pairings := make([]types.ProviderPairing, 0)
	err = k.k.ProviderPairingsByOperator.Walk(ctx, nil, func(key collections.Pair[string, string], _ bool) (bool, error) {
		if key.K1() != operator {
			return false, nil
		}
		pairing, err := k.k.ProviderPairings.Get(ctx, key.K2())
		if err != nil {
			if errors.Is(err, collections.ErrNotFound) {
				return false, nil
			}
			return false, err
		}
		pairings = append(pairings, pairing)
		return false, nil
	})
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}

	return &types.QueryListProvidersByOperatorResponse{Pairings: pairings}, nil
}

func (k queryServer) GetPendingProviderPairing(goCtx context.Context, req *types.QueryGetPendingProviderPairingRequest) (*types.QueryGetPendingProviderPairingResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}

	pairingID, err := validatePairingID(req.PairingId)
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}

	ctx := sdk.UnwrapSDKContext(goCtx)
	pending, err := k.k.PendingProviderPairings.Get(ctx, pairingID)
	if err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return nil, status.Error(codes.NotFound, "pending provider pairing not found")
		}
		return nil, status.Error(codes.Internal, "internal error")
	}

	return &types.QueryGetPendingProviderPairingResponse{Pairing: pending}, nil
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

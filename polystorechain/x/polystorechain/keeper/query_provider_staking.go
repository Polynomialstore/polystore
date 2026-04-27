package keeper

import (
	"context"
	"errors"

	"cosmossdk.io/collections"
	"cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkquery "github.com/cosmos/cosmos-sdk/types/query"
	stakingtypes "github.com/cosmos/cosmos-sdk/x/staking/types"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"polystorechain/x/polystorechain/types"
)

func (k queryServer) GetProviderStaking(goCtx context.Context, req *types.QueryGetProviderStakingRequest) (*types.QueryGetProviderStakingResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}

	ctx := sdk.UnwrapSDKContext(goCtx)
	provider, err := canonicalAddress(req.Provider, "provider")
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	binding, err := k.k.ProviderStakingBindings.Get(ctx, provider)
	if err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return nil, status.Error(codes.NotFound, "provider staking binding not found")
		}
		return nil, status.Error(codes.Internal, "internal error")
	}
	summary, err := k.k.deriveProviderStakingSummary(ctx, binding)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}

	return &types.QueryGetProviderStakingResponse{Staking: summary}, nil
}

func (k queryServer) ListProviderStaking(goCtx context.Context, req *types.QueryListProviderStakingRequest) (*types.QueryListProviderStakingResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}

	ctx := sdk.UnwrapSDKContext(goCtx)
	staking, pageRes, err := sdkquery.CollectionPaginate(
		goCtx,
		k.k.ProviderStakingBindings,
		req.Pagination,
		func(_ string, binding types.ProviderStakingBinding) (types.ProviderStakingSummary, error) {
			return k.k.deriveProviderStakingSummary(ctx, binding)
		},
	)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}

	return &types.QueryListProviderStakingResponse{Staking: staking, Pagination: pageRes}, nil
}

func (k Keeper) deriveProviderStakingSummary(ctx sdk.Context, binding types.ProviderStakingBinding) (types.ProviderStakingSummary, error) {
	if binding.SlashSemantics == "" {
		binding.SlashSemantics = observedOnlyProviderStakeSlashSemantics
	}
	binding.CountsTowardAssignmentCollateral = false

	denom := sdk.DefaultBondDenom
	summary := types.ProviderStakingSummary{
		Binding:                          binding,
		ObservedStake:                    sdk.NewCoin(denom, math.ZeroInt()),
		CountsTowardAssignmentCollateral: false,
		Status:                           "staking_keeper_unavailable",
		Reason:                           "staking keeper not wired",
	}
	if k.StakingKeeper == nil {
		return summary, nil
	}
	summary.StakingKeeperAvailable = true

	bondDenom, err := k.StakingKeeper.BondDenom(ctx)
	if err != nil {
		return types.ProviderStakingSummary{}, err
	}
	if bondDenom != "" {
		denom = bondDenom
	}
	summary.ObservedStake = sdk.NewCoin(denom, math.ZeroInt())

	delegator, err := sdk.AccAddressFromBech32(binding.Delegator)
	if err != nil {
		summary.Status = "invalid_binding"
		summary.Reason = "invalid delegator address"
		return summary, nil
	}
	validatorAddr, err := sdk.ValAddressFromBech32(binding.Validator)
	if err != nil {
		summary.Status = "invalid_binding"
		summary.Reason = "invalid validator address"
		return summary, nil
	}

	validator, err := k.StakingKeeper.GetValidator(ctx, validatorAddr)
	if err != nil {
		if errors.Is(err, stakingtypes.ErrNoValidatorFound) {
			summary.Status = "validator_not_found"
			summary.Reason = "validator not found"
			return summary, nil
		}
		return types.ProviderStakingSummary{}, err
	}
	summary.ValidatorFound = true
	if validator.DelegatorShares.IsZero() {
		summary.Status = "validator_has_no_delegator_shares"
		summary.Reason = "validator delegation exchange rate unavailable"
		return summary, nil
	}

	delegation, err := k.StakingKeeper.GetDelegation(ctx, delegator, validatorAddr)
	if err != nil {
		if errors.Is(err, stakingtypes.ErrNoDelegation) {
			summary.Status = "delegation_not_found"
			summary.Reason = "delegation not found"
			return summary, nil
		}
		return types.ProviderStakingSummary{}, err
	}

	observedStake := validator.TokensFromSharesTruncated(delegation.Shares).TruncateInt()
	summary.DelegationFound = true
	summary.ObservedStake = sdk.NewCoin(denom, observedStake)
	summary.Status = "observed_not_slashable"
	summary.Reason = "delegation observed but delegated stake does not count as provider assignment collateral"
	return summary, nil
}

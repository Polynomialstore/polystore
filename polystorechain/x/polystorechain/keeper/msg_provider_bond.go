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

func (k msgServer) providerBondActor(ctx sdk.Context, creatorRaw string, providerRaw string, action string) (string, string, types.Provider, error) {
	creator, err := requireCanonicalAddress(creatorRaw, "creator")
	if err != nil {
		return "", "", types.Provider{}, err
	}
	providerAddr, err := canonicalAddress(providerRaw, "provider")
	if err != nil {
		return "", "", types.Provider{}, err
	}

	provider, err := k.Providers.Get(ctx, providerAddr)
	if err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return "", "", types.Provider{}, sdkerrors.ErrNotFound.Wrap("provider not found")
		}
		return "", "", types.Provider{}, err
	}

	if creator != providerAddr {
		pairing, err := k.ProviderPairings.Get(ctx, providerAddr)
		if err != nil {
			if errors.Is(err, collections.ErrNotFound) {
				return "", "", types.Provider{}, sdkerrors.ErrUnauthorized.Wrapf("creator is not authorized to %s provider bond", action)
			}
			return "", "", types.Provider{}, err
		}
		if pairing.Operator != creator {
			return "", "", types.Provider{}, sdkerrors.ErrUnauthorized.Wrapf("creator is not authorized to %s provider bond", action)
		}
	}

	return creator, providerAddr, provider, nil
}

func (k msgServer) AddProviderBond(goCtx context.Context, msg *types.MsgAddProviderBond) (*types.MsgAddProviderBondResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)
	if msg == nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("invalid request")
	}

	creator, providerAddr, provider, err := k.providerBondActor(ctx, msg.Creator, msg.Provider, "add")
	if err != nil {
		return nil, err
	}

	params := k.GetParams(ctx)
	minBond, err := normalizeMinProviderBond(params)
	if err != nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrap(err.Error())
	}
	topUp := normalizeCoinAmount(msg.Bond)
	topUp.Denom = strings.TrimSpace(topUp.Denom)
	if topUp.Denom == "" {
		topUp.Denom = minBond.Denom
	}
	if !topUp.Amount.IsPositive() {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("provider bond top-up must be positive")
	}
	if !topUp.IsValid() {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid provider bond top-up: %s", topUp)
	}
	if topUp.Denom != minBond.Denom {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("provider bond denom must be %q (got %q)", minBond.Denom, topUp.Denom)
	}

	current := normalizeCoinAmount(provider.Bond)
	current.Denom = strings.TrimSpace(current.Denom)
	if current.Denom == "" {
		current.Denom = topUp.Denom
	}
	if current.Denom != topUp.Denom {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("provider bond denom %q does not match top-up denom %q", current.Denom, topUp.Denom)
	}

	creatorAddr, err := sdk.AccAddressFromBech32(creator)
	if err != nil {
		return nil, sdkerrors.ErrInvalidAddress.Wrapf("invalid creator address: %s", creator)
	}
	if err := k.BankKeeper.SendCoinsFromAccountToModule(ctx, creatorAddr, types.ProviderBondModuleName, sdk.NewCoins(topUp)); err != nil {
		return nil, fmt.Errorf("failed to lock provider bond top-up: %w", err)
	}

	provider.Bond = sdk.NewCoin(current.Denom, current.Amount.Add(topUp.Amount))
	if provider.BondSlashed.Denom == "" {
		provider.BondSlashed = zeroBondLike(provider.Bond.Denom)
	}
	if err := k.Providers.Set(ctx, providerAddr, provider); err != nil {
		return nil, fmt.Errorf("failed to update provider bond: %w", err)
	}

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			types.TypeMsgAddProviderBond,
			sdk.NewAttribute(types.AttributeKeyProvider, providerAddr),
			sdk.NewAttribute("actor", creator),
			sdk.NewAttribute("provider_bond_added", topUp.String()),
			sdk.NewAttribute("provider_bond", provider.Bond.String()),
		),
	)

	return &types.MsgAddProviderBondResponse{Success: true}, nil
}

func (k msgServer) WithdrawProviderBond(goCtx context.Context, msg *types.MsgWithdrawProviderBond) (*types.MsgWithdrawProviderBondResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)
	if msg == nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("invalid request")
	}

	creator, providerAddr, provider, err := k.providerBondActor(ctx, msg.Creator, msg.Provider, "withdraw")
	if err != nil {
		return nil, err
	}
	if strings.EqualFold(strings.TrimSpace(provider.Status), "jailed") {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("provider bond withdrawal disabled while provider is jailed")
	}

	params := k.GetParams(ctx)
	minBond, err := normalizeMinProviderBond(params)
	if err != nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrap(err.Error())
	}
	withdrawal := normalizeCoinAmount(msg.Bond)
	withdrawal.Denom = strings.TrimSpace(withdrawal.Denom)
	if withdrawal.Denom == "" {
		withdrawal.Denom = minBond.Denom
	}
	if !withdrawal.Amount.IsPositive() {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("provider bond withdrawal must be positive")
	}
	if !withdrawal.IsValid() {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid provider bond withdrawal: %s", withdrawal)
	}
	if withdrawal.Denom != minBond.Denom {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("provider bond denom must be %q (got %q)", minBond.Denom, withdrawal.Denom)
	}

	current := normalizeCoinAmount(provider.Bond)
	current.Denom = strings.TrimSpace(current.Denom)
	if current.Denom == "" {
		current.Denom = withdrawal.Denom
	}
	if current.Denom != withdrawal.Denom {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("provider bond denom %q does not match withdrawal denom %q", current.Denom, withdrawal.Denom)
	}
	if current.Amount.LT(withdrawal.Amount) {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("provider bond withdrawal %s exceeds active bond %s", withdrawal, current)
	}

	assignmentCounts, err := k.providerMode2AssignmentCountSnapshot(ctx)
	if err != nil {
		return nil, err
	}
	active, pending := assignmentCounts.countsFor(providerAddr)
	assignments := assignmentCountTotal(active, pending)
	required, err := providerBondRequirementForAssignments(params, assignments)
	if err != nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrap(err.Error())
	}
	if required.Amount.IsPositive() && current.Denom != required.Denom {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("provider bond denom %q does not match required denom %q", current.Denom, required.Denom)
	}

	remaining := sdk.NewCoin(current.Denom, current.Amount.Sub(withdrawal.Amount))
	if remaining.Amount.LT(required.Amount) {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf(
			"provider bond withdrawal would violate required collateral %s for %d active/pending assignments",
			required,
			assignments,
		)
	}

	creatorAddr, err := sdk.AccAddressFromBech32(creator)
	if err != nil {
		return nil, sdkerrors.ErrInvalidAddress.Wrapf("invalid creator address: %s", creator)
	}
	if err := k.BankKeeper.SendCoinsFromModuleToAccount(ctx, types.ProviderBondModuleName, creatorAddr, sdk.NewCoins(withdrawal)); err != nil {
		return nil, fmt.Errorf("failed to withdraw provider bond: %w", err)
	}

	provider.Bond = remaining
	if provider.BondSlashed.Denom == "" {
		provider.BondSlashed = zeroBondLike(provider.Bond.Denom)
	}
	if err := k.Providers.Set(ctx, providerAddr, provider); err != nil {
		return nil, fmt.Errorf("failed to update provider bond: %w", err)
	}

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			types.TypeMsgWithdrawProviderBond,
			sdk.NewAttribute(types.AttributeKeyProvider, providerAddr),
			sdk.NewAttribute("actor", creator),
			sdk.NewAttribute("provider_bond_withdrawn", withdrawal.String()),
			sdk.NewAttribute("provider_bond", provider.Bond.String()),
			sdk.NewAttribute("required_collateral", required.String()),
			sdk.NewAttribute("active_assignments", fmt.Sprintf("%d", active)),
			sdk.NewAttribute("pending_assignments", fmt.Sprintf("%d", pending)),
		),
	)

	return &types.MsgWithdrawProviderBondResponse{Success: true}, nil
}

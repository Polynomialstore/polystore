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

	updatedProvider := provider
	updatedProvider.Bond = remaining
	if updatedProvider.BondSlashed.Denom == "" {
		updatedProvider.BondSlashed = zeroBondLike(updatedProvider.Bond.Denom)
	}

	delayBlocks := params.ProviderBondUnbondingBlocks
	if delayBlocks > 0 {
		const maxInt64 = int64(^uint64(0) >> 1)
		currentHeight := ctx.BlockHeight()
		if currentHeight < 0 || delayBlocks > uint64(maxInt64-currentHeight) {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("provider bond unbonding maturity height would overflow")
		}
		matureAt := currentHeight + int64(delayBlocks)
		unbondingID, err := k.ProviderBondUnbondingCount.Next(ctx)
		if err != nil {
			return nil, fmt.Errorf("failed to allocate provider bond unbonding id: %w", err)
		}
		unbonding := types.ProviderBondUnbonding{
			Id:                 unbondingID,
			Provider:           providerAddr,
			Recipient:          creator,
			Amount:             withdrawal,
			RequestedHeight:    currentHeight,
			MatureAtHeight:     matureAt,
			Actor:              creator,
			ActiveAssignments:  active,
			PendingAssignments: pending,
			RequiredCollateral: required,
		}
		if err := k.ProviderBondUnbondings.Set(ctx, unbondingID, unbonding); err != nil {
			return nil, fmt.Errorf("failed to queue provider bond unbonding: %w", err)
		}
		if err := k.ProviderBondUnbondingsByProvider.Set(ctx, collections.Join(providerAddr, unbondingID), true); err != nil {
			return nil, fmt.Errorf("failed to index provider bond unbonding: %w", err)
		}
		if err := k.Providers.Set(ctx, providerAddr, updatedProvider); err != nil {
			return nil, fmt.Errorf("failed to update provider bond: %w", err)
		}

		ctx.EventManager().EmitEvent(
			sdk.NewEvent(
				types.TypeMsgWithdrawProviderBond,
				sdk.NewAttribute(types.AttributeKeyProvider, providerAddr),
				sdk.NewAttribute("actor", creator),
				sdk.NewAttribute("provider_bond_queued", withdrawal.String()),
				sdk.NewAttribute("provider_bond", updatedProvider.Bond.String()),
				sdk.NewAttribute("provider_bond_unbonding_id", fmt.Sprintf("%d", unbondingID)),
				sdk.NewAttribute("mature_at_height", fmt.Sprintf("%d", matureAt)),
				sdk.NewAttribute("required_collateral", required.String()),
				sdk.NewAttribute("active_assignments", fmt.Sprintf("%d", active)),
				sdk.NewAttribute("pending_assignments", fmt.Sprintf("%d", pending)),
			),
		)

		return &types.MsgWithdrawProviderBondResponse{
			Success:        true,
			UnbondingId:    unbondingID,
			MatureAtHeight: matureAt,
		}, nil
	}

	creatorAddr, err := sdk.AccAddressFromBech32(creator)
	if err != nil {
		return nil, sdkerrors.ErrInvalidAddress.Wrapf("invalid creator address: %s", creator)
	}
	if err := k.BankKeeper.SendCoinsFromModuleToAccount(ctx, types.ProviderBondModuleName, creatorAddr, sdk.NewCoins(withdrawal)); err != nil {
		return nil, fmt.Errorf("failed to withdraw provider bond: %w", err)
	}
	if err := k.Providers.Set(ctx, providerAddr, updatedProvider); err != nil {
		return nil, fmt.Errorf("failed to update provider bond: %w", err)
	}

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			types.TypeMsgWithdrawProviderBond,
			sdk.NewAttribute(types.AttributeKeyProvider, providerAddr),
			sdk.NewAttribute("actor", creator),
			sdk.NewAttribute("provider_bond_withdrawn", withdrawal.String()),
			sdk.NewAttribute("provider_bond", updatedProvider.Bond.String()),
			sdk.NewAttribute("required_collateral", required.String()),
			sdk.NewAttribute("active_assignments", fmt.Sprintf("%d", active)),
			sdk.NewAttribute("pending_assignments", fmt.Sprintf("%d", pending)),
		),
	)

	return &types.MsgWithdrawProviderBondResponse{Success: true}, nil
}

func (k msgServer) ClaimProviderBondWithdrawal(goCtx context.Context, msg *types.MsgClaimProviderBondWithdrawal) (*types.MsgClaimProviderBondWithdrawalResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)
	if msg == nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("invalid request")
	}
	creator, err := requireCanonicalAddress(msg.Creator, "creator")
	if err != nil {
		return nil, err
	}
	unbonding, err := k.ProviderBondUnbondings.Get(ctx, msg.UnbondingId)
	if err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return nil, sdkerrors.ErrNotFound.Wrap("provider bond unbonding not found")
		}
		return nil, err
	}
	if ctx.BlockHeight() < unbonding.MatureAtHeight {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf(
			"provider bond unbonding %d matures at height %d",
			unbonding.Id,
			unbonding.MatureAtHeight,
		)
	}

	if !k.canClaimProviderBondUnbonding(ctx, creator, unbonding) {
		return nil, sdkerrors.ErrUnauthorized.Wrap("creator is not authorized to claim provider bond withdrawal")
	}

	if provider, err := k.Providers.Get(ctx, unbonding.Provider); err == nil && strings.EqualFold(strings.TrimSpace(provider.Status), "jailed") {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("provider bond claim disabled while provider is jailed")
	} else if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return nil, err
	}

	recipientAddr, err := sdk.AccAddressFromBech32(unbonding.Recipient)
	if err != nil {
		return nil, sdkerrors.ErrInvalidAddress.Wrapf("invalid provider bond recipient address: %s", unbonding.Recipient)
	}
	if err := k.BankKeeper.SendCoinsFromModuleToAccount(ctx, types.ProviderBondModuleName, recipientAddr, sdk.NewCoins(unbonding.Amount)); err != nil {
		return nil, fmt.Errorf("failed to claim provider bond withdrawal: %w", err)
	}
	if err := k.ProviderBondUnbondings.Remove(ctx, unbonding.Id); err != nil {
		return nil, fmt.Errorf("failed to remove provider bond unbonding: %w", err)
	}
	if err := k.ProviderBondUnbondingsByProvider.Remove(ctx, collections.Join(unbonding.Provider, unbonding.Id)); err != nil && !errors.Is(err, collections.ErrNotFound) {
		return nil, fmt.Errorf("failed to remove provider bond unbonding index: %w", err)
	}

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			types.TypeMsgClaimProviderBondWithdrawal,
			sdk.NewAttribute(types.AttributeKeyProvider, unbonding.Provider),
			sdk.NewAttribute("actor", creator),
			sdk.NewAttribute("recipient", unbonding.Recipient),
			sdk.NewAttribute("provider_bond_claimed", unbonding.Amount.String()),
			sdk.NewAttribute("provider_bond_unbonding_id", fmt.Sprintf("%d", unbonding.Id)),
		),
	)

	return &types.MsgClaimProviderBondWithdrawalResponse{Success: true}, nil
}

func (k msgServer) canClaimProviderBondUnbonding(ctx sdk.Context, creator string, unbonding types.ProviderBondUnbonding) bool {
	if creator == unbonding.Recipient || creator == unbonding.Provider {
		return true
	}

	pairing, err := k.ProviderPairings.Get(ctx, unbonding.Provider)
	if err != nil {
		return false
	}
	return pairing.Operator == creator
}

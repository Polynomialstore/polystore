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

func (k msgServer) AddProviderBond(goCtx context.Context, msg *types.MsgAddProviderBond) (*types.MsgAddProviderBondResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)
	if msg == nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("invalid request")
	}

	creator, err := requireCanonicalAddress(msg.Creator, "creator")
	if err != nil {
		return nil, err
	}
	providerAddr, err := canonicalAddress(msg.Provider, "provider")
	if err != nil {
		return nil, err
	}

	provider, err := k.Providers.Get(ctx, providerAddr)
	if err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return nil, sdkerrors.ErrNotFound.Wrap("provider not found")
		}
		return nil, err
	}

	if creator != providerAddr {
		pairing, err := k.ProviderPairings.Get(ctx, providerAddr)
		if err != nil {
			if errors.Is(err, collections.ErrNotFound) {
				return nil, sdkerrors.ErrUnauthorized.Wrap("creator is not authorized to add provider bond")
			}
			return nil, err
		}
		if pairing.Operator != creator {
			return nil, sdkerrors.ErrUnauthorized.Wrap("creator is not authorized to add provider bond")
		}
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

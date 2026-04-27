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

const observedOnlyProviderStakeSlashSemantics = "observed_only_no_provider_slash"

func (k msgServer) BindProviderStake(goCtx context.Context, msg *types.MsgBindProviderStake) (*types.MsgBindProviderStakeResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)
	if msg == nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("invalid request")
	}

	creator, providerAddr, _, err := k.providerStakeActor(ctx, msg.Creator, msg.Provider, "bind")
	if err != nil {
		return nil, err
	}
	validator, err := requireCanonicalValidatorAddress(msg.Validator)
	if err != nil {
		return nil, err
	}

	operator := ""
	if pairing, err := k.ProviderPairings.Get(ctx, providerAddr); err == nil {
		operator = pairing.Operator
	} else if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return nil, err
	}

	boundHeight := ctx.BlockHeight()
	if existing, err := k.ProviderStakingBindings.Get(ctx, providerAddr); err == nil && existing.BoundHeight != 0 {
		boundHeight = existing.BoundHeight
	} else if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return nil, err
	}

	binding := types.ProviderStakingBinding{
		Provider:                         providerAddr,
		Delegator:                        creator,
		Validator:                        validator,
		Operator:                         operator,
		BoundHeight:                      boundHeight,
		UpdatedHeight:                    ctx.BlockHeight(),
		SlashSemantics:                   observedOnlyProviderStakeSlashSemantics,
		CountsTowardAssignmentCollateral: false,
	}
	if err := k.ProviderStakingBindings.Set(ctx, providerAddr, binding); err != nil {
		return nil, fmt.Errorf("failed to bind provider stake: %w", err)
	}

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			types.TypeMsgBindProviderStake,
			sdk.NewAttribute(types.AttributeKeyProvider, providerAddr),
			sdk.NewAttribute("delegator", creator),
			sdk.NewAttribute("validator", validator),
			sdk.NewAttribute("operator", operator),
			sdk.NewAttribute("slash_semantics", binding.SlashSemantics),
			sdk.NewAttribute("counts_toward_assignment_collateral", "false"),
		),
	)

	return &types.MsgBindProviderStakeResponse{Success: true}, nil
}

func (k msgServer) UnbindProviderStake(goCtx context.Context, msg *types.MsgUnbindProviderStake) (*types.MsgUnbindProviderStakeResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)
	if msg == nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("invalid request")
	}

	creator, providerAddr, _, err := k.providerStakeActor(ctx, msg.Creator, msg.Provider, "unbind")
	if err != nil {
		return nil, err
	}
	if err := k.ProviderStakingBindings.Remove(ctx, providerAddr); err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return nil, sdkerrors.ErrNotFound.Wrap("provider staking binding not found")
		}
		return nil, fmt.Errorf("failed to unbind provider stake: %w", err)
	}

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			types.TypeMsgUnbindProviderStake,
			sdk.NewAttribute(types.AttributeKeyProvider, providerAddr),
			sdk.NewAttribute("actor", creator),
		),
	)

	return &types.MsgUnbindProviderStakeResponse{Success: true}, nil
}

func requireCanonicalValidatorAddress(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", sdkerrors.ErrInvalidRequest.Wrap("validator is required")
	}
	valAddr, err := sdk.ValAddressFromBech32(raw)
	if err != nil {
		return "", sdkerrors.ErrInvalidAddress.Wrapf("invalid validator address: %s", raw)
	}
	canonical := valAddr.String()
	if raw != canonical {
		return "", sdkerrors.ErrInvalidRequest.Wrapf("validator must use canonical address string %q", canonical)
	}
	return canonical, nil
}

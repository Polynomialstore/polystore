package keeper

import (
	"context"
	"fmt"

	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"

	"polystorechain/x/polystorechain/types"
)

func (k msgServer) SetProviderDraining(goCtx context.Context, msg *types.MsgSetProviderDraining) (*types.MsgSetProviderDrainingResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)
	if msg == nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("invalid request")
	}
	creator, err := requireCanonicalProviderCreator(msg.Creator)
	if err != nil {
		return nil, err
	}

	provider, err := k.Providers.Get(ctx, creator)
	if err != nil {
		return nil, sdkerrors.ErrNotFound.Wrap("provider not found")
	}
	provider.Draining = msg.Draining

	if err := k.Providers.Set(ctx, creator, provider); err != nil {
		return nil, fmt.Errorf("failed to update provider: %w", err)
	}

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			"set_provider_draining",
			sdk.NewAttribute(types.AttributeKeyProvider, creator),
			sdk.NewAttribute("draining", fmt.Sprintf("%t", msg.Draining)),
		),
	)

	return &types.MsgSetProviderDrainingResponse{Success: true}, nil
}

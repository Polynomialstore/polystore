package keeper

import (
	"context"
	"fmt"

	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"
	"nilchain/x/nilchain/types"
)

func (k msgServer) RegisterProvider(goCtx context.Context, msg *types.MsgRegisterProvider) (*types.MsgRegisterProviderResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	creatorAddr, err := sdk.AccAddressFromBech32(msg.Creator)
	if err != nil {
		return nil, sdkerrors.ErrInvalidAddress.Wrapf("invalid creator address: %s", err)
	}

	// Basic validation for capabilities
	if msg.Capabilities != "Archive" && msg.Capabilities != "General" && msg.Capabilities != "Edge" {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid capabilities: %s", msg.Capabilities)
	}

	// Check if provider already exists
	_, err = k.Providers.Get(ctx, msg.Creator)
	if err == nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("provider %s already registered", msg.Creator)
	}
	// If the error is not 'not found', then it's a real error
	if err != nil && !sdkerrors.ErrNotFound.Is(err) {
		return nil, err
	}

	// Create new Provider object
	provider := types.Provider{
		Address: creatorAddr.String(),
		TotalStorage: msg.TotalStorage,
		UsedStorage: 0, // Initially 0
		Capabilities: msg.Capabilities,
		Status: "Active", // Initially active
	}

	// Save provider to store
	if err := k.Providers.Set(ctx, provider.Address, provider); err != nil {
		return nil, fmt.Errorf("failed to set provider: %w", err)
	}

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			types.TypeMsgRegisterProvider,
			sdk.NewAttribute(types.AttributeKeyProvider, provider.Address),
			sdk.NewAttribute(types.AttributeKeyCapabilities, provider.Capabilities),
			sdk.NewAttribute(types.AttributeKeyTotalStorage, fmt.Sprintf("%d", provider.TotalStorage)),
		),
	)

	return &types.MsgRegisterProviderResponse{Success: true}, nil
}
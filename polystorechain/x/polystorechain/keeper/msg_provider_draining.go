package keeper

import (
	"context"
	"errors"
	"fmt"

	"cosmossdk.io/collections"
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
	if !msg.Draining {
		if err := k.clearProviderDrainingHealth(ctx, provider); err != nil {
			return nil, fmt.Errorf("failed to clear provider draining health: %w", err)
		}
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

func (k msgServer) clearProviderDrainingHealth(ctx sdk.Context, provider types.Provider) error {
	providerAddr := provider.Address
	health, err := k.ProviderHealthStates.Get(ctx, providerAddr)
	if err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return nil
		}
		return err
	}
	if health.LifecycleStatus != types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_DRAINING {
		return nil
	}

	health.Provider = providerAddr
	health.Reason = "provider_draining_cleared"
	health.EvidenceClass = types.EvidenceClass_EVIDENCE_CLASS_OPERATIONAL
	health.UpdatedHeight = ctx.BlockHeight()
	if health.SoftFaultCount > 0 {
		health.LifecycleStatus = types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_DEGRADED
		health.Severity = types.EvidenceSeverity_EVIDENCE_SEVERITY_DEGRADED
		health.ConsequenceCeiling = "provider opted back in; soft-fault window remains under decay"
	} else {
		health.LifecycleStatus = types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_ACTIVE
		health.Severity = types.EvidenceSeverity_EVIDENCE_SEVERITY_INFO
		health.ConsequenceCeiling = "provider opted back in"
	}

	active, pending, err := k.providerMode2AssignmentCounts(ctx, providerAddr)
	if err != nil {
		return err
	}
	health = overlayProviderBondHealth(health, provider, k.GetParams(ctx), ctx.BlockHeight(), active+pending)
	return k.ProviderHealthStates.Set(ctx, providerAddr, health)
}

package keeper

import (
	"context"
	"fmt"
	sdk "github.com/cosmos/cosmos-sdk/types"

	"polystorechain/x/polystorechain/types"
)

// GetParams get all parameters as types.Params
func (k Keeper) GetParams(ctx context.Context) (params types.Params) {
	p, err := k.Params.Get(ctx)
	if err != nil {
		return types.DefaultParams()
	}
	return p
}

// SetParams set the params
func (k Keeper) SetParams(ctx context.Context, params types.Params) error {
	if err := params.Validate(); err != nil {
		return err
	}
	active, err := optionalSessionCount(k.RetrievalV2ActivatedHeight.Get(ctx))
	if err != nil {
		return err
	}
	if active != 0 && params.RetrievalV2ActivationHeight != active {
		return fmt.Errorf("retrieval v2 activation is irreversible")
	}
	current, err := k.Params.Get(ctx)
	if err != nil {
		return err
	}
	height := sdk.UnwrapSDKContext(ctx).BlockHeight()
	if current.RetrievalV2ActivationHeight != params.RetrievalV2ActivationHeight && params.RetrievalV2ActivationHeight != 0 && height >= 0 && params.RetrievalV2ActivationHeight <= uint64(height) {
		return fmt.Errorf("retrieval v2 activation must be scheduled in the future")
	}
	return k.Params.Set(ctx, params)
}

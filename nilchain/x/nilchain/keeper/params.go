package keeper

import (
	"context"

	"nilchain/x/nilchain/types"
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
	return k.Params.Set(ctx, params)
}

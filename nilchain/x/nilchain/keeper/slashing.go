package keeper

import (
	"context"
	"errors"

	"cosmossdk.io/collections"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"nilchain/x/nilchain/types"
)

// CheckMissedProofs iterates over all deals and slashes providers who have missed their proof window.
func (k Keeper) CheckMissedProofs(ctx context.Context) error {
	// Iterate over all active deals
	// Note: In production, this should be optimized (e.g., iterate over a queue sorted by NextProofHeight)
	err := k.Deals.Walk(ctx, nil, func(dealID uint64, deal types.Deal) (stop bool, err error) {
		// Only check active deals
		currentHeight := uint64(sdk.UnwrapSDKContext(ctx).BlockHeight())
		if currentHeight < deal.StartBlock || currentHeight > deal.EndBlock {
			return false, nil
		}

		for _, providerAddr := range deal.Providers {
			// Get LastProofHeight
			lastProof, err := k.DealProviderStatus.Get(ctx, collections.Join(dealID, providerAddr))
			if err != nil {
				if !errors.Is(err, collections.ErrNotFound) {
					// If error is real error, return it? Or log and continue?
                    // For safety, we log and assume start block.
                    sdk.UnwrapSDKContext(ctx).Logger().Error("Failed to get last proof height", "error", err)
				}
				lastProof = deal.StartBlock
			}

			// Check if overdue
			if currentHeight > lastProof + types.ProofWindow {
				// SLASHDOWN!
				sdkCtx := sdk.UnwrapSDKContext(ctx)
				sdkCtx.Logger().Info("Slashing provider for downtime", "provider", providerAddr, "deal", dealID, "last_proof", lastProof, "current", currentHeight)

				// Slash Amount: 10 NIL (placeholder)
				slashAmt := sdk.NewCoins(sdk.NewInt64Coin("token", 10000000))
				
				pAddr, err := sdk.AccAddressFromBech32(providerAddr)
				if err != nil {
					sdkCtx.Logger().Error("Invalid provider address during slash", "address", providerAddr)
					continue
				}

				// Attempt slash
				err = k.BankKeeper.SendCoinsFromAccountToModule(sdkCtx, pAddr, types.ModuleName, slashAmt)
				if err != nil {
					// Insufficient funds -> Jail?
					// For now just log
					sdkCtx.Logger().Info("Slashing failed (insufficient funds)", "provider", providerAddr)
				} else {
					// Burn
					if err := k.BankKeeper.BurnCoins(sdkCtx, types.ModuleName, slashAmt); err != nil {
						sdkCtx.Logger().Error("Failed to burn slashed coins", "error", err)
					}
				}

				// Update LastProofHeight to CurrentHeight to give them a new window
				// and prevent slashing every block for the same incident.
				if err := k.DealProviderStatus.Set(ctx, collections.Join(dealID, providerAddr), currentHeight); err != nil {
					sdkCtx.Logger().Error("Failed to update proof status after slash", "error", err)
				}
			}
		}
		return false, nil
	})

	return err
}

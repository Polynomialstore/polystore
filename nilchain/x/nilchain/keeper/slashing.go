package keeper

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"cosmossdk.io/collections"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"nilchain/x/nilchain/types"
)

// CheckMissedProofs iterates over all deals and slashes providers who have missed their proof window.
func (k Keeper) CheckMissedProofs(ctx context.Context) error {
	sdkCtx := sdk.UnwrapSDKContext(ctx)
	params := k.GetParams(sdkCtx)
	if params.EpochLenBlocks == 0 {
		return nil
	}
	if !isEpochEnd(sdkCtx.BlockHeight(), params.EpochLenBlocks) {
		return nil
	}
	epochID := epochIDAtHeight(sdkCtx.BlockHeight(), params.EpochLenBlocks)
	if epochID == 0 {
		return nil
	}
	height := uint64(sdkCtx.BlockHeight())

	err := k.Deals.Walk(ctx, nil, func(dealID uint64, deal types.Deal) (stop bool, err error) {
		if height < deal.StartBlock || height > deal.EndBlock {
			return false, nil
		}
		in, ok := slabInputs(deal)
		if !ok {
			return false, nil
		}

		stripe, serr := stripeParamsForDeal(deal)
		if serr != nil {
			sdkCtx.Logger().Error("quota enforcement skipped: invalid stripe params", "deal", dealID, "error", serr)
			return false, nil
		}

		switch stripe.mode {
		case 1:
			for _, provider := range deal.Providers {
				quota := requiredBlobsMode1(params, deal, in)
				if quota == 0 {
					continue
				}
				keyEpoch := mode1EpochKey(dealID, provider, epochID)

				creditsRaw, err := k.Mode1EpochCredits.Get(ctx, keyEpoch)
				if err != nil && !errors.Is(err, collections.ErrNotFound) {
					return false, err
				}
				synth, err := k.Mode1EpochSynthetic.Get(ctx, keyEpoch)
				if err != nil && !errors.Is(err, collections.ErrNotFound) {
					return false, err
				}

				creditCap := creditCapBlobs(params, quota)
				credits := creditsRaw
				if creditCap < credits {
					credits = creditCap
				}

				total := credits + synth
				missedKey := collections.Join(dealID, provider)
				if total < quota {
					prev, err := k.Mode1MissedEpochs.Get(ctx, missedKey)
					if err != nil && !errors.Is(err, collections.ErrNotFound) {
						return false, err
					}
					if err := k.Mode1MissedEpochs.Set(ctx, missedKey, prev+1); err != nil {
						return false, err
					}
					sdkCtx.Logger().Info(
						"quota missed (mode1)",
						"epoch", epochID,
						"deal", dealID,
						"provider", provider,
						"quota", quota,
						"credits", credits,
						"synthetic", synth,
						"missed_epochs", prev+1,
					)
				} else {
					if err := k.Mode1MissedEpochs.Remove(ctx, missedKey); err != nil && !errors.Is(err, collections.ErrNotFound) {
						return false, err
					}
				}
			}
		case 2:
			if stripe.slotCount == 0 {
				return false, nil
			}
			quota := requiredBlobsMode2(params, deal, stripe, in)
			if quota == 0 {
				return false, nil
			}
			dealChanged := false
			for slotIdx := uint64(0); slotIdx < stripe.slotCount; slotIdx++ {
				slot := uint32(slotIdx)
				if deal.RedundancyMode == 2 && len(deal.Mode2Slots) > 0 && int(slot) < len(deal.Mode2Slots) {
					s := deal.Mode2Slots[slot]
					if s != nil && s.Status != types.SlotStatus_SLOT_STATUS_ACTIVE {
						continue
					}
				}

				keyEpoch := mode2EpochKey(dealID, slot, epochID)
				creditsRaw, err := k.Mode2EpochCredits.Get(ctx, keyEpoch)
				if err != nil && !errors.Is(err, collections.ErrNotFound) {
					return false, err
				}
				synth, err := k.Mode2EpochSynthetic.Get(ctx, keyEpoch)
				if err != nil && !errors.Is(err, collections.ErrNotFound) {
					return false, err
				}

				creditCap := creditCapBlobs(params, quota)
				credits := creditsRaw
				if creditCap < credits {
					credits = creditCap
				}

				total := credits + synth
				missedKey := collections.Join(dealID, slot)
				if total < quota {
					prev, err := k.Mode2MissedEpochs.Get(ctx, missedKey)
					if err != nil && !errors.Is(err, collections.ErrNotFound) {
						return false, err
					}
					nextMissed := prev + 1
					if err := k.Mode2MissedEpochs.Set(ctx, missedKey, nextMissed); err != nil {
						return false, err
					}
					sdkCtx.Logger().Info(
						"quota missed (mode2)",
						"epoch", epochID,
						"deal", dealID,
						"slot", slotIdx,
						"quota", quota,
						"credits", credits,
						"synthetic", synth,
						"missed_epochs", nextMissed,
					)

					if params.EvictAfterMissedEpochs > 0 && nextMissed >= params.EvictAfterMissedEpochs {
						if deal.RedundancyMode != 2 || len(deal.Mode2Slots) == 0 || int(slot) >= len(deal.Mode2Slots) {
							continue
						}
						entry := deal.Mode2Slots[slot]
						if entry == nil || entry.Status != types.SlotStatus_SLOT_STATUS_ACTIVE {
							continue
						}
						if strings.TrimSpace(entry.PendingProvider) != "" {
							continue
						}

						pending, err := k.selectMode2ReplacementProvider(sdkCtx, deal, slot, epochID)
						if err != nil {
							sdkCtx.Logger().Error(
								"failed to select replacement provider",
								"deal", dealID,
								"slot", slotIdx,
								"error", err,
							)
							continue
						}

						entry.Status = types.SlotStatus_SLOT_STATUS_REPAIRING
						entry.PendingProvider = strings.TrimSpace(pending)
						entry.StatusSinceHeight = sdkCtx.BlockHeight()
						entry.RepairTargetGen = deal.CurrentGen
						deal.Mode2Slots[slot] = entry
						dealChanged = true
						_ = k.Mode2MissedEpochs.Remove(ctx, missedKey)

						sdkCtx.Logger().Info(
							"slot repair started",
							"deal", dealID,
							"slot", slotIdx,
							"provider", entry.Provider,
							"pending_provider", entry.PendingProvider,
							"repair_target_gen", entry.RepairTargetGen,
						)
					}
				} else {
					if err := k.Mode2MissedEpochs.Remove(ctx, missedKey); err != nil && !errors.Is(err, collections.ErrNotFound) {
						return false, err
					}
				}
			}
			if dealChanged {
				if err := k.Deals.Set(ctx, dealID, deal); err != nil {
					return false, err
				}
			}
		default:
			return false, fmt.Errorf("unexpected stripe mode %d", stripe.mode)
		}

		return false, nil
	})

	return err
}

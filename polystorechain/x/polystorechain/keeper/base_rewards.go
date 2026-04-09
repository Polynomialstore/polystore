package keeper

import (
	"errors"
	"fmt"
	"strings"

	"cosmossdk.io/collections"
	"cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"

	"polystorechain/x/polystorechain/types"
)

func epochStartHeightForID(epochID uint64, epochLen uint64) uint64 {
	if epochLen == 0 {
		return 1
	}
	if epochID == 0 {
		return 1
	}
	return (epochID-1)*epochLen + 1
}

func baseRewardBpsAtHeight(params types.Params, height uint64) uint64 {
	startHeight := params.EmissionStartHeight
	if startHeight == 0 {
		startHeight = 1
	}
	if height < startHeight {
		return 0
	}
	if params.BaseRewardHalvingIntervalBlocks == 0 {
		return 0
	}

	start := params.BaseRewardBpsStart
	tail := params.BaseRewardBpsTail
	if start <= tail {
		return tail
	}
	excess := start - tail

	k := (height - startHeight) / params.BaseRewardHalvingIntervalBlocks
	if k >= 64 {
		return tail
	}

	divisor := uint64(1) << k
	decayed := excess / divisor
	return tail + decayed
}

type baseRewardWeights struct {
	totalActiveSlotBytes uint64
	totalWeight          uint64
	byProvider           map[string]uint64
}

func (k Keeper) computeBaseRewardWeights(ctx sdk.Context, epochID uint64) (baseRewardWeights, error) {
	params := k.GetParams(ctx)
	height := uint64(ctx.BlockHeight())

	out := baseRewardWeights{
		totalActiveSlotBytes: 0,
		totalWeight:          0,
		byProvider:           make(map[string]uint64),
	}

	err := k.Deals.Walk(ctx, nil, func(dealID uint64, deal types.Deal) (stop bool, err error) {
		// end_block is exclusive: once height >= end_block, the deal is expired.
		if height < deal.StartBlock || height >= deal.EndBlock {
			return false, nil
		}
		in, ok := slabInputs(deal)
		if !ok {
			return false, nil
		}
		stripe, err := stripeParamsForDeal(deal)
		if err != nil {
			return false, nil
		}

		switch stripe.mode {
		case 2:
			if stripe.slotCount == 0 || len(deal.Mode2Slots) == 0 {
				return false, nil
			}
			quota := requiredBlobsMode2(params, deal, stripe, in)
			if quota == 0 {
				return false, nil
			}
			slotBytes, overflow := mulUint64(in.userMdus, stripe.rows)
			if overflow {
				return false, fmt.Errorf("slot bytes overflow")
			}
			slotBytes, overflow = mulUint64(slotBytes, uint64(types.BlobSizeBytes))
			if overflow {
				return false, fmt.Errorf("slot bytes overflow")
			}

			for _, slot := range deal.Mode2Slots {
				if slot == nil || slot.Status != types.SlotStatus_SLOT_STATUS_ACTIVE {
					continue
				}
				provider := strings.TrimSpace(slot.Provider)
				if provider == "" {
					continue
				}
				if p, err := k.Providers.Get(ctx, provider); err == nil && strings.TrimSpace(p.Status) != "Active" {
					continue
				}

				nextActive, overflow := addUint64(out.totalActiveSlotBytes, slotBytes)
				if overflow {
					return false, fmt.Errorf("total slot bytes overflow")
				}
				out.totalActiveSlotBytes = nextActive

				keyEpoch := mode2EpochKey(dealID, slot.Slot, epochID)
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
				if total < quota {
					continue
				}

				nextWeight, overflow := addUint64(out.totalWeight, slotBytes)
				if overflow {
					return false, fmt.Errorf("total weight overflow")
				}
				out.totalWeight = nextWeight
				out.byProvider[provider] = out.byProvider[provider] + slotBytes
			}
		default:
			quota := requiredBlobsMode1(params, deal, in)
			if quota == 0 {
				return false, nil
			}
			slotBytes, overflow := mulUint64(in.userMdus, uint64(types.MDU_SIZE))
			if overflow {
				return false, fmt.Errorf("slot bytes overflow")
			}

			for _, provider := range deal.Providers {
				provider = strings.TrimSpace(provider)
				if provider == "" {
					continue
				}
				if p, err := k.Providers.Get(ctx, provider); err == nil && strings.TrimSpace(p.Status) != "Active" {
					continue
				}

				nextActive, overflow := addUint64(out.totalActiveSlotBytes, slotBytes)
				if overflow {
					return false, fmt.Errorf("total slot bytes overflow")
				}
				out.totalActiveSlotBytes = nextActive

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
				if total < quota {
					continue
				}

				nextWeight, overflow := addUint64(out.totalWeight, slotBytes)
				if overflow {
					return false, fmt.Errorf("total weight overflow")
				}
				out.totalWeight = nextWeight
				out.byProvider[provider] = out.byProvider[provider] + slotBytes
			}
		}

		return false, nil
	})
	if err != nil {
		return baseRewardWeights{}, err
	}
	return out, nil
}

func (k Keeper) distributeBaseRewardPool(ctx sdk.Context, epochID uint64) error {
	params := k.GetParams(ctx)
	if params.EpochLenBlocks == 0 {
		return nil
	}
	if params.BaseRewardBpsStart == 0 && params.BaseRewardBpsTail == 0 {
		return nil
	}
	if params.StoragePrice.IsNil() || params.StoragePrice.IsNegative() {
		return nil
	}

	weights, err := k.computeBaseRewardWeights(ctx, epochID)
	if err != nil {
		return err
	}
	if weights.totalActiveSlotBytes == 0 {
		return nil
	}

	epochStart := epochStartHeightForID(epochID, params.EpochLenBlocks)
	bps := baseRewardBpsAtHeight(params, epochStart)
	if bps == 0 {
		return nil
	}

	rentDec := params.StoragePrice.
		MulInt(math.NewIntFromUint64(weights.totalActiveSlotBytes)).
		MulInt(math.NewIntFromUint64(params.EpochLenBlocks))

	poolDec := rentDec.MulInt(math.NewIntFromUint64(bps)).QuoInt(math.NewInt(10000))
	pool := poolDec.Ceil().TruncateInt()
	if !pool.IsPositive() {
		return nil
	}

	if weights.totalWeight == 0 {
		// No compliant providers: do not mint (equivalent to mint+burn).
		return nil
	}

	coins := sdk.NewCoins(sdk.NewCoin(sdk.DefaultBondDenom, pool))
	if err := k.BankKeeper.MintCoins(ctx, types.ModuleName, coins); err != nil {
		return err
	}

	weightDenom := math.NewIntFromUint64(weights.totalWeight)
	totalPaid := math.ZeroInt()

	for provider, w := range weights.byProvider {
		if w == 0 {
			continue
		}
		payout := pool.Mul(math.NewIntFromUint64(w)).Quo(weightDenom)
		if !payout.IsPositive() {
			continue
		}
		providerAddr, err := sdk.AccAddressFromBech32(provider)
		if err != nil {
			continue
		}
		if err := k.BankKeeper.SendCoinsFromModuleToAccount(ctx, types.ModuleName, providerAddr, sdk.NewCoins(sdk.NewCoin(sdk.DefaultBondDenom, payout))); err != nil {
			return err
		}
		totalPaid = totalPaid.Add(payout)
	}

	remainder := pool.Sub(totalPaid)
	if remainder.IsPositive() {
		if err := k.BankKeeper.BurnCoins(ctx, types.ModuleName, sdk.NewCoins(sdk.NewCoin(sdk.DefaultBondDenom, remainder))); err != nil {
			return err
		}
	}

	return nil
}

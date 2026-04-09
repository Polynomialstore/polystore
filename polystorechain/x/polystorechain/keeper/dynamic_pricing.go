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

func (k Keeper) recordRetrievalDemand(ctx sdk.Context, blobCount uint64) error {
	if blobCount == 0 {
		return nil
	}

	params := k.GetParams(ctx)
	if !params.DynamicPricingEnabled {
		return nil
	}
	if params.EpochLenBlocks == 0 {
		return nil
	}

	epochID := epochIDAtHeight(ctx.BlockHeight(), params.EpochLenBlocks)
	if epochID == 0 {
		return nil
	}

	prev, err := k.RetrievalDemandByEpoch.Get(ctx, epochID)
	if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return err
	}
	next, overflow := addUint64(prev, blobCount)
	if overflow {
		return fmt.Errorf("retrieval demand overflow")
	}
	return k.RetrievalDemandByEpoch.Set(ctx, epochID, next)
}

func (k Keeper) totalActiveProviderCapacity(ctx sdk.Context) (uint64, error) {
	total := uint64(0)
	if err := k.Providers.Walk(ctx, nil, func(_ string, p types.Provider) (stop bool, err error) {
		if strings.TrimSpace(p.Status) != "Active" {
			return false, nil
		}
		if p.Draining {
			return false, nil
		}
		next, overflow := addUint64(total, p.TotalStorage)
		if overflow {
			return true, fmt.Errorf("provider capacity overflow")
		}
		total = next
		return false, nil
	}); err != nil {
		return 0, err
	}
	return total, nil
}

func ratioBps(numerator uint64, denominator uint64) uint64 {
	if denominator == 0 || numerator == 0 {
		return 0
	}
	n := math.NewIntFromUint64(numerator).Mul(math.NewInt(10000))
	d := math.NewIntFromUint64(denominator)
	if d.IsZero() {
		return 0
	}
	out := n.Quo(d)
	if out.GT(math.NewInt(10000)) {
		return 10000
	}
	return out.Uint64()
}

func clampLegacyDec(v, min, max math.LegacyDec) math.LegacyDec {
	if v.LT(min) {
		return min
	}
	if v.GT(max) {
		return max
	}
	return v
}

func clampLegacyDecStep(current, target math.LegacyDec, stepBps uint64) math.LegacyDec {
	if stepBps == 0 || current.Equal(target) {
		return target
	}

	base := current
	if base.IsZero() {
		base = target
	}
	if base.IsZero() {
		return target
	}

	allowed := base.MulInt(math.NewIntFromUint64(stepBps)).QuoInt(math.NewInt(10000))
	if allowed.IsZero() {
		return target
	}

	upper := current.Add(allowed)
	if target.GT(upper) {
		return upper
	}
	lower := current.Sub(allowed)
	if target.LT(lower) {
		return lower
	}
	return target
}

func clampInt(v, min, max math.Int) math.Int {
	if v.LT(min) {
		return min
	}
	if v.GT(max) {
		return max
	}
	return v
}

func clampIntStep(current, target math.Int, stepBps uint64) math.Int {
	if stepBps == 0 || current.Equal(target) {
		return target
	}

	base := current
	if base.IsZero() {
		base = target
	}
	if base.IsZero() {
		return target
	}

	allowed := base.Mul(math.NewIntFromUint64(stepBps)).Add(math.NewInt(9999)).Quo(math.NewInt(10000))
	if allowed.IsZero() {
		allowed = math.NewInt(1)
	}

	upper := current.Add(allowed)
	if target.GT(upper) {
		return upper
	}
	lower := current.Sub(allowed)
	if target.LT(lower) {
		return lower
	}
	return target
}

func (k Keeper) updateDynamicPricingAtEpochStart(ctx sdk.Context, epochID uint64) error {
	params := k.GetParams(ctx)
	if !params.DynamicPricingEnabled {
		return nil
	}
	if params.EpochLenBlocks == 0 {
		return nil
	}

	lastEpoch, err := k.DynamicPricingLastEpoch.Get(ctx)
	if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return err
	}
	if epochID <= lastEpoch {
		return nil
	}

	stepBps := params.DynamicPricingMaxStepBps
	updated := false

	// --- Storage price ---
	if params.StorageTargetUtilizationBps != 0 && params.StoragePriceMax.GTE(params.StoragePriceMin) {
		used, err := k.totalActiveSlotBytes(ctx)
		if err != nil {
			return err
		}
		capacity, err := k.totalActiveProviderCapacity(ctx)
		if err != nil {
			return err
		}
		if capacity > 0 {
			utilBps := ratioBps(used, capacity)
			normalized := ratioBps(utilBps, params.StorageTargetUtilizationBps)

			delta := params.StoragePriceMax.Sub(params.StoragePriceMin)
			target := params.StoragePriceMin.Add(delta.MulInt(math.NewIntFromUint64(normalized)).QuoInt(math.NewInt(10000)))

			next := clampLegacyDecStep(params.StoragePrice, target, stepBps)
			next = clampLegacyDec(next, params.StoragePriceMin, params.StoragePriceMax)

			if !next.Equal(params.StoragePrice) {
				params.StoragePrice = next
				updated = true
			}
		}
	}

	// --- Retrieval price ---
	if epochID > 1 && params.RetrievalTargetBlobsPerEpoch != 0 && params.RetrievalPricePerBlobMax.Amount.GTE(params.RetrievalPricePerBlobMin.Amount) {
		prevEpoch := epochID - 1
		blobs, err := k.RetrievalDemandByEpoch.Get(ctx, prevEpoch)
		if err != nil && !errors.Is(err, collections.ErrNotFound) {
			return err
		}

		normalized := ratioBps(blobs, params.RetrievalTargetBlobsPerEpoch)

		minAmt := params.RetrievalPricePerBlobMin.Amount
		maxAmt := params.RetrievalPricePerBlobMax.Amount
		delta := maxAmt.Sub(minAmt)
		targetAmt := minAmt.Add(delta.Mul(math.NewIntFromUint64(normalized)).Quo(math.NewInt(10000)))

		nextAmt := clampIntStep(params.RetrievalPricePerBlob.Amount, targetAmt, stepBps)
		nextAmt = clampInt(nextAmt, minAmt, maxAmt)
		if !nextAmt.Equal(params.RetrievalPricePerBlob.Amount) {
			params.RetrievalPricePerBlob = sdk.NewCoin(sdk.DefaultBondDenom, nextAmt)
			updated = true
		}

		// Best-effort cleanup: we only need a small demand history.
		_ = k.RetrievalDemandByEpoch.Remove(ctx, prevEpoch)
	}

	if updated {
		if err := k.SetParams(ctx, params); err != nil {
			return err
		}
	}
	if err := k.DynamicPricingLastEpoch.Set(ctx, epochID); err != nil {
		return err
	}
	return nil
}

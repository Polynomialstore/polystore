package keeper

import (
	"errors"
	"fmt"

	"cosmossdk.io/collections"
	"cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
)

func intRewardOrZero(ctx sdk.Context, rewards collections.Map[string, math.Int], provider string) (math.Int, error) {
	value, err := rewards.Get(ctx, provider)
	if err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return math.ZeroInt(), nil
		}
		return math.ZeroInt(), err
	}
	if value.IsNil() {
		return math.ZeroInt(), nil
	}
	return value, nil
}

func addIntReward(ctx sdk.Context, rewards collections.Map[string, math.Int], provider string, delta math.Int) error {
	if delta.IsNil() || delta.IsZero() {
		return nil
	}
	if delta.IsNegative() {
		return fmt.Errorf("reward delta cannot be negative: %s", delta.String())
	}
	current, err := intRewardOrZero(ctx, rewards, provider)
	if err != nil {
		return err
	}
	return rewards.Set(ctx, provider, current.Add(delta))
}

func removeIntReward(ctx sdk.Context, rewards collections.Map[string, math.Int], provider string) error {
	if err := rewards.Remove(ctx, provider); err != nil && !errors.Is(err, collections.ErrNotFound) {
		return err
	}
	return nil
}

func (k Keeper) addProviderRewardClaims(ctx sdk.Context, provider string, storageReward math.Int, bandwidthReward math.Int) error {
	if storageReward.IsNil() {
		storageReward = math.ZeroInt()
	}
	if bandwidthReward.IsNil() {
		bandwidthReward = math.ZeroInt()
	}
	if storageReward.IsNegative() || bandwidthReward.IsNegative() {
		return fmt.Errorf("provider reward claims cannot be negative")
	}
	total := storageReward.Add(bandwidthReward)
	if total.IsZero() {
		return nil
	}
	if err := addIntReward(ctx, k.ProviderStorageRewards, provider, storageReward); err != nil {
		return fmt.Errorf("failed to add storage reward claim: %w", err)
	}
	if err := addIntReward(ctx, k.ProviderBandwidthRewards, provider, bandwidthReward); err != nil {
		return fmt.Errorf("failed to add bandwidth reward claim: %w", err)
	}
	if err := addIntReward(ctx, k.ProviderRewards, provider, total); err != nil {
		return fmt.Errorf("failed to add aggregate reward claim: %w", err)
	}
	return nil
}

func (k Keeper) providerRewardClaims(ctx sdk.Context, provider string) (storageReward math.Int, bandwidthReward math.Int, aggregateReward math.Int, err error) {
	storageReward, err = intRewardOrZero(ctx, k.ProviderStorageRewards, provider)
	if err != nil {
		return math.ZeroInt(), math.ZeroInt(), math.ZeroInt(), err
	}
	bandwidthReward, err = intRewardOrZero(ctx, k.ProviderBandwidthRewards, provider)
	if err != nil {
		return math.ZeroInt(), math.ZeroInt(), math.ZeroInt(), err
	}
	aggregateReward, err = intRewardOrZero(ctx, k.ProviderRewards, provider)
	if err != nil {
		return math.ZeroInt(), math.ZeroInt(), math.ZeroInt(), err
	}
	return storageReward, bandwidthReward, aggregateReward, nil
}

func (k Keeper) clearProviderRewardClaims(ctx sdk.Context, provider string) error {
	if err := removeIntReward(ctx, k.ProviderStorageRewards, provider); err != nil {
		return err
	}
	if err := removeIntReward(ctx, k.ProviderBandwidthRewards, provider); err != nil {
		return err
	}
	return removeIntReward(ctx, k.ProviderRewards, provider)
}

package keeper_test

import (
	"testing"

	"cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"

	"polystorechain/x/polystorechain/keeper"
	"polystorechain/x/polystorechain/types"
)

func TestWithdrawRewardsSplitsStorageAndBandwidthClaims(t *testing.T) {
	bank := newTrackingBankKeeper()
	f := initFixtureWithBankKeeper(t, bank)
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	ctx := sdk.UnwrapSDKContext(f.ctx)

	provider := makePolicyTestAddr(t, f, 0xA1)
	providerAddr, err := sdk.AccAddressFromBech32(provider)
	require.NoError(t, err)

	require.NoError(t, f.keeper.ProviderStorageRewards.Set(ctx, provider, math.NewInt(10)))
	require.NoError(t, f.keeper.ProviderBandwidthRewards.Set(ctx, provider, math.NewInt(5)))
	require.NoError(t, f.keeper.ProviderRewards.Set(ctx, provider, math.NewInt(15)))
	bank.moduleBalances[types.ModuleName] = sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 5))

	res, err := msgServer.WithdrawRewards(ctx, &types.MsgWithdrawRewards{Creator: provider})
	require.NoError(t, err)
	require.Equal(t, math.NewInt(15), res.AmountWithdrawn)
	require.Equal(t, "15stake", bank.GetBalance(ctx, providerAddr, sdk.DefaultBondDenom).String())
	require.True(t, bank.moduleBalances[types.ModuleName].IsZero())

	storage, err := f.keeper.ProviderStorageRewards.Get(ctx, provider)
	require.NoError(t, err)
	require.True(t, storage.IsZero())
	bandwidth, err := f.keeper.ProviderBandwidthRewards.Get(ctx, provider)
	require.NoError(t, err)
	require.True(t, bandwidth.IsZero())
	aggregate, err := f.keeper.ProviderRewards.Get(ctx, provider)
	require.NoError(t, err)
	require.True(t, aggregate.IsZero())
}

func TestWithdrawRewardsLegacyAggregateMintsForCompatibility(t *testing.T) {
	bank := newTrackingBankKeeper()
	f := initFixtureWithBankKeeper(t, bank)
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	ctx := sdk.UnwrapSDKContext(f.ctx)

	provider := makePolicyTestAddr(t, f, 0xA2)
	providerAddr, err := sdk.AccAddressFromBech32(provider)
	require.NoError(t, err)

	require.NoError(t, f.keeper.ProviderRewards.Set(ctx, provider, math.NewInt(7)))

	res, err := msgServer.WithdrawRewards(ctx, &types.MsgWithdrawRewards{Creator: provider})
	require.NoError(t, err)
	require.Equal(t, math.NewInt(7), res.AmountWithdrawn)
	require.Equal(t, "7stake", bank.GetBalance(ctx, providerAddr, sdk.DefaultBondDenom).String())
	require.True(t, bank.moduleBalances[types.ModuleName].IsZero())
}

package keeper_test

import (
	"testing"

	"cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"

	"polystorechain/x/polystorechain/keeper"
	"polystorechain/x/polystorechain/types"
)

func TestRegisterProviderLocksConfiguredBond(t *testing.T) {
	bank := newTrackingBankKeeper()
	f := initFixtureWithBankKeeper(t, bank)
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(1)

	params := types.DefaultParams()
	params.MinProviderBond = sdk.NewInt64Coin(sdk.DefaultBondDenom, 100)
	require.NoError(t, f.keeper.Params.Set(ctx, params))

	provider := makePolicyTestAddr(t, f, 0xA1)
	providerAddr, err := sdk.AccAddressFromBech32(provider)
	require.NoError(t, err)
	bank.setAccountBalance(providerAddr, sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 250)))

	_, err = msgServer.RegisterProvider(ctx, &types.MsgRegisterProvider{
		Creator:      provider,
		Capabilities: "General",
		TotalStorage: 1_000_000_000,
		Endpoints:    testProviderEndpoints,
		Bond:         sdk.NewInt64Coin(sdk.DefaultBondDenom, 150),
	})
	require.NoError(t, err)

	record, err := f.keeper.Providers.Get(ctx, provider)
	require.NoError(t, err)
	require.Equal(t, "150stake", record.Bond.String())
	require.Equal(t, "0stake", record.BondSlashed.String())
	require.Equal(t, "150stake", bank.moduleBalances[types.ProviderBondModuleName].String())
	require.True(t, bank.moduleBalances[types.ModuleName].IsZero())
	require.Equal(t, "100stake", bank.accountBalances[providerAddr.String()].String())

	underbonded := makePolicyTestAddr(t, f, 0xB2)
	underbondedAddr, err := sdk.AccAddressFromBech32(underbonded)
	require.NoError(t, err)
	bank.setAccountBalance(underbondedAddr, sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 250)))
	_, err = msgServer.RegisterProvider(ctx, &types.MsgRegisterProvider{
		Creator:      underbonded,
		Capabilities: "General",
		TotalStorage: 1_000_000_000,
		Endpoints:    testProviderEndpoints,
		Bond:         sdk.NewInt64Coin(sdk.DefaultBondDenom, 50),
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "below minimum")

	omitted := makePolicyTestAddr(t, f, 0xC3)
	_, err = msgServer.RegisterProvider(ctx, &types.MsgRegisterProvider{
		Creator:      omitted,
		Capabilities: "General",
		TotalStorage: 1_000_000_000,
		Endpoints:    testProviderEndpoints,
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "below minimum")
}

func TestHardFaultBurnsProviderBondAndUnderbondedAfterJailExpiry(t *testing.T) {
	bank := newTrackingBankKeeper()
	f := initFixtureWithBankKeeper(t, bank)
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(1)

	params := types.DefaultParams()
	params.EpochLenBlocks = 5
	params.MinProviderBond = sdk.NewInt64Coin(sdk.DefaultBondDenom, 90)
	params.HardFaultBondSlashBps = 2000
	require.NoError(t, f.keeper.Params.Set(ctx, params))

	providerA := makePolicyTestAddr(t, f, 0xA1)
	providerB := makePolicyTestAddr(t, f, 0xB2)
	providerC := makePolicyTestAddr(t, f, 0xC3)
	providerD := makePolicyTestAddr(t, f, 0xD4)
	for _, provider := range []string{providerA, providerB, providerC, providerD} {
		addr, err := sdk.AccAddressFromBech32(provider)
		require.NoError(t, err)
		bank.setAccountBalance(addr, sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 100)))
		_, err = msgServer.RegisterProvider(ctx, &types.MsgRegisterProvider{
			Creator:      provider,
			Capabilities: "General",
			TotalStorage: 1_000_000_000,
			Endpoints:    testProviderEndpoints,
			Bond:         sdk.NewInt64Coin(sdk.DefaultBondDenom, 100),
		})
		require.NoError(t, err)
	}
	require.Equal(t, "400stake", bank.moduleBalances[types.ProviderBondModuleName].String())
	require.True(t, bank.moduleBalances[types.ModuleName].IsZero())

	dealID := uint64(1)
	deal := mode2PolicyTestDeal(dealID, makePolicyTestAddr(t, f, 0xEE), []string{providerA, providerB, providerC})
	require.NoError(t, f.keeper.Deals.Set(ctx, dealID, deal))

	res, err := msgServer.ProveLiveness(ctx, &types.MsgProveLiveness{
		Creator: providerA,
		DealId:  dealID,
		EpochId: 1,
		ProofType: &types.MsgProveLiveness_SystemProof{
			SystemProof: invalidPolicyChainedProof(),
		},
	})
	require.NoError(t, err)
	require.False(t, res.Success)

	provider, err := f.keeper.Providers.Get(ctx, providerA)
	require.NoError(t, err)
	require.Equal(t, "80stake", provider.Bond.String())
	require.Equal(t, "20stake", provider.BondSlashed.String())
	require.Equal(t, "Jailed", provider.Status)
	require.Equal(t, "380stake", bank.moduleBalances[types.ProviderBondModuleName].String())
	require.True(t, bank.moduleBalances[types.ModuleName].IsZero())

	health, err := f.keeper.ProviderHealthStates.Get(ctx, providerA)
	require.NoError(t, err)
	require.Equal(t, types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_JAILED, health.LifecycleStatus)
	require.Contains(t, health.ConsequenceCeiling, "bond slash 20stake")

	ctxExpired := ctx.WithBlockHeight(20)
	require.NoError(t, f.keeper.CheckMissedProofs(ctxExpired))

	provider, err = f.keeper.Providers.Get(ctxExpired, providerA)
	require.NoError(t, err)
	require.Equal(t, "Active", provider.Status)
	require.Equal(t, "80stake", provider.Bond.String())

	queryServer := keeper.NewQueryServerImpl(f.keeper)
	healthRes, err := queryServer.GetProviderHealth(ctxExpired, &types.QueryGetProviderHealthRequest{Address: providerA})
	require.NoError(t, err)
	require.Equal(t, types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_DELINQUENT, healthRes.Health.LifecycleStatus)
	require.Equal(t, "provider_underbonded", healthRes.Health.Reason)

	assigned, err := f.keeper.AssignProviders(ctxExpired, 2, []byte("underbonded-placement"), "General", 4)
	require.NoError(t, err)
	require.NotContains(t, assigned, providerA)
	require.ElementsMatch(t, []string{providerB, providerC, providerD}, assigned)
}

func TestUnderbondedProviderHealthIsQueryableWithoutEvidence(t *testing.T) {
	f := initFixture(t)
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(1)

	params := types.DefaultParams()
	params.MinProviderBond = sdk.NewInt64Coin(sdk.DefaultBondDenom, 100)
	require.NoError(t, f.keeper.Params.Set(ctx, params))

	provider := makePolicyTestAddr(t, f, 0xA1)
	require.NoError(t, f.keeper.Providers.Set(ctx, provider, types.Provider{
		Address:         provider,
		TotalStorage:    1_000_000_000,
		Capabilities:    "General",
		Status:          "Active",
		ReputationScore: 100,
		Endpoints:       testProviderEndpoints,
		Bond:            sdk.NewCoin(sdk.DefaultBondDenom, math.NewInt(50)),
		BondSlashed:     sdk.NewCoin(sdk.DefaultBondDenom, math.ZeroInt()),
	}))

	queryServer := keeper.NewQueryServerImpl(f.keeper)
	health, err := queryServer.GetProviderHealth(ctx, &types.QueryGetProviderHealthRequest{Address: provider})
	require.NoError(t, err)
	require.Equal(t, types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_DELINQUENT, health.Health.LifecycleStatus)
	require.Equal(t, "provider_underbonded", health.Health.Reason)
	require.Contains(t, health.Health.ConsequenceCeiling, "below minimum")
}

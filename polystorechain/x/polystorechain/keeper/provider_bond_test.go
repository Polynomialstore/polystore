package keeper_test

import (
	"testing"

	"cosmossdk.io/collections"
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

func TestAddProviderBondRestoresAssignmentCollateralHeadroom(t *testing.T) {
	bank := newTrackingBankKeeper()
	f := initFixtureWithBankKeeper(t, bank)
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	queryServer := keeper.NewQueryServerImpl(f.keeper)
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(1)

	params := types.DefaultParams()
	params.MinProviderBond = sdk.NewInt64Coin(sdk.DefaultBondDenom, 50)
	params.AssignmentCollateralPerSlot = sdk.NewInt64Coin(sdk.DefaultBondDenom, 25)
	require.NoError(t, f.keeper.Params.Set(ctx, params))

	provider := makePolicyTestAddr(t, f, 0xA1)
	operator := makePolicyTestAddr(t, f, 0xB2)
	providerAddr, err := sdk.AccAddressFromBech32(provider)
	require.NoError(t, err)
	operatorAddr, err := sdk.AccAddressFromBech32(operator)
	require.NoError(t, err)
	bank.setAccountBalance(providerAddr, sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 50)))
	bank.setAccountBalance(operatorAddr, sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 75)))

	_, err = msgServer.RegisterProvider(ctx, &types.MsgRegisterProvider{
		Creator:      provider,
		Capabilities: "General",
		TotalStorage: 1_000_000_000,
		Endpoints:    testProviderEndpoints,
		Bond:         sdk.NewInt64Coin(sdk.DefaultBondDenom, 50),
	})
	require.NoError(t, err)
	_, err = msgServer.RequestProviderLink(ctx, &types.MsgRequestProviderLink{
		Creator:  provider,
		Operator: operator,
	})
	require.NoError(t, err)
	_, err = msgServer.ApproveProviderLink(ctx, &types.MsgApproveProviderLink{
		Creator:  operator,
		Provider: provider,
	})
	require.NoError(t, err)

	deal := mode2PolicyTestDeal(1, makePolicyTestAddr(t, f, 0xEE), []string{provider, provider})
	require.NoError(t, f.keeper.Deals.Set(ctx, deal.Id, deal))

	before, err := queryServer.GetProviderCollateral(ctx, &types.QueryGetProviderCollateralRequest{Address: provider})
	require.NoError(t, err)
	require.Equal(t, uint64(2), before.Collateral.TotalAssignments)
	require.Equal(t, uint64(2), before.Collateral.OverassignedAssignments)
	require.False(t, before.Collateral.EligibleForNewAssignment)

	res, err := msgServer.AddProviderBond(ctx, &types.MsgAddProviderBond{
		Creator:  operator,
		Provider: provider,
		Bond:     sdk.NewInt64Coin(sdk.DefaultBondDenom, 75),
	})
	require.NoError(t, err)
	require.True(t, res.Success)

	record, err := f.keeper.Providers.Get(ctx, provider)
	require.NoError(t, err)
	require.Equal(t, "125stake", record.Bond.String())
	require.Equal(t, "125stake", bank.moduleBalances[types.ProviderBondModuleName].String())
	require.Equal(t, "0stake", bank.GetBalance(ctx, operatorAddr, sdk.DefaultBondDenom).String())

	after, err := queryServer.GetProviderCollateral(ctx, &types.QueryGetProviderCollateralRequest{Address: provider})
	require.NoError(t, err)
	require.Equal(t, "125stake", after.Collateral.Bond.String())
	require.Equal(t, uint64(0), after.Collateral.OverassignedAssignments)
	require.Equal(t, uint64(1), after.Collateral.AssignmentHeadroom)
	require.True(t, after.Collateral.EligibleForNewAssignment)
}

func TestWithdrawProviderBondRetainsLockAwareAssignmentCollateral(t *testing.T) {
	bank := newTrackingBankKeeper()
	f := initFixtureWithBankKeeper(t, bank)
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(5)

	params := types.DefaultParams()
	params.MinProviderBond = sdk.NewInt64Coin(sdk.DefaultBondDenom, 50)
	params.AssignmentCollateralPerSlot = sdk.NewInt64Coin(sdk.DefaultBondDenom, 25)
	require.NoError(t, f.keeper.Params.Set(ctx, params))

	provider := makePolicyTestAddr(t, f, 0xA1)
	replacement := makePolicyTestAddr(t, f, 0xB2)
	providerAddr, err := sdk.AccAddressFromBech32(provider)
	require.NoError(t, err)
	bank.setAccountBalance(providerAddr, sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 125)))

	_, err = msgServer.RegisterProvider(ctx, &types.MsgRegisterProvider{
		Creator:      provider,
		Capabilities: "General",
		TotalStorage: 1_000_000_000,
		Endpoints:    testProviderEndpoints,
		Bond:         sdk.NewInt64Coin(sdk.DefaultBondDenom, 125),
	})
	require.NoError(t, err)

	deal := mode2PolicyTestDeal(1, makePolicyTestAddr(t, f, 0xEE), []string{provider, provider})
	for _, slot := range deal.Mode2Slots {
		require.NotNil(t, slot)
		lock := types.AssignmentCollateralLock{
			Provider:       provider,
			DealId:         deal.Id,
			Slot:           slot.Slot,
			Role:           types.AssignmentCollateralLockRole_ASSIGNMENT_COLLATERAL_LOCK_ROLE_ACTIVE,
			Amount:         sdk.NewInt64Coin(sdk.DefaultBondDenom, 25),
			Generation:     deal.CurrentGen,
			LockedAtHeight: ctx.BlockHeight(),
			UpdatedHeight:  ctx.BlockHeight(),
			Reason:         "slot_active",
		}
		require.NoError(t, f.keeper.AssignmentCollateralLocks.Set(ctx, collections.Join(provider, collections.Join(deal.Id, slot.Slot)), lock))
		require.NoError(t, f.keeper.AssignmentCollateralLocksByDeal.Set(ctx, collections.Join(deal.Id, collections.Join(slot.Slot, provider)), true))
	}

	// Drift the deal snapshot after lock creation. A lock-aware withdrawal gate must
	// still retain collateral for the provider's recorded live liabilities.
	for _, slot := range deal.Mode2Slots {
		slot.Provider = replacement
	}
	require.NoError(t, f.keeper.Deals.Set(ctx, deal.Id, deal))

	_, err = msgServer.WithdrawProviderBond(ctx, &types.MsgWithdrawProviderBond{
		Creator:  provider,
		Provider: provider,
		Bond:     sdk.NewInt64Coin(sdk.DefaultBondDenom, 75),
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "would violate required collateral 100stake for 2 active/pending assignments")

	res, err := msgServer.WithdrawProviderBond(ctx, &types.MsgWithdrawProviderBond{
		Creator:  provider,
		Provider: provider,
		Bond:     sdk.NewInt64Coin(sdk.DefaultBondDenom, 25),
	})
	require.NoError(t, err)
	require.True(t, res.Success)

	record, err := f.keeper.Providers.Get(ctx, provider)
	require.NoError(t, err)
	require.Equal(t, "100stake", record.Bond.String())
	require.Equal(t, "100stake", bank.moduleBalances[types.ProviderBondModuleName].String())
	require.Equal(t, "25stake", bank.GetBalance(ctx, providerAddr, sdk.DefaultBondDenom).String())
}

func TestWithdrawProviderBondQueuesAndClaimsAfterUnbondingDelay(t *testing.T) {
	bank := newTrackingBankKeeper()
	f := initFixtureWithBankKeeper(t, bank)
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	queryServer := keeper.NewQueryServerImpl(f.keeper)
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(5)

	params := types.DefaultParams()
	params.MinProviderBond = sdk.NewInt64Coin(sdk.DefaultBondDenom, 50)
	params.ProviderBondUnbondingBlocks = 10
	require.NoError(t, f.keeper.Params.Set(ctx, params))

	provider := makePolicyTestAddr(t, f, 0xA1)
	other := makePolicyTestAddr(t, f, 0xB2)
	providerAddr, err := sdk.AccAddressFromBech32(provider)
	require.NoError(t, err)
	otherAddr, err := sdk.AccAddressFromBech32(other)
	require.NoError(t, err)
	bank.setAccountBalance(providerAddr, sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 125)))
	bank.setAccountBalance(otherAddr, sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 1)))

	_, err = msgServer.RegisterProvider(ctx, &types.MsgRegisterProvider{
		Creator:      provider,
		Capabilities: "General",
		TotalStorage: 1_000_000_000,
		Endpoints:    testProviderEndpoints,
		Bond:         sdk.NewInt64Coin(sdk.DefaultBondDenom, 125),
	})
	require.NoError(t, err)

	res, err := msgServer.WithdrawProviderBond(ctx, &types.MsgWithdrawProviderBond{
		Creator:  provider,
		Provider: provider,
		Bond:     sdk.NewInt64Coin(sdk.DefaultBondDenom, 75),
	})
	require.NoError(t, err)
	require.True(t, res.Success)
	require.Equal(t, uint64(0), res.UnbondingId)
	require.Equal(t, int64(15), res.MatureAtHeight)

	record, err := f.keeper.Providers.Get(ctx, provider)
	require.NoError(t, err)
	require.Equal(t, "50stake", record.Bond.String())
	require.Equal(t, "125stake", bank.moduleBalances[types.ProviderBondModuleName].String())
	require.Equal(t, "0stake", bank.GetBalance(ctx, providerAddr, sdk.DefaultBondDenom).String())

	getRes, err := queryServer.GetProviderBondUnbonding(ctx, &types.QueryGetProviderBondUnbondingRequest{Id: res.UnbondingId})
	require.NoError(t, err)
	require.Equal(t, provider, getRes.Unbonding.Provider)
	require.Equal(t, provider, getRes.Unbonding.Recipient)
	require.Equal(t, "75stake", getRes.Unbonding.Amount.String())
	require.Equal(t, "50stake", getRes.Unbonding.RequiredCollateral.String())

	listRes, err := queryServer.ListProviderBondUnbondingsByProvider(ctx, &types.QueryListProviderBondUnbondingsByProviderRequest{Provider: provider})
	require.NoError(t, err)
	require.Len(t, listRes.Unbondings, 1)
	require.Equal(t, res.UnbondingId, listRes.Unbondings[0].Id)

	_, err = msgServer.ClaimProviderBondWithdrawal(ctx.WithBlockHeight(14), &types.MsgClaimProviderBondWithdrawal{
		Creator:     provider,
		UnbondingId: res.UnbondingId,
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "matures at height 15")

	_, err = msgServer.ClaimProviderBondWithdrawal(ctx.WithBlockHeight(15), &types.MsgClaimProviderBondWithdrawal{
		Creator:     other,
		UnbondingId: res.UnbondingId,
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "not authorized")

	claimRes, err := msgServer.ClaimProviderBondWithdrawal(ctx.WithBlockHeight(15), &types.MsgClaimProviderBondWithdrawal{
		Creator:     provider,
		UnbondingId: res.UnbondingId,
	})
	require.NoError(t, err)
	require.True(t, claimRes.Success)
	require.Equal(t, "50stake", bank.moduleBalances[types.ProviderBondModuleName].String())
	require.Equal(t, "75stake", bank.GetBalance(ctx, providerAddr, sdk.DefaultBondDenom).String())

	_, err = queryServer.GetProviderBondUnbonding(ctx.WithBlockHeight(15), &types.QueryGetProviderBondUnbondingRequest{Id: res.UnbondingId})
	require.Error(t, err)
	listRes, err = queryServer.ListProviderBondUnbondingsByProvider(ctx.WithBlockHeight(15), &types.QueryListProviderBondUnbondingsByProviderRequest{Provider: provider})
	require.NoError(t, err)
	require.Empty(t, listRes.Unbondings)
}

func TestAddProviderBondRejectsUnauthorizedAndInvalidTopUp(t *testing.T) {
	bank := newTrackingBankKeeper()
	f := initFixtureWithBankKeeper(t, bank)
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(1)

	provider := makePolicyTestAddr(t, f, 0xA1)
	other := makePolicyTestAddr(t, f, 0xB2)
	providerAddr, err := sdk.AccAddressFromBech32(provider)
	require.NoError(t, err)
	otherAddr, err := sdk.AccAddressFromBech32(other)
	require.NoError(t, err)
	bank.setAccountBalance(providerAddr, sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 100)))
	bank.setAccountBalance(otherAddr, sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 100)))

	_, err = msgServer.RegisterProvider(ctx, &types.MsgRegisterProvider{
		Creator:      provider,
		Capabilities: "General",
		TotalStorage: 1_000_000_000,
		Endpoints:    testProviderEndpoints,
		Bond:         sdk.NewInt64Coin(sdk.DefaultBondDenom, 10),
	})
	require.NoError(t, err)

	_, err = msgServer.AddProviderBond(ctx, &types.MsgAddProviderBond{
		Creator:  other,
		Provider: provider,
		Bond:     sdk.NewInt64Coin(sdk.DefaultBondDenom, 10),
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "not authorized")

	_, err = msgServer.AddProviderBond(ctx, &types.MsgAddProviderBond{
		Creator:  provider,
		Provider: provider,
		Bond:     sdk.NewInt64Coin(sdk.DefaultBondDenom, 0),
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "must be positive")

	_, err = msgServer.AddProviderBond(ctx, &types.MsgAddProviderBond{
		Creator:  provider,
		Provider: provider,
		Bond:     sdk.NewInt64Coin("otherdenom", 10),
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "provider bond denom")
}

func TestWithdrawProviderBondRejectsUnauthorizedAndInvalidWithdrawal(t *testing.T) {
	bank := newTrackingBankKeeper()
	f := initFixtureWithBankKeeper(t, bank)
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(1)

	provider := makePolicyTestAddr(t, f, 0xA1)
	other := makePolicyTestAddr(t, f, 0xB2)
	providerAddr, err := sdk.AccAddressFromBech32(provider)
	require.NoError(t, err)
	otherAddr, err := sdk.AccAddressFromBech32(other)
	require.NoError(t, err)
	bank.setAccountBalance(providerAddr, sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 100)))
	bank.setAccountBalance(otherAddr, sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 100)))

	_, err = msgServer.RegisterProvider(ctx, &types.MsgRegisterProvider{
		Creator:      provider,
		Capabilities: "General",
		TotalStorage: 1_000_000_000,
		Endpoints:    testProviderEndpoints,
		Bond:         sdk.NewInt64Coin(sdk.DefaultBondDenom, 100),
	})
	require.NoError(t, err)

	_, err = msgServer.WithdrawProviderBond(ctx, &types.MsgWithdrawProviderBond{
		Creator:  other,
		Provider: provider,
		Bond:     sdk.NewInt64Coin(sdk.DefaultBondDenom, 10),
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "not authorized")

	_, err = msgServer.WithdrawProviderBond(ctx, &types.MsgWithdrawProviderBond{
		Creator:  provider,
		Provider: provider,
		Bond:     sdk.NewInt64Coin(sdk.DefaultBondDenom, 0),
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "must be positive")

	_, err = msgServer.WithdrawProviderBond(ctx, &types.MsgWithdrawProviderBond{
		Creator:  provider,
		Provider: provider,
		Bond:     sdk.NewInt64Coin("otherdenom", 10),
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "provider bond denom")

	_, err = msgServer.WithdrawProviderBond(ctx, &types.MsgWithdrawProviderBond{
		Creator:  provider,
		Provider: provider,
		Bond:     sdk.NewInt64Coin(sdk.DefaultBondDenom, 101),
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "exceeds active bond")
}

func TestWithdrawProviderBondRejectsJailedProvider(t *testing.T) {
	bank := newTrackingBankKeeper()
	f := initFixtureWithBankKeeper(t, bank)
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(1)

	provider := makePolicyTestAddr(t, f, 0xA1)
	providerAddr, err := sdk.AccAddressFromBech32(provider)
	require.NoError(t, err)
	bank.setAccountBalance(providerAddr, sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 100)))

	_, err = msgServer.RegisterProvider(ctx, &types.MsgRegisterProvider{
		Creator:      provider,
		Capabilities: "General",
		TotalStorage: 1_000_000_000,
		Endpoints:    testProviderEndpoints,
		Bond:         sdk.NewInt64Coin(sdk.DefaultBondDenom, 100),
	})
	require.NoError(t, err)

	record, err := f.keeper.Providers.Get(ctx, provider)
	require.NoError(t, err)
	record.Status = "Jailed"
	require.NoError(t, f.keeper.Providers.Set(ctx, provider, record))

	_, err = msgServer.WithdrawProviderBond(ctx, &types.MsgWithdrawProviderBond{
		Creator:  provider,
		Provider: provider,
		Bond:     sdk.NewInt64Coin(sdk.DefaultBondDenom, 1),
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "provider is jailed")
	require.Equal(t, "100stake", bank.moduleBalances[types.ProviderBondModuleName].String())
	require.Equal(t, "0stake", bank.GetBalance(ctx, providerAddr, sdk.DefaultBondDenom).String())
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

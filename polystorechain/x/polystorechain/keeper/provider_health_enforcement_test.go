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

func setProviderLifecycleForTest(t *testing.T, f *fixture, ctx sdk.Context, provider string, status types.ProviderLifecycleStatus) {
	t.Helper()

	require.NoError(t, f.keeper.ProviderHealthStates.Set(ctx, provider, types.ProviderHealthState{
		Provider:           provider,
		LifecycleStatus:    status,
		Reason:             "test_provider_health",
		EvidenceClass:      types.EvidenceClass_EVIDENCE_CLASS_CHAIN_MEASURABLE_SOFT,
		Severity:           types.EvidenceSeverity_EVIDENCE_SEVERITY_DELINQUENT,
		UpdatedHeight:      ctx.BlockHeight(),
		ConsequenceCeiling: "test-only lifecycle enforcement",
	}))
}

func TestAssignProvidersSkipsDelinquentProviderHealth(t *testing.T) {
	f := initFixture(t)
	sdkCtx := sdk.UnwrapSDKContext(f.ctx)
	providers := registerCapabilityProviders(t, f, "health_assign", []string{
		"General",
		"General",
		"General",
	})

	setProviderLifecycleForTest(t, f, sdkCtx, providers[0], types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_DELINQUENT)

	assigned, err := f.keeper.AssignProviders(sdkCtx, 91, []byte("health-placement"), "General", 3)
	require.NoError(t, err)
	require.Len(t, assigned, 2)
	require.NotContains(t, assigned, providers[0])
	require.ElementsMatch(t, providers[1:], assigned)
}

func TestAutoProfileEligibleCountSkipsDelinquentProviderHealth(t *testing.T) {
	bank := newTrackingBankKeeper()
	f := initFixtureWithBankKeeper(t, bank)
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	sdkCtx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(2)

	params := types.DefaultParams()
	params.EpochLenBlocks = 10
	params.StoragePrice = math.LegacyMustNewDecFromStr("0.000001")
	require.NoError(t, f.keeper.Params.Set(sdkCtx, params))

	providerA := makePolicyTestAddr(t, f, 0xA1)
	providerB := makePolicyTestAddr(t, f, 0xB2)
	providerC := makePolicyTestAddr(t, f, 0xC3)
	registerPolicyTestProviders(t, f, sdkCtx, providerA, providerB, providerC)
	setProviderLifecycleForTest(t, f, sdkCtx, providerA, types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_DELINQUENT)

	user := makePolicyTestAddr(t, f, 0xEE)
	userAddr, err := sdk.AccAddressFromBech32(user)
	require.NoError(t, err)
	bank.setAccountBalance(userAddr, sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 1_000_000)))

	_, err = msgServer.CreateDeal(sdkCtx, &types.MsgCreateDeal{
		Creator:             user,
		DurationBlocks:      100,
		ServiceHint:         "General",
		MaxMonthlySpend:     math.NewInt(0),
		InitialEscrowAmount: math.NewInt(0),
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "not enough eligible providers")
}

func TestStartSlotRepairRejectsDelinquentProviderHealth(t *testing.T) {
	setup := setupManualSlotRepair(t, "General:rs=8+4")
	setProviderLifecycleForTest(t, setup.f, setup.ctx, setup.candidate, types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_DELINQUENT)

	_, err := setup.msgServer.StartSlotRepair(setup.ctx, &types.MsgStartSlotRepair{
		Creator:         setup.owner,
		DealId:          setup.deal.Id,
		Slot:            0,
		PendingProvider: setup.candidate,
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "pending_provider is not eligible for slot repair")
	require.Contains(t, err.Error(), "provider health lifecycle is DELINQUENT")
}

func TestBaseRewardPoolExcludesDelinquentProviderHealth(t *testing.T) {
	bank := newTrackingBankKeeper()
	f := initFixtureWithBankKeeper(t, bank)
	ctx2, dealID, assignedProviders := setupBaseRewardMode2Deal(t, f, bank, "rhealth")

	deal, err := f.keeper.Deals.Get(ctx2, dealID)
	require.NoError(t, err)
	require.Len(t, deal.Mode2Slots, 3)

	setProviderLifecycleForTest(t, f, ctx2, assignedProviders[0], types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_DELINQUENT)

	epochID := uint64(1)
	for _, slot := range deal.Mode2Slots {
		if slot != nil {
			setMode2BaseRewardCredits(t, f, ctx2, dealID, epochID, slot.Slot)
		}
	}

	ctx10 := ctx2.WithBlockHeight(10)
	require.NoError(t, f.keeper.CheckMissedProofs(ctx10))

	requireProviderBalance(t, bank, assignedProviders[0], "0stake")
	requireProviderBalance(t, bank, assignedProviders[1], "63stake")
	requireProviderBalance(t, bank, assignedProviders[2], "63stake")

	// Health-based reward exclusion should not remove valid liveness credits.
	for _, slot := range deal.Mode2Slots {
		require.NotNil(t, slot)
		credits, err := f.keeper.Mode2EpochCredits.Get(ctx10, collections.Join(collections.Join(dealID, slot.Slot), epochID))
		require.NoError(t, err)
		require.Equal(t, uint64(100), credits)
	}
}

func TestBaseRewardPoolDrainingDoesNotMaskDelinquentProviderHealth(t *testing.T) {
	bank := newTrackingBankKeeper()
	f := initFixtureWithBankKeeper(t, bank)
	ctx2, dealID, assignedProviders := setupBaseRewardMode2Deal(t, f, bank, "rdrainhealth")

	deal, err := f.keeper.Deals.Get(ctx2, dealID)
	require.NoError(t, err)
	require.Len(t, deal.Mode2Slots, 3)

	setProviderLifecycleForTest(t, f, ctx2, assignedProviders[0], types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_DELINQUENT)
	provider, err := f.keeper.Providers.Get(ctx2, assignedProviders[0])
	require.NoError(t, err)
	provider.Draining = true
	require.NoError(t, f.keeper.Providers.Set(ctx2, assignedProviders[0], provider))

	epochID := uint64(1)
	for _, slot := range deal.Mode2Slots {
		if slot != nil {
			setMode2BaseRewardCredits(t, f, ctx2, dealID, epochID, slot.Slot)
		}
	}

	ctx10 := ctx2.WithBlockHeight(10)
	require.NoError(t, f.keeper.CheckMissedProofs(ctx10))

	requireProviderBalance(t, bank, assignedProviders[0], "0stake")
	requireProviderBalance(t, bank, assignedProviders[1], "63stake")
	requireProviderBalance(t, bank, assignedProviders[2], "63stake")
}

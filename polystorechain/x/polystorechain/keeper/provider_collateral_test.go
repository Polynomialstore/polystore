package keeper_test

import (
	"testing"

	"cosmossdk.io/collections"
	"cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkquery "github.com/cosmos/cosmos-sdk/types/query"
	"github.com/stretchr/testify/require"

	"polystorechain/x/polystorechain/keeper"
	"polystorechain/x/polystorechain/types"
)

func setProviderBondForTest(t *testing.T, f *fixture, ctx sdk.Context, providerAddr string, amount int64) {
	t.Helper()

	provider, err := f.keeper.Providers.Get(ctx, providerAddr)
	require.NoError(t, err)
	provider.Bond = sdk.NewInt64Coin(sdk.DefaultBondDenom, amount)
	require.NoError(t, f.keeper.Providers.Set(ctx, providerAddr, provider))
}

func collateralPolicyParams(minBond int64, perSlot int64) types.Params {
	params := types.DefaultParams()
	params.MinProviderBond = sdk.NewInt64Coin(sdk.DefaultBondDenom, minBond)
	params.AssignmentCollateralPerSlot = sdk.NewInt64Coin(sdk.DefaultBondDenom, perSlot)
	return params
}

func TestAssignProvidersRequiresAssignmentCollateralHeadroom(t *testing.T) {
	f := initFixture(t)
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(5)

	providerA := makePolicyTestAddr(t, f, 0xA1)
	providerB := makePolicyTestAddr(t, f, 0xB2)
	registerPolicyTestProviders(t, f, ctx, providerA, providerB)
	require.NoError(t, f.keeper.Params.Set(ctx, collateralPolicyParams(50, 25)))

	setProviderBondForTest(t, f, ctx, providerA, 75)
	setProviderBondForTest(t, f, ctx, providerB, 75)

	existing := mode2PolicyTestDeal(1, makePolicyTestAddr(t, f, 0xEE), []string{providerA})
	require.NoError(t, f.keeper.Deals.Set(ctx, existing.Id, existing))

	assigned, err := f.keeper.AssignProviders(ctx, 2, []byte("collateral-headroom"), "General", 2)
	require.NoError(t, err)
	require.Equal(t, []string{providerB}, assigned)
}

func TestStartSlotRepairRequiresPendingProviderCollateralHeadroom(t *testing.T) {
	setup := setupManualSlotRepair(t, "General:rs=8+4")
	require.NoError(t, setup.f.keeper.Params.Set(setup.ctx, collateralPolicyParams(50, 25)))
	setProviderBondForTest(t, setup.f, setup.ctx, setup.candidate, 75)

	_, err := setup.msgServer.StartSlotRepair(setup.ctx, &types.MsgStartSlotRepair{
		Creator:         setup.owner,
		DealId:          setup.deal.Id,
		Slot:            0,
		PendingProvider: setup.candidate,
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "pending_provider is not eligible for slot repair")
	require.Contains(t, err.Error(), "below required collateral")
}

func TestUnderbondedActiveSlotsEnterRepairAtEpochBoundary(t *testing.T) {
	f := initFixture(t)
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(1)

	providerA := makePolicyTestAddr(t, f, 0xA1)
	providerB := makePolicyTestAddr(t, f, 0xB2)
	providerC := makePolicyTestAddr(t, f, 0xC3)
	providerD := makePolicyTestAddr(t, f, 0xD4)
	registerPolicyTestProviders(t, f, ctx, providerA, providerB, providerC, providerD)

	params := collateralPolicyParams(50, 25)
	params.EpochLenBlocks = 5
	params.EvictAfterMissedEpochs = 0
	require.NoError(t, f.keeper.Params.Set(ctx, params))

	setProviderBondForTest(t, f, ctx, providerA, 75)  // Affordable for one active assignment.
	setProviderBondForTest(t, f, ctx, providerB, 100) // Already serving one slot.
	setProviderBondForTest(t, f, ctx, providerC, 100) // Replacement headroom.
	setProviderBondForTest(t, f, ctx, providerD, 100) // Replacement headroom.

	deal := mode2PolicyTestDeal(1, makePolicyTestAddr(t, f, 0xEE), []string{providerA, providerA, providerB})
	require.NoError(t, f.keeper.Deals.Set(ctx, deal.Id, deal))

	ctxEpoch := ctx.WithBlockHeight(5)
	require.NoError(t, f.keeper.CheckMissedProofs(ctxEpoch))

	updated, err := f.keeper.Deals.Get(ctxEpoch, deal.Id)
	require.NoError(t, err)

	repairingA := 0
	activeA := 0
	for _, slot := range updated.Mode2Slots {
		require.NotNil(t, slot)
		if slot.Provider != providerA {
			continue
		}
		switch slot.Status {
		case types.SlotStatus_SLOT_STATUS_REPAIRING:
			repairingA++
			require.NotEmpty(t, slot.PendingProvider)
			require.NotEqual(t, providerA, slot.PendingProvider)
		case types.SlotStatus_SLOT_STATUS_ACTIVE:
			activeA++
		}
	}
	require.Equal(t, 1, repairingA)
	require.Equal(t, 1, activeA)

	var health types.SlotHealthState
	foundUnderbonded := false
	for _, slotID := range []uint32{0, 1} {
		candidate, err := f.keeper.SlotHealthStates.Get(ctxEpoch, collections.Join(deal.Id, slotID))
		require.NoError(t, err)
		if candidate.Reason == "underbonded_repair_started" {
			health = candidate
			foundUnderbonded = true
			break
		}
	}
	require.True(t, foundUnderbonded)

	repair, err := f.keeper.RepairAttemptStates.Get(ctxEpoch, collections.Join(deal.Id, health.Slot))
	require.NoError(t, err)
	require.Equal(t, "underbonded_repair_started", repair.LastReason)
}

func TestProviderCollateralSummaryQueryReportsHeadroomAndOverassignment(t *testing.T) {
	f := initFixture(t)
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(5)
	queryServer := keeper.NewQueryServerImpl(f.keeper)

	providerA := makePolicyTestAddr(t, f, 0xA1)
	providerB := makePolicyTestAddr(t, f, 0xB2)
	providerC := makePolicyTestAddr(t, f, 0xC3)
	registerPolicyTestProviders(t, f, ctx, providerA, providerB, providerC)
	require.NoError(t, f.keeper.Params.Set(ctx, collateralPolicyParams(50, 25)))

	setProviderBondForTest(t, f, ctx, providerA, 75)
	setProviderBondForTest(t, f, ctx, providerB, 100)
	setProviderBondForTest(t, f, ctx, providerC, 100)

	deal := mode2PolicyTestDeal(1, makePolicyTestAddr(t, f, 0xEE), []string{providerA, providerA, providerB})
	deal.Mode2Slots[2].Status = types.SlotStatus_SLOT_STATUS_REPAIRING
	deal.Mode2Slots[2].PendingProvider = providerC
	require.NoError(t, f.keeper.Deals.Set(ctx, deal.Id, deal))

	res, err := queryServer.GetProviderCollateral(ctx, &types.QueryGetProviderCollateralRequest{Address: providerA})
	require.NoError(t, err)
	require.Equal(t, providerA, res.Collateral.Provider)
	require.Equal(t, uint64(2), res.Collateral.ActiveAssignments)
	require.Equal(t, uint64(0), res.Collateral.PendingAssignments)
	require.Equal(t, uint64(2), res.Collateral.TotalAssignments)
	require.Equal(t, sdk.NewInt64Coin(sdk.DefaultBondDenom, 75), res.Collateral.Bond)
	require.Equal(t, sdk.NewInt64Coin(sdk.DefaultBondDenom, 100), res.Collateral.RequiredCollateral)
	require.Equal(t, uint64(1), res.Collateral.AffordableAssignments)
	require.Equal(t, uint64(1), res.Collateral.OverassignedAssignments)
	require.False(t, res.Collateral.UnlimitedAssignments)
	require.False(t, res.Collateral.EligibleForNewAssignment)
	require.Contains(t, res.Collateral.IneligibilityReason, "below required collateral")

	pendingRes, err := queryServer.GetProviderCollateral(ctx, &types.QueryGetProviderCollateralRequest{Address: providerC})
	require.NoError(t, err)
	require.Equal(t, uint64(0), pendingRes.Collateral.ActiveAssignments)
	require.Equal(t, uint64(1), pendingRes.Collateral.PendingAssignments)
	require.Equal(t, uint64(1), pendingRes.Collateral.TotalAssignments)
	require.Equal(t, sdk.NewInt64Coin(sdk.DefaultBondDenom, 75), pendingRes.Collateral.RequiredCollateral)
	require.Equal(t, uint64(2), pendingRes.Collateral.AffordableAssignments)
	require.Equal(t, uint64(1), pendingRes.Collateral.AssignmentHeadroom)
	require.True(t, pendingRes.Collateral.EligibleForNewAssignment)

	listRes, err := queryServer.ListProviderCollateral(ctx, &types.QueryListProviderCollateralRequest{
		Pagination: &sdkquery.PageRequest{Limit: 10, CountTotal: true},
	})
	require.NoError(t, err)
	require.Equal(t, uint64(3), listRes.Pagination.Total)
	require.Equal(t, uint64(1), findProviderCollateralSummary(t, listRes.Collateral, providerA).OverassignedAssignments)
	require.Equal(t, uint64(1), findProviderCollateralSummary(t, listRes.Collateral, providerC).AssignmentHeadroom)
}

func TestProviderCollateralSummaryUsesAssignmentLockLedgerWhenEnabled(t *testing.T) {
	f := initFixture(t)
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(5)
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	queryServer := keeper.NewQueryServerImpl(f.keeper)

	require.NoError(t, f.keeper.Params.Set(ctx, collateralPolicyParams(0, 25)))
	providers := make([]string, 0, 20)
	for i := 0; i < 20; i++ {
		providers = append(providers, makePolicyTestAddr(t, f, byte(i+1)))
	}
	registerPolicyTestProviders(t, f, ctx, providers...)
	for _, provider := range providers {
		setProviderBondForTest(t, f, ctx, provider, 100)
	}

	owner := makePolicyTestAddr(t, f, 0xEE)
	res, err := msgServer.CreateDeal(ctx, &types.MsgCreateDeal{
		Creator:             owner,
		DurationBlocks:      1000,
		ServiceHint:         "General:rs=8+4",
		InitialEscrowAmount: math.NewInt(1_000_000),
		MaxMonthlySpend:     math.NewInt(500_000),
	})
	require.NoError(t, err)

	locks, err := queryServer.ListAssignmentCollateralLocksByDeal(ctx, &types.QueryListAssignmentCollateralLocksByDealRequest{
		DealId:     res.DealId,
		Pagination: &sdkquery.PageRequest{Limit: 100, CountTotal: true},
	})
	require.NoError(t, err)
	require.NotEmpty(t, locks.Locks)
	provider := locks.Locks[0].Provider
	expectedActive, expectedPending := countAssignmentLocksForProvider(locks.Locks, provider)
	require.Positive(t, expectedActive)

	before, err := queryServer.GetProviderCollateral(ctx, &types.QueryGetProviderCollateralRequest{Address: provider})
	require.NoError(t, err)
	require.Equal(t, expectedActive, before.Collateral.ActiveAssignments)
	require.Equal(t, expectedPending, before.Collateral.PendingAssignments)

	deal, err := f.keeper.Deals.Get(ctx, res.DealId)
	require.NoError(t, err)
	replacement := providers[0]
	if replacement == provider {
		replacement = providers[1]
	}
	mutated := false
	for _, slot := range deal.Mode2Slots {
		if slot != nil && slot.Provider == provider {
			slot.Provider = replacement
			mutated = true
		}
	}
	require.True(t, mutated)
	require.NoError(t, f.keeper.Deals.Set(ctx, deal.Id, deal))

	after, err := queryServer.GetProviderCollateral(ctx, &types.QueryGetProviderCollateralRequest{Address: provider})
	require.NoError(t, err)
	require.Equal(t, expectedActive, after.Collateral.ActiveAssignments)
	require.Equal(t, expectedPending, after.Collateral.PendingAssignments)
	require.Equal(t, before.Collateral.TotalAssignments, after.Collateral.TotalAssignments)
}

func TestProviderCollateralSummaryFallsBackPerDealForPreLockAssignments(t *testing.T) {
	f := initFixture(t)
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(5)
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	queryServer := keeper.NewQueryServerImpl(f.keeper)

	require.NoError(t, f.keeper.Params.Set(ctx, collateralPolicyParams(0, 25)))
	providers := make([]string, 0, 20)
	for i := 0; i < 20; i++ {
		providers = append(providers, makePolicyTestAddr(t, f, byte(i+1)))
	}
	legacyProvider := makePolicyTestAddr(t, f, 0xFA)
	providersWithLegacy := append(append([]string{}, providers...), legacyProvider)
	registerPolicyTestProviders(t, f, ctx, providersWithLegacy...)
	for _, provider := range providersWithLegacy {
		setProviderBondForTest(t, f, ctx, provider, 100)
	}

	owner := makePolicyTestAddr(t, f, 0xEE)
	res, err := msgServer.CreateDeal(ctx, &types.MsgCreateDeal{
		Creator:             owner,
		DurationBlocks:      1000,
		ServiceHint:         "General:rs=8+4",
		InitialEscrowAmount: math.NewInt(1_000_000),
		MaxMonthlySpend:     math.NewInt(500_000),
	})
	require.NoError(t, err)
	locks, err := queryServer.ListAssignmentCollateralLocksByDeal(ctx, &types.QueryListAssignmentCollateralLocksByDealRequest{
		DealId:     res.DealId,
		Pagination: &sdkquery.PageRequest{Limit: 100, CountTotal: true},
	})
	require.NoError(t, err)
	require.NotEmpty(t, locks.Locks)

	legacyDeal := mode2PolicyTestDeal(99, owner, []string{legacyProvider})
	require.NoError(t, f.keeper.Deals.Set(ctx, legacyDeal.Id, legacyDeal))

	legacy, err := queryServer.GetProviderCollateral(ctx, &types.QueryGetProviderCollateralRequest{Address: legacyProvider})
	require.NoError(t, err)
	require.Equal(t, uint64(1), legacy.Collateral.ActiveAssignments)
	require.Equal(t, uint64(0), legacy.Collateral.PendingAssignments)
	require.Equal(t, uint64(1), legacy.Collateral.TotalAssignments)
}

func TestProviderCollateralSummaryIgnoresExpiredAssignmentLocks(t *testing.T) {
	f := initFixture(t)
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(5)
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	queryServer := keeper.NewQueryServerImpl(f.keeper)

	require.NoError(t, f.keeper.Params.Set(ctx, collateralPolicyParams(0, 25)))
	providers := make([]string, 0, 20)
	for i := 0; i < 20; i++ {
		providers = append(providers, makePolicyTestAddr(t, f, byte(i+1)))
	}
	registerPolicyTestProviders(t, f, ctx, providers...)
	for _, provider := range providers {
		setProviderBondForTest(t, f, ctx, provider, 100)
	}

	owner := makePolicyTestAddr(t, f, 0xEE)
	res, err := msgServer.CreateDeal(ctx, &types.MsgCreateDeal{
		Creator:             owner,
		DurationBlocks:      10,
		ServiceHint:         "General:rs=8+4",
		InitialEscrowAmount: math.NewInt(1_000_000),
		MaxMonthlySpend:     math.NewInt(500_000),
	})
	require.NoError(t, err)

	locks, err := queryServer.ListAssignmentCollateralLocksByDeal(ctx, &types.QueryListAssignmentCollateralLocksByDealRequest{
		DealId:     res.DealId,
		Pagination: &sdkquery.PageRequest{Limit: 100, CountTotal: true},
	})
	require.NoError(t, err)
	require.NotEmpty(t, locks.Locks)

	deal, err := f.keeper.Deals.Get(ctx, res.DealId)
	require.NoError(t, err)
	expiredCtx := ctx.WithBlockHeight(int64(deal.EndBlock))
	expired, err := queryServer.GetProviderCollateral(expiredCtx, &types.QueryGetProviderCollateralRequest{Address: locks.Locks[0].Provider})
	require.NoError(t, err)
	require.Equal(t, uint64(0), expired.Collateral.ActiveAssignments)
	require.Equal(t, uint64(0), expired.Collateral.PendingAssignments)
	require.Equal(t, uint64(0), expired.Collateral.TotalAssignments)
}

func TestProviderCollateralSummaryQueryReportsUnlimitedAssignments(t *testing.T) {
	f := initFixture(t)
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(5)
	queryServer := keeper.NewQueryServerImpl(f.keeper)

	providerA := makePolicyTestAddr(t, f, 0xA1)
	registerPolicyTestProviders(t, f, ctx, providerA)
	require.NoError(t, f.keeper.Params.Set(ctx, collateralPolicyParams(50, 0)))
	setProviderBondForTest(t, f, ctx, providerA, 50)

	deal := mode2PolicyTestDeal(1, makePolicyTestAddr(t, f, 0xEE), []string{providerA, providerA})
	require.NoError(t, f.keeper.Deals.Set(ctx, deal.Id, deal))

	res, err := queryServer.GetProviderCollateral(ctx, &types.QueryGetProviderCollateralRequest{Address: providerA})
	require.NoError(t, err)
	require.Equal(t, uint64(2), res.Collateral.TotalAssignments)
	require.Equal(t, sdk.NewInt64Coin(sdk.DefaultBondDenom, 50), res.Collateral.RequiredCollateral)
	require.True(t, res.Collateral.UnlimitedAssignments)
	require.Equal(t, uint64(0), res.Collateral.AssignmentHeadroom)
	require.Equal(t, uint64(0), res.Collateral.OverassignedAssignments)
	require.True(t, res.Collateral.EligibleForNewAssignment)
	require.Empty(t, res.Collateral.IneligibilityReason)
}

func countAssignmentLocksForProvider(locks []types.AssignmentCollateralLock, provider string) (uint64, uint64) {
	var active uint64
	var pending uint64
	for _, lock := range locks {
		if lock.Provider != provider {
			continue
		}
		switch lock.Role {
		case types.AssignmentCollateralLockRole_ASSIGNMENT_COLLATERAL_LOCK_ROLE_ACTIVE:
			active++
		case types.AssignmentCollateralLockRole_ASSIGNMENT_COLLATERAL_LOCK_ROLE_PENDING_REPAIR:
			pending++
		}
	}
	return active, pending
}

func findProviderCollateralSummary(t *testing.T, summaries []types.ProviderCollateralSummary, provider string) types.ProviderCollateralSummary {
	t.Helper()

	for _, summary := range summaries {
		if summary.Provider == provider {
			return summary
		}
	}
	t.Fatalf("provider collateral summary not found for %s", provider)
	return types.ProviderCollateralSummary{}
}

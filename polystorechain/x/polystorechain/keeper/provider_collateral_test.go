package keeper_test

import (
	"testing"

	"cosmossdk.io/collections"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"

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

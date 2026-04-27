package keeper_test

import (
	"strings"
	"testing"

	"cosmossdk.io/collections"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"

	"polystorechain/x/polystorechain/keeper"
	"polystorechain/x/polystorechain/types"
)

func TestAssignProviders_SkipsDrainingProviders(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	sdkCtx := sdk.UnwrapSDKContext(f.ctx)

	mkAddr := func(tag byte) string {
		addr := make([]byte, 20)
		addr[19] = tag
		out, err := f.addressCodec.BytesToString(addr)
		require.NoError(t, err)
		return out
	}

	providerA := mkAddr(0xA1)
	providerB := mkAddr(0xB2)

	for _, addr := range []string{providerA, providerB} {
		_, err := msgServer.RegisterProvider(sdkCtx, &types.MsgRegisterProvider{
			Creator:      addr,
			Capabilities: "General",
			TotalStorage: 1_000_000_000,
			Endpoints:    testProviderEndpoints,
		})
		require.NoError(t, err)
	}

	// Mark providerB as draining.
	p, err := f.keeper.Providers.Get(sdkCtx, providerB)
	require.NoError(t, err)
	p.Draining = true
	require.NoError(t, f.keeper.Providers.Set(sdkCtx, providerB, p))

	assigned, err := f.keeper.AssignProviders(sdkCtx, 1, []byte("blockhash"), "General", 1)
	require.NoError(t, err)
	require.Len(t, assigned, 1)
	require.Equal(t, providerA, assigned[0])
}

func TestCheckMissedProofs_SchedulesDrainRepairs(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	sdkCtx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(5)

	params := types.DefaultParams()
	params.EpochLenBlocks = 5
	params.MaxDrainBytesPerEpoch = 100_000_000 // high enough for test
	params.MaxRepairingBytesRatioBps = 0       // no cap for this test
	require.NoError(t, f.keeper.Params.Set(sdkCtx, params))

	mkAddr := func(tag byte) string {
		addr := make([]byte, 20)
		addr[19] = tag
		out, err := f.addressCodec.BytesToString(addr)
		require.NoError(t, err)
		return out
	}

	providerA := mkAddr(0xA1)
	providerB := mkAddr(0xB2)
	providerC := mkAddr(0xC3)
	providerD := mkAddr(0xD4)

	for _, addr := range []string{providerA, providerB, providerC, providerD} {
		_, err := msgServer.RegisterProvider(sdkCtx, &types.MsgRegisterProvider{
			Creator:      addr,
			Capabilities: "General",
			TotalStorage: 1_000_000_000,
			Endpoints:    testProviderEndpoints,
		})
		require.NoError(t, err)
	}

	// Mark providerA draining.
	p, err := f.keeper.Providers.Get(sdkCtx, providerA)
	require.NoError(t, err)
	p.Draining = true
	require.NoError(t, f.keeper.Providers.Set(sdkCtx, providerA, p))

	dealID := uint64(1)
	deal := types.Deal{
		Id:             dealID,
		Owner:          mkAddr(0xEE),
		StartBlock:     1,
		EndBlock:       10_000,
		RedundancyMode: 2,
		Mode2Profile:   &types.StripeReplicaProfile{K: 2, M: 1},
		Providers:      []string{providerA, providerB, providerC},
		Mode2Slots: []*types.DealSlot{
			{Slot: 0, Provider: providerA, Status: types.SlotStatus_SLOT_STATUS_ACTIVE},
			{Slot: 1, Provider: providerB, Status: types.SlotStatus_SLOT_STATUS_ACTIVE},
			{Slot: 2, Provider: providerC, Status: types.SlotStatus_SLOT_STATUS_ACTIVE},
		},
		TotalMdus:   3,
		WitnessMdus: 1,
		CurrentGen:  1,
		ServiceHint: "General",
	}
	require.NoError(t, f.keeper.Deals.Set(sdkCtx, dealID, deal))

	// Ensure quota is satisfied so slashing doesn't start repairs on its own.
	epochID := uint64(1)
	for _, slot := range []uint32{0, 1, 2} {
		require.NoError(t, f.keeper.Mode2EpochCredits.Set(
			sdkCtx,
			collections.Join(collections.Join(dealID, slot), epochID),
			1,
		))
	}

	require.NoError(t, f.keeper.CheckMissedProofs(sdkCtx))

	updated, err := f.keeper.Deals.Get(sdkCtx, dealID)
	require.NoError(t, err)

	require.Len(t, updated.Mode2Slots, 3)
	slot0 := updated.Mode2Slots[0]
	require.NotNil(t, slot0)
	require.Equal(t, types.SlotStatus_SLOT_STATUS_REPAIRING, slot0.Status)
	require.Equal(t, providerA, slot0.Provider)
	require.Equal(t, providerD, slot0.PendingProvider)

	// Ensure evidence summary was recorded.
	var foundEvidence bool
	require.NoError(t, f.keeper.Proofs.Walk(sdkCtx, nil, func(_ uint64, proof types.Proof) (bool, error) {
		if strings.Contains(proof.Commitment, "evidence:drain_repair_started") {
			foundEvidence = true
			require.Equal(t, providerA, proof.Creator)
			require.False(t, proof.Valid)
		}
		return false, nil
	}))
	require.True(t, foundEvidence)

	_, err = f.keeper.DealActivityStates.Get(sdkCtx, dealID)
	require.ErrorIs(t, err, collections.ErrNotFound)
}

func TestCheckMissedProofs_DrainRepairBackoffWhenNoCandidate(t *testing.T) {
	f := initFixture(t)

	sdkCtx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(5)

	params := types.DefaultParams()
	params.EpochLenBlocks = 5
	params.MaxDrainBytesPerEpoch = 100_000_000
	params.MaxRepairingBytesRatioBps = 0
	require.NoError(t, f.keeper.Params.Set(sdkCtx, params))

	providerA := makePolicyTestAddr(t, f, 0xA1)
	providerB := makePolicyTestAddr(t, f, 0xB2)
	providerC := makePolicyTestAddr(t, f, 0xC3)
	registerPolicyTestProviders(t, f, sdkCtx, providerA, providerB, providerC)

	provider, err := f.keeper.Providers.Get(sdkCtx, providerA)
	require.NoError(t, err)
	provider.Draining = true
	require.NoError(t, f.keeper.Providers.Set(sdkCtx, providerA, provider))

	for _, addr := range []string{providerB, providerC} {
		provider, err := f.keeper.Providers.Get(sdkCtx, addr)
		require.NoError(t, err)
		provider.Status = "Jailed"
		require.NoError(t, f.keeper.Providers.Set(sdkCtx, addr, provider))
	}

	dealID := uint64(1)
	deal := mode2PolicyTestDeal(dealID, makePolicyTestAddr(t, f, 0xEE), []string{providerA, providerB, providerC})
	require.NoError(t, f.keeper.Deals.Set(sdkCtx, dealID, deal))

	epochID := uint64(1)
	setMode2EpochCredits(t, f, sdkCtx, dealID, epochID, 0, 1, 2)

	require.NoError(t, f.keeper.CheckMissedProofs(sdkCtx))

	updated, err := f.keeper.Deals.Get(sdkCtx, dealID)
	require.NoError(t, err)
	slot0 := updated.Mode2Slots[0]
	require.NotNil(t, slot0)
	require.Equal(t, types.SlotStatus_SLOT_STATUS_ACTIVE, slot0.Status)
	require.Empty(t, slot0.PendingProvider)
	require.True(t, hasEvidenceSummary(t, f, sdkCtx, "repair_backoff_entered"))
	require.False(t, hasEvidenceSummary(t, f, sdkCtx, "drain_repair_started"))
}

func TestCheckMissedProofs_DrainRepairsSkipSlotsDuringCooldown(t *testing.T) {
	f := initFixture(t)

	sdkCtx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(5)

	params := types.DefaultParams()
	params.EpochLenBlocks = 5
	params.MaxDrainBytesPerEpoch = 100_000_000
	params.MaxRepairingBytesRatioBps = 0
	require.NoError(t, f.keeper.Params.Set(sdkCtx, params))

	providerA := makePolicyTestAddr(t, f, 0xA1)
	providerB := makePolicyTestAddr(t, f, 0xB2)
	providerC := makePolicyTestAddr(t, f, 0xC3)
	providerD := makePolicyTestAddr(t, f, 0xD4)
	registerPolicyTestProviders(t, f, sdkCtx, providerA, providerB, providerC, providerD)

	provider, err := f.keeper.Providers.Get(sdkCtx, providerA)
	require.NoError(t, err)
	provider.Draining = true
	require.NoError(t, f.keeper.Providers.Set(sdkCtx, providerA, provider))

	dealID := uint64(1)
	deal := mode2PolicyTestDeal(dealID, makePolicyTestAddr(t, f, 0xEE), []string{providerA, providerB, providerC})
	require.NoError(t, f.keeper.Deals.Set(sdkCtx, dealID, deal))

	epochID := uint64(1)
	setMode2EpochCredits(t, f, sdkCtx, dealID, epochID, 0, 1, 2)
	require.NoError(t, f.keeper.RepairAttemptStates.Set(sdkCtx, collections.Join(dealID, uint32(0)), types.RepairAttemptState{
		DealId:             dealID,
		Slot:               0,
		Provider:           providerA,
		CooldownUntilEpoch: epochID,
		LastReason:         "repair_backoff_entered",
	}))

	require.NoError(t, f.keeper.CheckMissedProofs(sdkCtx))

	updated, err := f.keeper.Deals.Get(sdkCtx, dealID)
	require.NoError(t, err)
	slot0 := updated.Mode2Slots[0]
	require.NotNil(t, slot0)
	require.Equal(t, types.SlotStatus_SLOT_STATUS_ACTIVE, slot0.Status)
	require.Empty(t, slot0.PendingProvider)
	require.False(t, hasEvidenceSummary(t, f, sdkCtx, "drain_repair_started"))
}

package keeper_test

import (
	"strings"
	"testing"

	"cosmossdk.io/collections"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"

	"nilchain/x/nilchain/keeper"
	"nilchain/x/nilchain/types"
)

func TestCheckMissedProofs_StartsMode2SlotRepair(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	sdkCtx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(5)

	params := types.DefaultParams()
	params.EpochLenBlocks = 5
	params.EvictAfterMissedEpochs = 1
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

	epochID := uint64(1)
	require.NoError(t, f.keeper.Mode2EpochCredits.Set(
		sdkCtx,
		collections.Join(collections.Join(dealID, uint32(1)), epochID),
		1,
	))
	require.NoError(t, f.keeper.Mode2EpochCredits.Set(
		sdkCtx,
		collections.Join(collections.Join(dealID, uint32(2)), epochID),
		1,
	))

	require.NoError(t, f.keeper.CheckMissedProofs(sdkCtx))

	updated, err := f.keeper.Deals.Get(sdkCtx, dealID)
	require.NoError(t, err)

	require.Len(t, updated.Mode2Slots, 3)
	slot0 := updated.Mode2Slots[0]
	require.NotNil(t, slot0)
	require.Equal(t, types.SlotStatus_SLOT_STATUS_REPAIRING, slot0.Status)
	require.Equal(t, providerA, slot0.Provider)
	require.Equal(t, providerD, slot0.PendingProvider)
	require.Equal(t, int64(5), slot0.StatusSinceHeight)
	require.Equal(t, uint64(1), slot0.RepairTargetGen)

	require.Equal(t, types.SlotStatus_SLOT_STATUS_ACTIVE, updated.Mode2Slots[1].Status)
	require.Equal(t, "", updated.Mode2Slots[1].PendingProvider)
	require.Equal(t, types.SlotStatus_SLOT_STATUS_ACTIVE, updated.Mode2Slots[2].Status)
	require.Equal(t, "", updated.Mode2Slots[2].PendingProvider)

	var foundEvidence bool
	require.NoError(t, f.keeper.Proofs.Walk(sdkCtx, nil, func(_ uint64, proof types.Proof) (bool, error) {
		if strings.Contains(proof.Commitment, "evidence:quota_miss_repair_started") {
			foundEvidence = true
			require.Equal(t, providerA, proof.Creator)
			require.False(t, proof.Valid)
		}
		return false, nil
	}))
	require.True(t, foundEvidence)
}

func TestCheckMissedProofs_Mode2RepairFallbackReusesProvider(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	sdkCtx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(5)

	params := types.DefaultParams()
	params.EpochLenBlocks = 5
	params.EvictAfterMissedEpochs = 1
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

	for _, addr := range []string{providerA, providerB, providerC} {
		_, err := msgServer.RegisterProvider(sdkCtx, &types.MsgRegisterProvider{
			Creator:      addr,
			Capabilities: "General",
			TotalStorage: 1_000_000_000,
			Endpoints:    testProviderEndpoints,
		})
		require.NoError(t, err)
	}

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

	epochID := uint64(1)
	require.NoError(t, f.keeper.Mode2EpochCredits.Set(
		sdkCtx,
		collections.Join(collections.Join(dealID, uint32(1)), epochID),
		1,
	))
	require.NoError(t, f.keeper.Mode2EpochCredits.Set(
		sdkCtx,
		collections.Join(collections.Join(dealID, uint32(2)), epochID),
		1,
	))

	require.NoError(t, f.keeper.CheckMissedProofs(sdkCtx))

	updated, err := f.keeper.Deals.Get(sdkCtx, dealID)
	require.NoError(t, err)

	require.Len(t, updated.Mode2Slots, 3)
	slot0 := updated.Mode2Slots[0]
	require.NotNil(t, slot0)
	require.Equal(t, types.SlotStatus_SLOT_STATUS_REPAIRING, slot0.Status)
	require.Equal(t, providerA, slot0.Provider)
	require.NotEmpty(t, slot0.PendingProvider)
	require.NotEqual(t, providerA, slot0.PendingProvider)
	require.Contains(t, []string{providerB, providerC}, slot0.PendingProvider)
}

func TestCheckMissedProofs_CompletesMode2SlotRepairWhenQuotaMet(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	sdkCtx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(5)

	params := types.DefaultParams()
	params.EpochLenBlocks = 5
	params.EvictAfterMissedEpochs = 3
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
			{Slot: 0, Provider: providerA, Status: types.SlotStatus_SLOT_STATUS_REPAIRING, PendingProvider: providerD, StatusSinceHeight: 4, RepairTargetGen: 1},
			{Slot: 1, Provider: providerB, Status: types.SlotStatus_SLOT_STATUS_ACTIVE},
			{Slot: 2, Provider: providerC, Status: types.SlotStatus_SLOT_STATUS_ACTIVE},
		},
		TotalMdus:   3,
		WitnessMdus: 1,
		CurrentGen:  1,
		ServiceHint: "General",
	}
	require.NoError(t, f.keeper.Deals.Set(sdkCtx, dealID, deal))

	epochID := uint64(1)
	// Quota is expected to be >=1 for this tiny deal; synth=1 should satisfy it
	// under default params for the PoC repair completion flow.
	require.NoError(t, f.keeper.Mode2EpochSynthetic.Set(
		sdkCtx,
		collections.Join(collections.Join(dealID, uint32(0)), epochID),
		1,
	))

	require.NoError(t, f.keeper.CheckMissedProofs(sdkCtx))

	updated, err := f.keeper.Deals.Get(sdkCtx, dealID)
	require.NoError(t, err)

	require.Len(t, updated.Mode2Slots, 3)
	slot0 := updated.Mode2Slots[0]
	require.NotNil(t, slot0)
	require.Equal(t, types.SlotStatus_SLOT_STATUS_ACTIVE, slot0.Status)
	require.Equal(t, providerD, slot0.Provider)
	require.Equal(t, "", slot0.PendingProvider)
	require.Equal(t, providerD, updated.Providers[0])
	require.Equal(t, uint64(2), updated.CurrentGen)

	var foundEvidence bool
	require.NoError(t, f.keeper.Proofs.Walk(sdkCtx, nil, func(_ uint64, proof types.Proof) (bool, error) {
		if strings.Contains(proof.Commitment, "evidence:slot_repair_completed") {
			foundEvidence = true
			require.Equal(t, providerA, proof.Creator)
			require.True(t, proof.Valid)
		}
		return false, nil
	}))
	require.True(t, foundEvidence)
}

func TestCheckMissedProofs_DeputyServedTriggersRepairEvenIfQuotaMet(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	sdkCtx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(5)

	params := types.DefaultParams()
	params.EpochLenBlocks = 5
	params.EvictAfterMissedEpochs = 1
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

	epochID := uint64(1)
	// Even if the slot meets its quota via system proofs + synthetic fill, deputy-served
	// retrievals with zero slot-served retrievals should trigger repair.
	require.NoError(t, f.keeper.Mode2EpochCredits.Set(
		sdkCtx,
		collections.Join(collections.Join(dealID, uint32(0)), epochID),
		10,
	))
	require.NoError(t, f.keeper.Mode2EpochSynthetic.Set(
		sdkCtx,
		collections.Join(collections.Join(dealID, uint32(0)), epochID),
		10,
	))
	// Slot 0 was served by a deputy (but the slot provider served no retrievals).
	require.NoError(t, f.keeper.Mode2EpochDeputyServed.Set(
		sdkCtx,
		collections.Join(collections.Join(dealID, uint32(0)), epochID),
		1,
	))

	require.NoError(t, f.keeper.CheckMissedProofs(sdkCtx))

	updated, err := f.keeper.Deals.Get(sdkCtx, dealID)
	require.NoError(t, err)

	require.Len(t, updated.Mode2Slots, 3)
	slot0 := updated.Mode2Slots[0]
	require.NotNil(t, slot0)
	require.Equal(t, types.SlotStatus_SLOT_STATUS_REPAIRING, slot0.Status)
	require.Equal(t, providerA, slot0.Provider)
	require.Equal(t, providerD, slot0.PendingProvider)

	var foundEvidence bool
	require.NoError(t, f.keeper.Proofs.Walk(sdkCtx, nil, func(_ uint64, proof types.Proof) (bool, error) {
		if strings.Contains(proof.Commitment, "evidence:deputy_miss_repair_started") {
			foundEvidence = true
			require.Equal(t, providerA, proof.Creator)
			require.False(t, proof.Valid)
		}
		return false, nil
	}))
	require.True(t, foundEvidence)
}

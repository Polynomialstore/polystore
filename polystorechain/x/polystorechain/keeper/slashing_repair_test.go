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

func makePolicyTestAddr(t *testing.T, f *fixture, tag byte) string {
	t.Helper()

	addr := make([]byte, 20)
	addr[19] = tag
	out, err := f.addressCodec.BytesToString(addr)
	require.NoError(t, err)
	return out
}

func registerPolicyTestProviders(t *testing.T, f *fixture, ctx sdk.Context, addrs ...string) {
	t.Helper()

	msgServer := keeper.NewMsgServerImpl(f.keeper)
	for _, addr := range addrs {
		_, err := msgServer.RegisterProvider(ctx, &types.MsgRegisterProvider{
			Creator:      addr,
			Capabilities: "General",
			TotalStorage: 1_000_000_000,
			Endpoints:    testProviderEndpoints,
		})
		require.NoError(t, err)
	}
}

func mode2PolicyTestDeal(dealID uint64, owner string, providers []string) types.Deal {
	slots := make([]*types.DealSlot, 0, len(providers))
	for i, provider := range providers {
		slots = append(slots, &types.DealSlot{
			Slot:     uint32(i),
			Provider: provider,
			Status:   types.SlotStatus_SLOT_STATUS_ACTIVE,
		})
	}

	return types.Deal{
		Id:             dealID,
		Owner:          owner,
		StartBlock:     1,
		EndBlock:       10_000,
		RedundancyMode: 2,
		Mode2Profile:   &types.StripeReplicaProfile{K: 2, M: 1},
		Providers:      providers,
		Mode2Slots:     slots,
		TotalMdus:      3,
		WitnessMdus:    1,
		CurrentGen:     1,
		ServiceHint:    "General",
	}
}

func setMode2EpochCredits(t *testing.T, f *fixture, ctx sdk.Context, dealID uint64, epochID uint64, slots ...uint32) {
	t.Helper()

	for _, slot := range slots {
		require.NoError(t, f.keeper.Mode2EpochCredits.Set(
			ctx,
			collections.Join(collections.Join(dealID, slot), epochID),
			1,
		))
	}
}

func hasEvidenceSummary(t *testing.T, f *fixture, ctx sdk.Context, kind string) bool {
	t.Helper()

	var found bool
	require.NoError(t, f.keeper.Proofs.Walk(ctx, nil, func(_ uint64, proof types.Proof) (bool, error) {
		if strings.Contains(proof.Commitment, "evidence:"+kind) {
			found = true
		}
		return false, nil
	}))
	return found
}

func requireNoPolicyRepairEvidence(t *testing.T, f *fixture, ctx sdk.Context) {
	t.Helper()

	for _, kind := range []string{
		"quota_miss_repair_started",
		"deputy_miss_repair_started",
		"slot_repair_completed",
	} {
		require.False(t, hasEvidenceSummary(t, f, ctx, kind), "unexpected evidence summary: %s", kind)
	}
}

func TestCheckMissedProofs_Mode2HealthySlotsDoNotRepairOrEmitEvidence(t *testing.T) {
	f := initFixture(t)

	sdkCtx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(5)

	params := types.DefaultParams()
	params.EpochLenBlocks = 5
	params.EvictAfterMissedEpochs = 1
	require.NoError(t, f.keeper.Params.Set(sdkCtx, params))

	providerA := makePolicyTestAddr(t, f, 0xA1)
	providerB := makePolicyTestAddr(t, f, 0xB2)
	providerC := makePolicyTestAddr(t, f, 0xC3)
	providerD := makePolicyTestAddr(t, f, 0xD4)
	registerPolicyTestProviders(t, f, sdkCtx, providerA, providerB, providerC, providerD)

	dealID := uint64(1)
	deal := mode2PolicyTestDeal(dealID, makePolicyTestAddr(t, f, 0xEE), []string{providerA, providerB, providerC})
	require.NoError(t, f.keeper.Deals.Set(sdkCtx, dealID, deal))

	epochID := uint64(1)
	setMode2EpochCredits(t, f, sdkCtx, dealID, epochID, 0, 1, 2)

	require.NoError(t, f.keeper.CheckMissedProofs(sdkCtx))

	updated, err := f.keeper.Deals.Get(sdkCtx, dealID)
	require.NoError(t, err)
	require.Equal(t, uint64(1), updated.CurrentGen)
	require.Len(t, updated.Mode2Slots, 3)
	for idx, slot := range updated.Mode2Slots {
		require.NotNil(t, slot)
		require.Equal(t, types.SlotStatus_SLOT_STATUS_ACTIVE, slot.Status, "slot %d", idx)
		require.Empty(t, slot.PendingProvider, "slot %d", idx)

		missedKey := collections.Join(dealID, uint32(idx))
		_, err = f.keeper.Mode2MissedEpochs.Get(sdkCtx, missedKey)
		require.ErrorIs(t, err, collections.ErrNotFound)
		_, err = f.keeper.Mode2DeputyMissedEpochs.Get(sdkCtx, missedKey)
		require.ErrorIs(t, err, collections.ErrNotFound)
	}
	require.Equal(t, []string{providerA, providerB, providerC}, updated.Providers)
	requireNoPolicyRepairEvidence(t, f, sdkCtx)
}

func TestCheckMissedProofs_Mode2QuotaMissWaitsForThreshold(t *testing.T) {
	f := initFixture(t)

	sdkCtx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(5)

	params := types.DefaultParams()
	params.EpochLenBlocks = 5
	params.EvictAfterMissedEpochs = 2
	require.NoError(t, f.keeper.Params.Set(sdkCtx, params))

	providerA := makePolicyTestAddr(t, f, 0xA1)
	providerB := makePolicyTestAddr(t, f, 0xB2)
	providerC := makePolicyTestAddr(t, f, 0xC3)
	providerD := makePolicyTestAddr(t, f, 0xD4)
	registerPolicyTestProviders(t, f, sdkCtx, providerA, providerB, providerC, providerD)

	dealID := uint64(1)
	deal := mode2PolicyTestDeal(dealID, makePolicyTestAddr(t, f, 0xEE), []string{providerA, providerB, providerC})
	require.NoError(t, f.keeper.Deals.Set(sdkCtx, dealID, deal))

	missedKey := collections.Join(dealID, uint32(0))

	setMode2EpochCredits(t, f, sdkCtx, dealID, 1, 1, 2)
	require.NoError(t, f.keeper.CheckMissedProofs(sdkCtx))

	afterFirst, err := f.keeper.Deals.Get(sdkCtx, dealID)
	require.NoError(t, err)
	require.Equal(t, types.SlotStatus_SLOT_STATUS_ACTIVE, afterFirst.Mode2Slots[0].Status)
	require.Empty(t, afterFirst.Mode2Slots[0].PendingProvider)
	missed, err := f.keeper.Mode2MissedEpochs.Get(sdkCtx, missedKey)
	require.NoError(t, err)
	require.Equal(t, uint64(1), missed)
	require.False(t, hasEvidenceSummary(t, f, sdkCtx, "quota_miss_repair_started"))

	sdkCtx = sdkCtx.WithBlockHeight(10)
	setMode2EpochCredits(t, f, sdkCtx, dealID, 2, 1, 2)
	require.NoError(t, f.keeper.CheckMissedProofs(sdkCtx))

	updated, err := f.keeper.Deals.Get(sdkCtx, dealID)
	require.NoError(t, err)

	require.Len(t, updated.Mode2Slots, 3)
	slot0 := updated.Mode2Slots[0]
	require.NotNil(t, slot0)
	require.Equal(t, types.SlotStatus_SLOT_STATUS_REPAIRING, slot0.Status)
	require.Equal(t, providerA, slot0.Provider)
	require.Equal(t, providerD, slot0.PendingProvider)
	require.Equal(t, int64(10), slot0.StatusSinceHeight)
	require.Equal(t, uint64(1), slot0.RepairTargetGen)

	_, err = f.keeper.Mode2MissedEpochs.Get(sdkCtx, missedKey)
	require.ErrorIs(t, err, collections.ErrNotFound)
	require.True(t, hasEvidenceSummary(t, f, sdkCtx, "quota_miss_repair_started"))

	// Soft quota-miss repair is make-before-break: the outgoing provider remains
	// registered and active until a separate hard-fault path changes provider status.
	registeredProvider, err := f.keeper.Providers.Get(sdkCtx, providerA)
	require.NoError(t, err)
	require.Equal(t, "Active", registeredProvider.Status)
	require.False(t, registeredProvider.Draining)
}

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

	activity, err := f.keeper.DealActivityStates.Get(sdkCtx, dealID)
	require.NoError(t, err)
	require.GreaterOrEqual(t, activity.FailedChallengesTotal, uint64(1))
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

	activity, err := f.keeper.DealActivityStates.Get(sdkCtx, dealID)
	require.NoError(t, err)
	require.GreaterOrEqual(t, activity.FailedChallengesTotal, uint64(1))
}

package keeper_test

import (
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
}

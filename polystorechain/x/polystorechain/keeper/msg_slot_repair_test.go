package keeper_test

import (
	"fmt"
	"testing"

	"cosmossdk.io/collections"
	"cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"

	"polystorechain/x/polystorechain/keeper"
	"polystorechain/x/polystorechain/types"
)

type manualSlotRepairSetup struct {
	f         *fixture
	msgServer types.MsgServer
	ctx       sdk.Context
	deal      types.Deal
	owner     string
	candidate string
}

func setupManualSlotRepair(t *testing.T, serviceHint string) manualSlotRepairSetup {
	t.Helper()

	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(5)

	for i := 0; i < 20; i++ {
		addrBz := make([]byte, 20)
		copy(addrBz, []byte(fmt.Sprintf("repair_elig_p_%02d", i)))
		addr, _ := f.addressCodec.BytesToString(addrBz)
		_, err := msgServer.RegisterProvider(ctx, &types.MsgRegisterProvider{
			Creator:      addr,
			Capabilities: "General",
			TotalStorage: 100000000000,
			Endpoints:    testProviderEndpoints,
		})
		require.NoError(t, err)
	}

	ownerBz := make([]byte, 20)
	copy(ownerBz, []byte("repair_elig_owner"))
	owner, _ := f.addressCodec.BytesToString(ownerBz)

	res, err := msgServer.CreateDeal(ctx, &types.MsgCreateDeal{
		Creator:             owner,
		DurationBlocks:      1000,
		ServiceHint:         serviceHint,
		MaxMonthlySpend:     math.NewInt(500000),
		InitialEscrowAmount: math.NewInt(1000000),
	})
	require.NoError(t, err)

	deal, err := f.keeper.Deals.Get(ctx, res.DealId)
	require.NoError(t, err)
	require.Len(t, deal.Mode2Slots, int(types.DealBaseReplication))
	require.NotEqual(t, deal.Mode2Slots[0].Provider, deal.Mode2Slots[1].Provider)

	return manualSlotRepairSetup{
		f:         f,
		msgServer: msgServer,
		ctx:       ctx,
		deal:      deal,
		owner:     owner,
		candidate: deal.Mode2Slots[1].Provider,
	}
}

func TestStartSlotRepairClearsStaleReadiness(t *testing.T) {
	setup := setupManualSlotRepair(t, "General:rs=8+4")

	markMode2RepairReadyForTest(t, setup.f, setup.ctx, setup.deal.Id, 0, 0)

	_, err := setup.msgServer.StartSlotRepair(setup.ctx, &types.MsgStartSlotRepair{
		Creator:         setup.owner,
		DealId:          setup.deal.Id,
		Slot:            0,
		PendingProvider: setup.candidate,
	})
	require.NoError(t, err)

	_, err = setup.f.keeper.Mode2RepairReadiness.Get(setup.ctx, collections.Join(setup.deal.Id, uint32(0)))
	require.ErrorIs(t, err, collections.ErrNotFound)
}

func TestCompleteSlotRepairRejectsStaleReadinessGeneration(t *testing.T) {
	setup := setupManualSlotRepair(t, "General:rs=8+4")

	_, err := setup.msgServer.StartSlotRepair(setup.ctx, &types.MsgStartSlotRepair{
		Creator:         setup.owner,
		DealId:          setup.deal.Id,
		Slot:            0,
		PendingProvider: setup.candidate,
	})
	require.NoError(t, err)

	deal, err := setup.f.keeper.Deals.Get(setup.ctx, setup.deal.Id)
	require.NoError(t, err)
	targetGen := deal.Mode2Slots[0].RepairTargetGen
	require.NoError(t, setup.f.keeper.Mode2RepairReadiness.Set(
		setup.ctx,
		collections.Join(setup.deal.Id, uint32(0)),
		targetGen+2,
	))

	_, err = setup.msgServer.CompleteSlotRepair(setup.ctx, &types.MsgCompleteSlotRepair{
		Creator: setup.candidate,
		DealId:  setup.deal.Id,
		Slot:    0,
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "slot repair is not ready")

	deal, err = setup.f.keeper.Deals.Get(setup.ctx, setup.deal.Id)
	require.NoError(t, err)
	require.Equal(t, types.SlotStatus_SLOT_STATUS_REPAIRING, deal.Mode2Slots[0].Status)
	require.Equal(t, setup.candidate, deal.Mode2Slots[0].PendingProvider)
}

func TestStartSlotRepairRejectsIneligiblePendingProvider(t *testing.T) {
	tests := []struct {
		name        string
		serviceHint string
		mutate      func(t *testing.T, setup manualSlotRepairSetup)
		wantReason  string
	}{
		{
			name:        "non active provider",
			serviceHint: "General:rs=8+4",
			mutate: func(t *testing.T, setup manualSlotRepairSetup) {
				t.Helper()
				provider, err := setup.f.keeper.Providers.Get(setup.ctx, setup.candidate)
				require.NoError(t, err)
				provider.Status = "Jailed"
				require.NoError(t, setup.f.keeper.Providers.Set(setup.ctx, setup.candidate, provider))
			},
			wantReason: "status is not Active",
		},
		{
			name:        "draining provider",
			serviceHint: "General:rs=8+4",
			mutate: func(t *testing.T, setup manualSlotRepairSetup) {
				t.Helper()
				_, err := setup.msgServer.SetProviderDraining(setup.ctx, &types.MsgSetProviderDraining{
					Creator:  setup.candidate,
					Draining: true,
				})
				require.NoError(t, err)
			},
			wantReason: "provider is draining",
		},
		{
			name:        "service incompatible provider",
			serviceHint: "Hot:rs=8+4",
			mutate: func(t *testing.T, setup manualSlotRepairSetup) {
				t.Helper()
				provider, err := setup.f.keeper.Providers.Get(setup.ctx, setup.candidate)
				require.NoError(t, err)
				provider.Capabilities = "Archive"
				require.NoError(t, setup.f.keeper.Providers.Set(setup.ctx, setup.candidate, provider))
			},
			wantReason: "provider does not match service hint",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			setup := setupManualSlotRepair(t, tc.serviceHint)
			tc.mutate(t, setup)

			_, err := setup.msgServer.StartSlotRepair(setup.ctx, &types.MsgStartSlotRepair{
				Creator:         setup.owner,
				DealId:          setup.deal.Id,
				Slot:            0,
				PendingProvider: setup.candidate,
			})
			require.Error(t, err)
			require.Contains(t, err.Error(), "pending_provider is not eligible for slot repair")
			require.Contains(t, err.Error(), tc.wantReason)

			deal, getErr := setup.f.keeper.Deals.Get(setup.ctx, setup.deal.Id)
			require.NoError(t, getErr)
			require.Equal(t, types.SlotStatus_SLOT_STATUS_ACTIVE, deal.Mode2Slots[0].Status)
			require.Empty(t, deal.Mode2Slots[0].PendingProvider)
		})
	}
}

package keeper_test

import (
	"strings"
	"testing"

	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"

	"nilchain/x/nilchain/keeper"
	"nilchain/x/nilchain/types"
)

func TestProveLiveness_HealthFailures_StartMode2Repair(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	params := types.DefaultParams()
	params.EpochLenBlocks = 5
	require.NoError(t, f.keeper.Params.Set(f.ctx, params))

	sdkCtx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(1)

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

	// Submit 3 invalid system proofs. The payload is nil, which is considered invalid
	// but should not revert the tx (it returns Success=false). After 3 failures, the
	// chain should start a Mode 2 repair by attaching a pending provider.
	for i := 0; i < 3; i++ {
		res, err := msgServer.ProveLiveness(sdkCtx, &types.MsgProveLiveness{
			Creator:  providerA,
			DealId:   dealID,
			EpochId:  1,
			ProofType: &types.MsgProveLiveness_SystemProof{SystemProof: nil},
		})
		require.NoError(t, err)
		require.False(t, res.Success)
	}

	updated, err := f.keeper.Deals.Get(sdkCtx, dealID)
	require.NoError(t, err)

	require.Len(t, updated.Mode2Slots, 3)
	slot0 := updated.Mode2Slots[0]
	require.NotNil(t, slot0)
	require.Equal(t, types.SlotStatus_SLOT_STATUS_REPAIRING, slot0.Status)
	require.Equal(t, providerD, slot0.PendingProvider)

	var foundEvidence bool
	require.NoError(t, f.keeper.Proofs.Walk(sdkCtx, nil, func(_ uint64, proof types.Proof) (bool, error) {
		if strings.Contains(proof.Commitment, "evidence:provider_degraded_repair_started") {
			foundEvidence = true
			require.Equal(t, providerA, proof.Creator)
			require.False(t, proof.Valid)
		}
		return false, nil
	}))
	require.True(t, foundEvidence)
}


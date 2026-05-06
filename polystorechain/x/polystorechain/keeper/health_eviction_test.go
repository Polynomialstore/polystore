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

func invalidPolicyChainedProof() *types.ChainedProof {
	return &types.ChainedProof{
		MduIndex:        0,
		MduRootFr:       make([]byte, 32),
		ManifestOpening: make([]byte, 48),
		BlobCommitment:  make([]byte, 48),
		MerklePath:      [][]byte{make([]byte, 32)},
		BlobIndex:       0,
		ZValue:          make([]byte, 32),
		YValue:          make([]byte, 32),
		KzgOpeningProof: make([]byte, 48),
	}
}

func TestProveLiveness_InvalidSystemProofRecordsHardEvidenceWithoutPayment(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	params := types.DefaultParams()
	params.EpochLenBlocks = 5
	require.NoError(t, f.keeper.Params.Set(f.ctx, params))

	sdkCtx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(1)

	providerA := makePolicyTestAddr(t, f, 0xA1)
	providerB := makePolicyTestAddr(t, f, 0xB2)
	providerC := makePolicyTestAddr(t, f, 0xC3)
	providerD := makePolicyTestAddr(t, f, 0xD4)
	registerPolicyTestProviders(t, f, sdkCtx, providerA, providerB, providerC, providerD)
	beforeProvider, err := f.keeper.Providers.Get(sdkCtx, providerA)
	require.NoError(t, err)
	beforeReputation := beforeProvider.ReputationScore

	dealID := uint64(1)
	deal := mode2PolicyTestDeal(dealID, makePolicyTestAddr(t, f, 0xEE), []string{providerA, providerB, providerC})
	require.NoError(t, f.keeper.Deals.Set(sdkCtx, dealID, deal))

	res, err := msgServer.ProveLiveness(sdkCtx, &types.MsgProveLiveness{
		Creator: providerA,
		DealId:  dealID,
		EpochId: 1,
		ProofType: &types.MsgProveLiveness_SystemProof{
			SystemProof: invalidPolicyChainedProof(),
		},
	})
	require.NoError(t, err)
	require.False(t, res.Success)
	require.Equal(t, uint32(3), res.Tier)
	require.Equal(t, "0", res.RewardAmount)

	failures, err := f.keeper.DealProviderFailures.Get(sdkCtx, collections.Join(dealID, providerA))
	require.NoError(t, err)
	require.Equal(t, uint64(1), failures)

	evidence := requireEvidenceSummary(t, f, sdkCtx, "system_proof_invalid")
	require.Equal(t, providerA, evidence.Creator)
	require.False(t, evidence.Valid)
	require.Contains(t, evidence.Commitment, "deal=1")
	require.Contains(t, evidence.Commitment, "provider="+providerA)
	evidenceCase := requireEvidenceCase(t, f, sdkCtx, "system_proof_invalid")
	require.Equal(t, types.EvidenceCaseStatus_EVIDENCE_CASE_STATUS_CONVICTED, evidenceCase.Status)
	require.True(t, evidenceCase.Slashable)

	_, err = f.keeper.Mode2EpochCredits.Get(sdkCtx, collections.Join(collections.Join(dealID, uint32(0)), uint64(1)))
	require.ErrorIs(t, err, collections.ErrNotFound)
	require.False(t, hasEvidenceSummary(t, f, sdkCtx, "provider_degraded_repair_started"))
	require.False(t, hasEvidenceSummary(t, f, sdkCtx, "repair_backoff_entered"))

	updated, err := f.keeper.Deals.Get(sdkCtx, dealID)
	require.NoError(t, err)
	require.Equal(t, types.SlotStatus_SLOT_STATUS_ACTIVE, updated.Mode2Slots[0].Status)
	require.Empty(t, updated.Mode2Slots[0].PendingProvider)

	provider, err := f.keeper.Providers.Get(sdkCtx, providerA)
	require.NoError(t, err)
	require.Equal(t, beforeReputation-1, provider.ReputationScore)
	require.Equal(t, "Jailed", provider.Status)
	require.False(t, provider.Draining)

	jailUntil, err := f.keeper.ProviderJailUntil.Get(sdkCtx, providerA)
	require.NoError(t, err)
	require.Equal(t, uint64(16), jailUntil)

	health, err := f.keeper.ProviderHealthStates.Get(sdkCtx, providerA)
	require.NoError(t, err)
	require.Equal(t, types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_JAILED, health.LifecycleStatus)
	require.Equal(t, "hard_fault_jailed", health.Reason)
	require.Equal(t, types.EvidenceSeverity_EVIDENCE_SEVERITY_HARD, health.Severity)
	require.Equal(t, uint64(1), health.HardFaultCount)
}

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
			Creator:   providerA,
			DealId:    dealID,
			EpochId:   1,
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

func TestProveLiveness_HealthFailures_RecordBackoffWhenNoReplacement(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	params := types.DefaultParams()
	params.EpochLenBlocks = 5
	require.NoError(t, f.keeper.Params.Set(f.ctx, params))

	sdkCtx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(1)

	providerA := makePolicyTestAddr(t, f, 0xA1)
	providerB := makePolicyTestAddr(t, f, 0xB2)
	providerC := makePolicyTestAddr(t, f, 0xC3)
	registerPolicyTestProviders(t, f, sdkCtx, providerA, providerB, providerC)

	for _, addr := range []string{providerB, providerC} {
		provider, err := f.keeper.Providers.Get(sdkCtx, addr)
		require.NoError(t, err)
		provider.Status = "Jailed"
		require.NoError(t, f.keeper.Providers.Set(sdkCtx, addr, provider))
	}

	dealID := uint64(1)
	deal := mode2PolicyTestDeal(dealID, makePolicyTestAddr(t, f, 0xEE), []string{providerA, providerB, providerC})
	require.NoError(t, f.keeper.Deals.Set(sdkCtx, dealID, deal))

	for i := 0; i < 3; i++ {
		res, err := msgServer.ProveLiveness(sdkCtx, &types.MsgProveLiveness{
			Creator:   providerA,
			DealId:    dealID,
			EpochId:   1,
			ProofType: &types.MsgProveLiveness_SystemProof{SystemProof: nil},
		})
		require.NoError(t, err)
		require.False(t, res.Success)
	}

	updated, err := f.keeper.Deals.Get(sdkCtx, dealID)
	require.NoError(t, err)
	slot0 := updated.Mode2Slots[0]
	require.NotNil(t, slot0)
	require.Equal(t, types.SlotStatus_SLOT_STATUS_ACTIVE, slot0.Status)
	require.Empty(t, slot0.PendingProvider)
	require.True(t, hasEvidenceSummary(t, f, sdkCtx, "repair_backoff_entered"))
	require.False(t, hasEvidenceSummary(t, f, sdkCtx, "provider_degraded_repair_started"))
}

func TestProveLiveness_HealthFailuresSkipRepairDuringCooldown(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	params := types.DefaultParams()
	params.EpochLenBlocks = 5
	require.NoError(t, f.keeper.Params.Set(f.ctx, params))

	sdkCtx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(1)

	providerA := makePolicyTestAddr(t, f, 0xA1)
	providerB := makePolicyTestAddr(t, f, 0xB2)
	providerC := makePolicyTestAddr(t, f, 0xC3)
	providerD := makePolicyTestAddr(t, f, 0xD4)
	registerPolicyTestProviders(t, f, sdkCtx, providerA, providerB, providerC, providerD)

	dealID := uint64(1)
	deal := mode2PolicyTestDeal(dealID, makePolicyTestAddr(t, f, 0xEE), []string{providerA, providerB, providerC})
	require.NoError(t, f.keeper.Deals.Set(sdkCtx, dealID, deal))
	require.NoError(t, f.keeper.RepairAttemptStates.Set(sdkCtx, collections.Join(dealID, uint32(0)), types.RepairAttemptState{
		DealId:             dealID,
		Slot:               0,
		Provider:           providerA,
		CooldownUntilEpoch: 1,
		LastReason:         "repair_backoff_entered",
	}))

	for i := 0; i < 3; i++ {
		res, err := msgServer.ProveLiveness(sdkCtx, &types.MsgProveLiveness{
			Creator:   providerA,
			DealId:    dealID,
			EpochId:   1,
			ProofType: &types.MsgProveLiveness_SystemProof{SystemProof: nil},
		})
		require.NoError(t, err)
		require.False(t, res.Success)
	}

	updated, err := f.keeper.Deals.Get(sdkCtx, dealID)
	require.NoError(t, err)
	slot0 := updated.Mode2Slots[0]
	require.NotNil(t, slot0)
	require.Equal(t, types.SlotStatus_SLOT_STATUS_ACTIVE, slot0.Status)
	require.Empty(t, slot0.PendingProvider)
	require.False(t, hasEvidenceSummary(t, f, sdkCtx, "provider_degraded_repair_started"))
	require.False(t, hasEvidenceSummary(t, f, sdkCtx, "repair_backoff_entered"))
}

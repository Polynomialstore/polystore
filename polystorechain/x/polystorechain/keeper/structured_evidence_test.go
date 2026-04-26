package keeper_test

import (
	"testing"

	"cosmossdk.io/collections"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"

	"polystorechain/x/polystorechain/keeper"
	"polystorechain/x/polystorechain/types"
)

func evidenceCasesByReason(t *testing.T, f *fixture, ctx sdk.Context, reason string) []types.EvidenceCase {
	t.Helper()

	cases := make([]types.EvidenceCase, 0)
	require.NoError(t, f.keeper.EvidenceCases.Walk(ctx, nil, func(_ uint64, item types.EvidenceCase) (bool, error) {
		if item.Reason == reason {
			cases = append(cases, item)
		}
		return false, nil
	}))
	return cases
}

func requireEvidenceCase(t *testing.T, f *fixture, ctx sdk.Context, reason string) types.EvidenceCase {
	t.Helper()

	cases := evidenceCasesByReason(t, f, ctx, reason)
	require.NotEmpty(t, cases, "missing structured evidence case: %s", reason)
	return cases[len(cases)-1]
}

func TestMode2QuotaMissStoresStructuredEvidenceAndSlotHealth(t *testing.T) {
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

	setMode2EpochCredits(t, f, sdkCtx, dealID, 1, 1, 2)
	require.NoError(t, f.keeper.CheckMissedProofs(sdkCtx))

	firstHealth, err := f.keeper.SlotHealthStates.Get(sdkCtx, collections.Join(dealID, uint32(0)))
	require.NoError(t, err)
	require.Equal(t, types.SlotHealthStatus_SLOT_HEALTH_STATUS_SUSPECT, firstHealth.Status)
	require.Equal(t, "provider_degraded", firstHealth.Reason)
	require.Equal(t, types.EvidenceClass_EVIDENCE_CLASS_CHAIN_MEASURABLE_SOFT, firstHealth.EvidenceClass)
	require.Equal(t, types.EvidenceSeverity_EVIDENCE_SEVERITY_DEGRADED, firstHealth.Severity)
	require.Equal(t, uint64(1), firstHealth.MissedEpochs)
	require.Equal(t, providerA, firstHealth.Provider)

	quotaMiss := requireEvidenceCase(t, f, sdkCtx, "quota_miss_recorded")
	require.Equal(t, dealID, quotaMiss.DealId)
	require.Equal(t, uint32(0), quotaMiss.Slot)
	require.Equal(t, providerA, quotaMiss.Provider)
	require.Equal(t, uint64(1), quotaMiss.EpochId)
	require.Equal(t, uint64(1), quotaMiss.Count)
	require.False(t, quotaMiss.Slashable)

	sdkCtx = sdkCtx.WithBlockHeight(10)
	setMode2EpochCredits(t, f, sdkCtx, dealID, 2, 1, 2)
	require.NoError(t, f.keeper.CheckMissedProofs(sdkCtx))

	updated, err := f.keeper.Deals.Get(sdkCtx, dealID)
	require.NoError(t, err)
	require.Equal(t, types.SlotStatus_SLOT_STATUS_REPAIRING, updated.Mode2Slots[0].Status)
	require.Equal(t, providerD, updated.Mode2Slots[0].PendingProvider)

	repairHealth, err := f.keeper.SlotHealthStates.Get(sdkCtx, collections.Join(dealID, uint32(0)))
	require.NoError(t, err)
	require.Equal(t, types.SlotHealthStatus_SLOT_HEALTH_STATUS_REPAIRING, repairHealth.Status)
	require.Equal(t, "quota_miss_repair_started", repairHealth.Reason)
	require.Equal(t, providerA, repairHealth.Provider)
	require.Equal(t, providerD, repairHealth.PendingProvider)
	require.Equal(t, uint64(1), repairHealth.RepairTargetGen)

	delinquent := requireEvidenceCase(t, f, sdkCtx, "provider_delinquent")
	require.Equal(t, types.EvidenceCaseStatus_EVIDENCE_CASE_STATUS_CONVICTED, delinquent.Status)
	require.Equal(t, types.EvidenceSeverity_EVIDENCE_SEVERITY_DELINQUENT, delinquent.Severity)
	require.Contains(t, delinquent.ConsequenceCeiling, "no soft-fault slash")

	repairStarted := requireEvidenceCase(t, f, sdkCtx, "quota_miss_repair_started")
	require.Equal(t, types.EvidenceCaseStatus_EVIDENCE_CASE_STATUS_CONVICTED, repairStarted.Status)
	require.True(t, repairStarted.CountsAsFailure)
	require.Equal(t, repairStarted.Id, repairHealth.LastEvidenceCaseId)
}

func TestDeputyMissStoresStructuredEvidenceAndRepairHealth(t *testing.T) {
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

	setMode2EpochCredits(t, f, sdkCtx, dealID, 1, 0, 1, 2)
	require.NoError(t, f.keeper.Mode2EpochDeputyServed.Set(sdkCtx, collections.Join(collections.Join(dealID, uint32(0)), uint64(1)), 1))

	require.NoError(t, f.keeper.CheckMissedProofs(sdkCtx))

	health, err := f.keeper.SlotHealthStates.Get(sdkCtx, collections.Join(dealID, uint32(0)))
	require.NoError(t, err)
	require.Equal(t, types.SlotHealthStatus_SLOT_HEALTH_STATUS_REPAIRING, health.Status)
	require.Equal(t, "deputy_miss_repair_started", health.Reason)
	require.Equal(t, providerD, health.PendingProvider)

	deputyMiss := requireEvidenceCase(t, f, sdkCtx, "deputy_served_zero_direct")
	require.Equal(t, uint32(0), deputyMiss.Slot)
	require.Equal(t, providerA, deputyMiss.Provider)
	require.Equal(t, types.EvidenceClass_EVIDENCE_CLASS_CHAIN_MEASURABLE_SOFT, deputyMiss.EvidenceClass)
	require.False(t, deputyMiss.Slashable)

	repairStarted := requireEvidenceCase(t, f, sdkCtx, "deputy_miss_repair_started")
	require.Equal(t, types.EvidenceCaseStatus_EVIDENCE_CASE_STATUS_CONVICTED, repairStarted.Status)
	require.True(t, repairStarted.CountsAsFailure)
	require.Equal(t, repairStarted.Id, health.LastEvidenceCaseId)
}

func TestSlotHealthAndEvidenceQueries(t *testing.T) {
	f := initFixture(t)
	queryServer := keeper.NewQueryServerImpl(f.keeper)
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

	dealID := uint64(77)
	deal := mode2PolicyTestDeal(dealID, makePolicyTestAddr(t, f, 0xEE), []string{providerA, providerB, providerC})
	require.NoError(t, f.keeper.Deals.Set(sdkCtx, dealID, deal))

	derived, err := queryServer.GetSlotHealth(sdkCtx, &types.QueryGetSlotHealthRequest{DealId: dealID, Slot: 0})
	require.NoError(t, err)
	require.Equal(t, types.SlotHealthStatus_SLOT_HEALTH_STATUS_HEALTHY, derived.Health.Status)
	require.Equal(t, "slot_active", derived.Health.Reason)

	setMode2EpochCredits(t, f, sdkCtx, dealID, 1, 1, 2)
	require.NoError(t, f.keeper.CheckMissedProofs(sdkCtx))

	explicit, err := queryServer.GetSlotHealth(sdkCtx, &types.QueryGetSlotHealthRequest{DealId: dealID, Slot: 0})
	require.NoError(t, err)
	require.Equal(t, types.SlotHealthStatus_SLOT_HEALTH_STATUS_REPAIRING, explicit.Health.Status)
	require.Equal(t, "quota_miss_repair_started", explicit.Health.Reason)

	listHealth, err := queryServer.ListSlotHealthByDeal(sdkCtx, &types.QueryListSlotHealthByDealRequest{DealId: dealID})
	require.NoError(t, err)
	require.Len(t, listHealth.Health, 3)
	require.Equal(t, types.SlotHealthStatus_SLOT_HEALTH_STATUS_REPAIRING, listHealth.Health[0].Status)
	require.Equal(t, types.SlotHealthStatus_SLOT_HEALTH_STATUS_HEALTHY, listHealth.Health[1].Status)
	require.Equal(t, types.SlotHealthStatus_SLOT_HEALTH_STATUS_HEALTHY, listHealth.Health[2].Status)

	listEvidence, err := queryServer.ListEvidenceCases(sdkCtx, &types.QueryListEvidenceCasesRequest{DealId: dealID})
	require.NoError(t, err)
	require.NotEmpty(t, listEvidence.Evidence)
	for _, item := range listEvidence.Evidence {
		require.Equal(t, dealID, item.DealId)
		require.NotEmpty(t, item.Reason)
		require.NotEmpty(t, item.ConsequenceCeiling)
	}
}

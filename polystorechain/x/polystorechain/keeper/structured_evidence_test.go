package keeper_test

import (
	"testing"

	"cosmossdk.io/collections"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkquery "github.com/cosmos/cosmos-sdk/types/query"
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

	providerHealth, err := f.keeper.ProviderHealthStates.Get(sdkCtx, providerA)
	require.NoError(t, err)
	require.Equal(t, types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_DELINQUENT, providerHealth.LifecycleStatus)
	require.Equal(t, "quota_miss_repair_started", providerHealth.Reason)
	require.Equal(t, repairStarted.Id, providerHealth.LastEvidenceCaseId)
	require.Equal(t, dealID, providerHealth.LastDealId)
	require.Equal(t, uint32(0), providerHealth.LastSlot)
	require.Positive(t, providerHealth.SoftFaultCount)
	require.Positive(t, providerHealth.RepairEventCount)
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

	pagedHealth, err := queryServer.ListSlotHealthByDeal(sdkCtx, &types.QueryListSlotHealthByDealRequest{
		DealId:     dealID,
		Pagination: &sdkquery.PageRequest{Limit: 2, CountTotal: true},
	})
	require.NoError(t, err)
	require.Len(t, pagedHealth.Health, 2)
	require.NotNil(t, pagedHealth.Pagination)
	require.Equal(t, uint64(3), pagedHealth.Pagination.Total)

	listEvidence, err := queryServer.ListEvidenceCases(sdkCtx, &types.QueryListEvidenceCasesRequest{DealId: dealID})
	require.NoError(t, err)
	require.NotEmpty(t, listEvidence.Evidence)
	for _, item := range listEvidence.Evidence {
		require.Equal(t, dealID, item.DealId)
		require.NotEmpty(t, item.Reason)
		require.NotEmpty(t, item.ConsequenceCeiling)
	}

	otherEvidenceID, err := f.keeper.EvidenceCount.Next(sdkCtx)
	require.NoError(t, err)
	require.NoError(t, f.keeper.EvidenceCases.Set(sdkCtx, otherEvidenceID, types.EvidenceCase{
		Id:                 otherEvidenceID,
		DealId:             dealID + 1,
		Reason:             "other_deal",
		ConsequenceCeiling: "test-only",
	}))
	require.NoError(t, f.keeper.EvidenceCasesByDeal.Set(sdkCtx, collections.Join(dealID+1, otherEvidenceID), true))

	pagedEvidence, err := queryServer.ListEvidenceCases(sdkCtx, &types.QueryListEvidenceCasesRequest{
		DealId:     dealID,
		Pagination: &sdkquery.PageRequest{Limit: 1, CountTotal: true},
	})
	require.NoError(t, err)
	require.Len(t, pagedEvidence.Evidence, 1)
	require.NotNil(t, pagedEvidence.Pagination)
	require.Equal(t, uint64(len(listEvidence.Evidence)), pagedEvidence.Pagination.Total)
	require.Equal(t, dealID, pagedEvidence.Evidence[0].DealId)

	otherDealEvidence, err := queryServer.ListEvidenceCases(sdkCtx, &types.QueryListEvidenceCasesRequest{DealId: dealID + 1})
	require.NoError(t, err)
	require.Len(t, otherDealEvidence.Evidence, 1)
	require.Equal(t, dealID+1, otherDealEvidence.Evidence[0].DealId)

	providerHealth, err := queryServer.GetProviderHealth(sdkCtx, &types.QueryGetProviderHealthRequest{Address: providerA})
	require.NoError(t, err)
	require.Equal(t, types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_DELINQUENT, providerHealth.Health.LifecycleStatus)
	require.Equal(t, "quota_miss_repair_started", providerHealth.Health.Reason)
	require.Equal(t, dealID, providerHealth.Health.LastDealId)
	require.Equal(t, uint32(0), providerHealth.Health.LastSlot)
	require.Positive(t, providerHealth.Health.SoftFaultCount)

	derivedProviderHealth, err := queryServer.GetProviderHealth(sdkCtx, &types.QueryGetProviderHealthRequest{Address: providerD})
	require.NoError(t, err)
	require.Equal(t, types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_ACTIVE, derivedProviderHealth.Health.LifecycleStatus)
	require.Equal(t, "provider_active", derivedProviderHealth.Health.Reason)

	listProviderHealth, err := queryServer.ListProviderHealth(sdkCtx, &types.QueryListProviderHealthRequest{
		Pagination: &sdkquery.PageRequest{Limit: 2, CountTotal: true},
	})
	require.NoError(t, err)
	require.Len(t, listProviderHealth.Health, 2)
	require.NotNil(t, listProviderHealth.Pagination)
	require.Equal(t, uint64(4), listProviderHealth.Pagination.Total)
}

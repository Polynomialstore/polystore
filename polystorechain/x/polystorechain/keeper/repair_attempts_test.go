package keeper_test

import (
	"testing"

	"cosmossdk.io/collections"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkquery "github.com/cosmos/cosmos-sdk/types/query"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"polystorechain/x/polystorechain/keeper"
	"polystorechain/x/polystorechain/types"
)

func TestRepairAttemptLedgerRecordsAutomaticStartAndQueries(t *testing.T) {
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

	dealID := uint64(1)
	deal := mode2PolicyTestDeal(dealID, makePolicyTestAddr(t, f, 0xEE), []string{providerA, providerB, providerC})
	require.NoError(t, f.keeper.Deals.Set(sdkCtx, dealID, deal))
	setMode2EpochCredits(t, f, sdkCtx, dealID, 1, 1, 2)

	require.NoError(t, f.keeper.CheckMissedProofs(sdkCtx))

	attempt, err := f.keeper.RepairAttemptStates.Get(sdkCtx, collections.Join(dealID, uint32(0)))
	require.NoError(t, err)
	require.Equal(t, dealID, attempt.DealId)
	require.Equal(t, uint32(0), attempt.Slot)
	require.Equal(t, uint64(1), attempt.AttemptCount)
	require.Zero(t, attempt.BackoffCount)
	require.Zero(t, attempt.CooldownUntilEpoch)
	require.Equal(t, uint64(1), attempt.LastAttemptEpoch)
	require.Equal(t, int64(5), attempt.LastAttemptHeight)
	require.Equal(t, providerA, attempt.Provider)
	require.Equal(t, providerD, attempt.PendingProvider)
	require.Equal(t, "quota_miss_repair_started", attempt.LastReason)
	require.Equal(t, uint64(1), attempt.RepairTargetGen)
	require.NotZero(t, attempt.LastEvidenceCaseId)

	getRes, err := queryServer.GetRepairAttempt(sdkCtx, &types.QueryGetRepairAttemptRequest{
		DealId: dealID,
		Slot:   0,
	})
	require.NoError(t, err)
	require.Equal(t, attempt, getRes.RepairAttempt)

	listRes, err := queryServer.ListRepairAttemptsByDeal(sdkCtx, &types.QueryListRepairAttemptsByDealRequest{
		DealId: dealID,
		Pagination: &sdkquery.PageRequest{
			Limit:      10,
			CountTotal: true,
		},
	})
	require.NoError(t, err)
	require.Len(t, listRes.RepairAttempts, 1)
	require.Equal(t, uint64(1), listRes.Pagination.Total)
	require.Equal(t, attempt, listRes.RepairAttempts[0])
}

func TestListRepairAttemptsByDealRejectsMissingDeal(t *testing.T) {
	f := initFixture(t)
	queryServer := keeper.NewQueryServerImpl(f.keeper)
	sdkCtx := sdk.UnwrapSDKContext(f.ctx)

	_, err := queryServer.ListRepairAttemptsByDeal(sdkCtx, &types.QueryListRepairAttemptsByDealRequest{
		DealId: 99,
	})
	require.Error(t, err)
	require.Equal(t, codes.NotFound, status.Code(err))
	require.Contains(t, err.Error(), "deal not found")
}

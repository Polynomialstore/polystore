package keeper

import (
	"testing"

	"github.com/stretchr/testify/require"

	"polystorechain/x/polystorechain/types"
)

func TestRepairReadinessRequiredProofsUsesConfiguredQuota(t *testing.T) {
	deal := types.Deal{
		Id:             1,
		RedundancyMode: 2,
		Mode2Profile:   &types.StripeReplicaProfile{K: 2, M: 1},
		TotalMdus:      3,
		WitnessMdus:    1,
		ServiceHint:    "General",
	}
	stripe, err := stripeParamsForDeal(deal)
	require.NoError(t, err)

	params := types.DefaultParams()
	params.QuotaBpsPerEpochCold = 1
	params.QuotaMinBlobs = 4
	params.QuotaMaxBlobs = 0

	params.RepairReadinessQuotaBps = 5000
	require.Equal(t, uint64(2), repairReadinessRequiredProofs(params, deal, stripe))

	params.RepairReadinessQuotaBps = 10000
	require.Equal(t, uint64(4), repairReadinessRequiredProofs(params, deal, stripe))

	params.RepairReadinessQuotaBps = 0
	require.Equal(t, uint64(1), repairReadinessRequiredProofs(params, deal, stripe))
}

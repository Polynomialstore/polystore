package types_test

import (
	"testing"

	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"

	"polystorechain/x/polystorechain/types"
)

func TestDevnetPolicingParamsValidateAndSetNonzeroCollateral(t *testing.T) {
	params := types.DevnetPolicingParams()

	require.NoError(t, params.Validate())
	require.Equal(t, "150stake", params.MinProviderBond.String())
	require.Equal(t, "5stake", params.AssignmentCollateralPerSlot.String())
	require.Equal(t, uint64(5000), params.HardFaultBondSlashBps)
	require.Equal(t, params.EpochLenBlocks*params.JailHardFaultEpochs, params.ProviderBondUnbondingBlocks)
	require.GreaterOrEqual(t, params.ProviderBondUnbondingBlocks, params.EpochLenBlocks*params.JailHardFaultEpochs)
}

func TestDevnetPolicingInitialProviderBondLeavesAssignmentHeadroom(t *testing.T) {
	params := types.DevnetPolicingParams()
	bond := types.DevnetPolicingInitialProviderBond()

	require.Equal(t, sdk.DefaultBondDenom, bond.Denom)
	require.Equal(t, "200stake", bond.String())
	require.True(t, bond.Amount.GT(params.MinProviderBond.Amount))

	headroom := bond.Amount.Sub(params.MinProviderBond.Amount)
	require.Equal(t, int64(10), headroom.Quo(params.AssignmentCollateralPerSlot.Amount).Int64())
	require.Equal(t, uint64(5000), params.HardFaultBondSlashBps)
}

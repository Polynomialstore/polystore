package types_test

import (
	"testing"

	"cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"

	"polystorechain/x/polystorechain/types"
)

func TestDevnetPolicingParamsValidateAndSetNonzeroCollateral(t *testing.T) {
	params := types.DevnetPolicingParams()

	require.NoError(t, params.Validate())
	require.Equal(t, sdk.NewCoin(sdk.DefaultBondDenom, math.NewInt(150)), params.MinProviderBond)
	require.Equal(t, sdk.NewCoin(sdk.DefaultBondDenom, math.NewInt(5)), params.AssignmentCollateralPerSlot)
	require.Equal(t, uint64(5000), params.HardFaultBondSlashBps)
	require.Equal(t, params.EpochLenBlocks*params.JailHardFaultEpochs, params.ProviderBondUnbondingBlocks)
}

func TestDevnetPolicingInitialProviderBondLeavesAssignmentHeadroom(t *testing.T) {
	params := types.DevnetPolicingParams()
	bond := types.DevnetPolicingInitialProviderBond()

	require.Equal(t, sdk.DefaultBondDenom, bond.Denom)
	require.Equal(t, sdk.NewCoin(sdk.DefaultBondDenom, math.NewInt(200)), bond)
	require.True(t, bond.Amount.GT(params.MinProviderBond.Amount))

	headroom := bond.Amount.Sub(params.MinProviderBond.Amount)
	require.Equal(t, int64(10), headroom.Quo(params.AssignmentCollateralPerSlot.Amount).Int64())
	require.Equal(t, uint64(5000), params.HardFaultBondSlashBps)
}

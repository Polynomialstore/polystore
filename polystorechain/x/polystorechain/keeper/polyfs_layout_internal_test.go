package keeper

import (
	"testing"

	"github.com/stretchr/testify/require"

	"polystorechain/x/polystorechain/types"
)

func TestIsPolyFSUserDataMduTarget(t *testing.T) {
	deal := types.Deal{WitnessMdus: 2}

	require.False(t, isPolyFSUserDataMduTarget(deal, 0))
	require.False(t, isPolyFSUserDataMduTarget(deal, 1))
	require.False(t, isPolyFSUserDataMduTarget(deal, 2))
	require.True(t, isPolyFSUserDataMduTarget(deal, 3))
}

func TestValidatePolyFSContentLayout(t *testing.T) {
	deal := types.Deal{ServiceHint: "General"}

	require.NoError(t, validatePolyFSContentLayout(deal, 100, 3, 1))

	err := validatePolyFSContentLayout(deal, 100, 2, 0)
	require.ErrorContains(t, err, "witness_mdus underprovisioned")

	err = validatePolyFSContentLayout(deal, polyfsRawMduPayloadBytes+1, 3, 1)
	require.ErrorContains(t, err, "raw payload capacity")

	err = validatePolyFSContentLayout(deal, 100, polyfsRootTableCapacityMdus+2, 1)
	require.ErrorContains(t, err, "root-table capacity")

	const userMdusRequiringSecondWitness = uint64(2700)
	sizeBytes := userMdusRequiringSecondWitness * polyfsRawMduPayloadBytes

	err = validatePolyFSContentLayout(deal, sizeBytes, 1+1+userMdusRequiringSecondWitness, 1)
	require.ErrorContains(t, err, "witness_mdus underprovisioned")

	require.NoError(t, validatePolyFSContentLayout(deal, sizeBytes, 1+2+userMdusRequiringSecondWitness, 2))
}

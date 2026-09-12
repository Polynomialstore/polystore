package keeper

import (
	"testing"

	"cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"

	"polystorechain/x/polystorechain/types"
)

// Isolate the zero-sample branch of the common settlement transition. The public
// last-slot test separately exercises real proof/ACK validation and ref release.
func TestRetrievalSessionV3ZeroSampleObligationRequiresAckAndRemainingSlots(t *testing.T) {
	s := types.RetrievalSessionV3{LockedFee: math.ZeroInt(), Obligations: []types.RetrievalObligationV3{
		{Slot: 0, SampleCount: 0, LockedFee: math.ZeroInt()},
		{Slot: 1, SampleCount: 1, LockedFee: math.ZeroInt()},
	}}
	server := msgServer{}
	settled, changed, err := server.settleRetrievalObligationV3(sdk.Context{}, &s, 0, nil)
	require.NoError(t, err)
	require.False(t, settled)
	require.False(t, changed)
	s.AckedSlotsMask = 1
	settled, changed, err = server.settleRetrievalObligationV3(sdk.Context{}, &s, 0, nil)
	require.NoError(t, err)
	require.True(t, settled)
	require.True(t, changed)
	require.Equal(t, uint32(1), s.SettledSlotsMask)
	require.False(t, fullySettledV3(s), "the remaining sampled obligation still owns admission")
	s.SettledSlotsMask |= 2
	require.True(t, fullySettledV3(s))
	require.False(t, fullySettledV3(types.RetrievalSessionV3{}))
}

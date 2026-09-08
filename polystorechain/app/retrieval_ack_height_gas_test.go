package app

import (
	"bytes"
	"math/big"
	"strings"
	"testing"

	sdkmath "cosmossdk.io/math"
	storetypes "cosmossdk.io/store/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/holiman/uint256"
	"github.com/stretchr/testify/require"

	polystoreprecompile "polystorechain/precompiles/polystore"
	"polystorechain/x/polystorechain/types"
)

// This isolates native settlement's height-dependent serialization cost. It is
// not an eth_estimateGas RPC regression: transaction intrinsic gas is excluded.
func TestRetrievalACKHeightVarintGasBoundary(t *testing.T) {
	a, base := nativePrecompileApp(t)
	caller := common.HexToAddress("0xac01")
	owner := sdk.AccAddress(caller.Bytes()).String()
	params := types.DefaultParams()
	params.RetrievalV2ActivationHeight = 0 // Legacy fixture isolates the shared settlement write path.
	require.NoError(t, a.PolyStoreChainKeeper.Params.Set(base, params))
	api, err := abi.JSON(strings.NewReader(`[{"name":"confirmRetrievalSessions","type":"function","inputs":[{"type":"bytes32[]"}],"outputs":[{"type":"bool"}]}]`))
	require.NoError(t, err)
	for _, count := range []int{1, 64} {
		t.Run(new(big.Int).SetInt64(int64(count)).String(), func(t *testing.T) {
			prepared, _ := base.CacheContext()
			ids := make([][32]byte, count)
			for i := range ids {
				copy(ids[i][:], bytes.Repeat([]byte{byte(i + 1)}, 32))
				session := types.RetrievalSession{SessionId: ids[i][:], Owner: owner, Provider: owner,
					DealId: uint64(i), ExpiresAt: 512, UpdatedHeight: 126, LockedFee: sdkmath.ZeroInt(),
					Status: types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_PROOF_SUBMITTED, TotalBytes: 131072}
				require.NoError(t, a.PolyStoreChainKeeper.RetrievalSessions.Set(prepared, ids[i][:], session))
				require.NoError(t, a.PolyStoreChainKeeper.RetrievalSessionProofProvider.Set(prepared, ids[i][:], owner))
			}
			data, err := api.Pack("confirmRetrievalSessions", ids)
			require.NoError(t, err)
			call := func(height int64, gas uint64) (uint64, error) {
				ctx, _ := prepared.CacheContext() // Identical pre-ACK state for every estimate/replay.
				ctx = ctx.WithBlockHeight(height).WithGasMeter(storetypes.NewInfiniteGasMeter()).WithKVGasConfig(storetypes.KVGasConfig()).WithTransientKVGasConfig(storetypes.TransientGasConfig())
				evm, state := nativeEVM(t, a, ctx)
				evm.Context.BlockNumber = big.NewInt(height)
				_, left, callErr := evm.Call(caller, polystoreprecompile.Address, data, gas, uint256.NewInt(0))
				require.NoError(t, state.Commit())
				for _, id := range ids {
					session, getErr := a.PolyStoreChainKeeper.RetrievalSessions.Get(ctx, id[:])
					require.NoError(t, getErr)
					if callErr == nil {
						require.Equal(t, types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_COMPLETED, session.Status)
						require.Equal(t, height, session.UpdatedHeight)
					} else {
						require.Equal(t, types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_PROOF_SUBMITTED, session.Status)
						require.Equal(t, int64(126), session.UpdatedHeight)
					}
				}
				return gas - left, callErr
			}
			before, err := call(127, 20000000)
			require.NoError(t, err)
			after, err := call(128, 20000000)
			require.NoError(t, err)
			require.Greater(t, after, before)
			_, err = call(127, before)
			require.NoError(t, err, "measured H127 gas must suffice at H127")
			_, err = call(128, before)
			require.Error(t, err, "the same H127 gas limit must fail at H128")
			t.Logf("sessions=%d gas127=%d gas128=%d delta=%d", count, before, after, after-before)
		})
	}
}

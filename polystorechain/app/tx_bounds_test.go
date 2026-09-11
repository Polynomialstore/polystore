package app

import (
	"os"
	"testing"

	abci "github.com/cometbft/cometbft/abci/types"
	cmtjson "github.com/cometbft/cometbft/libs/json"
	cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"
	cmttypes "github.com/cometbft/cometbft/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"
	"github.com/stretchr/testify/require"
)

func TestRetrievalConsensusProfile(t *testing.T) {
	raw, err := os.ReadFile("../../scripts/retrieval_consensus_profile.json")
	require.NoError(t, err)
	var profile struct {
		Block cmttypes.BlockParams `json:"block"`
	}
	require.NoError(t, cmtjson.Unmarshal(raw, &profile))
	params := cmttypes.DefaultConsensusParams()
	params.Block = profile.Block
	require.NoError(t, params.ValidateBasic())
	require.Equal(t, int64(192_000_000), params.Block.MaxGas)
	require.Greater(t, params.Block.MaxBytes, int64(MaxTransactionBytes))
}

func TestTransactionBoundsBeforeDecode(t *testing.T) {
	calls := 0
	decode := boundedTxDecoder(func([]byte) (sdk.Tx, error) {
		calls++
		return nil, nil
	})
	_, err := decode(make([]byte, MaxTransactionBytes+1))
	require.ErrorIs(t, err, sdkerrors.ErrTxTooLarge)
	require.Zero(t, calls)
	_, err = decode(make([]byte, MaxTransactionBytes))
	require.NoError(t, err)
	require.Equal(t, 1, calls)

	// Exercise the actual BaseApp decoder used by CheckTx, proposal verification,
	// simulation and FinalizeBlock, rather than only the wrapper in isolation.
	a, _ := nativePrecompileApp(t)
	_, err = a.TxDecode(make([]byte, MaxTransactionBytes+1))
	require.ErrorIs(t, err, sdkerrors.ErrTxTooLarge)
}

func TestProposalBoundsBeforeAnyTransactionDecode(t *testing.T) {
	tx := make([]byte, MaxTransactionBytes)
	size := cmttypes.ComputeProtoSizeForTxs([]cmttypes.Tx{tx})
	for _, tc := range []struct {
		name string
		max  int64
		txs  [][]byte
		ok   bool
	}{
		{"exact", size, [][]byte{tx}, true},
		{"framing_counts", size - 1, [][]byte{tx}, false},
		{"aggregate_exact", 2 * size, [][]byte{tx, tx}, true},
		{"aggregate_overflow", 2*size - 1, [][]byte{tx, tx}, false},
		{"late_oversize", 4 * size, [][]byte{tx, make([]byte, MaxTransactionBytes+1)}, false},
		{"empty_transaction", size, [][]byte{nil}, false},
		{"empty_block", size, nil, true},
		{"zero_limit", 0, nil, false},
		{"unlimited_bytes", -1, nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			handler := boundedProcessProposal(func(sdk.Context, *abci.RequestProcessProposal) (*abci.ResponseProcessProposal, error) {
				calls++
				return &abci.ResponseProcessProposal{Status: abci.ResponseProcessProposal_ACCEPT}, nil
			})
			ctx := sdk.Context{}.WithConsensusParams(cmtproto.ConsensusParams{Block: &cmtproto.BlockParams{MaxBytes: tc.max, MaxGas: 64_000_000}})
			result, err := handler(ctx, &abci.RequestProcessProposal{Txs: tc.txs})
			require.NoError(t, err)
			require.Equal(t, tc.ok, result.Status == abci.ResponseProcessProposal_ACCEPT)
			if tc.ok {
				require.Equal(t, 1, calls)
			} else {
				require.Zero(t, calls, "reject the whole envelope before any decoder/ante work")
			}
		})
	}
}

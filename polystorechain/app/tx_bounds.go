package app

import (
	abci "github.com/cometbft/cometbft/abci/types"
	cmttypes "github.com/cometbft/cometbft/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"

	"polystorechain/x/polystorechain/types"
)

// MaxTransactionBytes is a consensus validation limit, not a local mempool
// preference. Changes require a coordinated binary upgrade. A 64-proof session
// and the bounded precompile calldata fit within this outer envelope.
const MaxTransactionBytes = types.MaxTransactionBytes

func boundedTxDecoder(decode sdk.TxDecoder) sdk.TxDecoder {
	return func(raw []byte) (sdk.Tx, error) {
		if len(raw) > MaxTransactionBytes {
			return nil, sdkerrors.ErrTxTooLarge.Wrapf("transaction exceeds %d bytes", MaxTransactionBytes)
		}
		return decode(raw)
	}
}

// Check the entire transaction body before the first protobuf decode, including
// when the SDK selects its no-op proposal handler for a disabled app mempool.
// CometBFT separately validates the size of the complete serialized block.
func boundedProcessProposal(next sdk.ProcessProposalHandler) sdk.ProcessProposalHandler {
	return func(ctx sdk.Context, req *abci.RequestProcessProposal) (*abci.ResponseProcessProposal, error) {
		block := ctx.ConsensusParams().Block
		if block == nil || block.MaxBytes <= 0 {
			return &abci.ResponseProcessProposal{Status: abci.ResponseProcessProposal_REJECT}, nil
		}
		remaining := block.MaxBytes
		for _, tx := range req.Txs {
			if len(tx) == 0 || len(tx) > MaxTransactionBytes {
				return &abci.ResponseProcessProposal{Status: abci.ResponseProcessProposal_REJECT}, nil
			}
			// Include the repeated-bytes protobuf framing, as the SDK selector does.
			size := cmttypes.ComputeProtoSizeForTxs([]cmttypes.Tx{tx})
			if size > remaining {
				return &abci.ResponseProcessProposal{Status: abci.ResponseProcessProposal_REJECT}, nil
			}
			remaining -= size
		}
		return next(ctx, req)
	}
}

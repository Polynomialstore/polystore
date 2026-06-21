package types

import (
	"bytes"
	"testing"

	"github.com/cosmos/cosmos-sdk/codec/unknownproto"
	"github.com/gogo/protobuf/proto"
	"github.com/stretchr/testify/require"
)

func TestSubmitRetrievalSessionProofDescriptorAllowsMdu0ProofFields(t *testing.T) {
	proof := ChainedProof{
		MduIndex:              2,
		MduRootFr:             bytes.Repeat([]byte{0x01}, 32),
		ManifestOpening:       bytes.Repeat([]byte{0x02}, 48),
		RootTableDuCommitment: bytes.Repeat([]byte{0x03}, 48),
		RootTableDuMerklePath: [][]byte{bytes.Repeat([]byte{0x04}, 32)},
		BlobCommitment:        bytes.Repeat([]byte{0x05}, 48),
		MerklePath:            [][]byte{bytes.Repeat([]byte{0x06}, 32)},
		BlobIndex:             7,
		ZValue:                bytes.Repeat([]byte{0x07}, 32),
		YValue:                bytes.Repeat([]byte{0x08}, 32),
		KzgOpeningProof:       bytes.Repeat([]byte{0x09}, 48),
	}
	msg := &MsgSubmitRetrievalSessionProof{
		Creator:   "nil1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqvtn2g7",
		SessionId: bytes.Repeat([]byte{0x0a}, 32),
		Proofs:    []ChainedProof{proof},
	}

	bz, err := proto.Marshal(msg)
	require.NoError(t, err)

	require.NoError(t, unknownproto.RejectUnknownFieldsStrict(bz, msg, unknownproto.DefaultAnyResolver{}))
}

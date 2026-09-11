package cli

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"

	"cosmossdk.io/math"
	"github.com/cosmos/cosmos-sdk/client"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"

	"polystorechain/x/polystorechain/types"
)

func TestRetrievalSessionV3CLI(t *testing.T) {
	cdc, config := retrievalTestEncoding()
	signer := sdk.AccAddress(bytes20(7))
	id := bytes.Repeat([]byte{3}, 32)
	for _, tc := range []struct {
		action string
		msg    sdk.Msg
	}{
		{"open", &types.MsgOpenRetrievalSessionV3{Creator: signer.String(), DealId: 9007199254740993, Generation: 2, Nonce: 1, DeadlineHeight: 100, Range: types.RetrievalRangeV3{FileRecordIndex: 1, FileLength: 1024, RangeLength: 1024}}},
		{"open-sponsored", &types.MsgOpenRetrievalSessionV3Sponsored{Creator: signer.String(), DealId: 1, MaxTotalFee: math.NewInt(999), Auth: &types.MsgOpenRetrievalSessionV3Sponsored_AllowlistProof{AllowlistProof: &types.AllowlistProof{MerklePath: [][]byte{id}}}}},
		{"prove", &types.MsgSubmitRetrievalSessionProofV3{Creator: signer.String(), SessionId: id, Slot: 7, Proofs: []types.RetrievalSampleProofV3{{Ordinal: 131, Proof: types.ChainedProof{MduIndex: 3, BlobIndex: 63, ZValue: id}}}}},
		{"prove-batch", &types.MsgSubmitRetrievalSessionProofBatchV3{Creator: signer.String(), Sessions: []types.RetrievalSessionProofBatchEntryV3{{SessionId: id, Slot: 7, Proofs: []types.RetrievalSampleProofV3{{Ordinal: 131, Proof: types.ChainedProof{MduIndex: 3, BlobIndex: 63, ZValue: id}}}}}}},
		{"ack", &types.MsgAcknowledgeRetrievalObligationV3{Creator: signer.String(), SessionId: id, Slot: 7, AckDigest: id}},
		{"refund", &types.MsgRefundRetrievalSessionV3{Creator: signer.String(), SessionId: id}},
	} {
		t.Run(tc.action, func(t *testing.T) {
			data, err := cdc.MarshalJSON(tc.msg)
			require.NoError(t, err)
			path := filepath.Join(t.TempDir(), "message.json")
			require.NoError(t, os.WriteFile(path, data, 0600))
			output := &bytes.Buffer{}
			ctx := client.Context{}.WithCodec(cdc).WithTxConfig(config).WithFromAddress(signer).WithChainID("cli-test").WithGenerateOnly(true).WithOutput(output)
			cmd := CmdRetrievalSessionV3()
			cmd.SetContext(context.Background())
			require.NoError(t, client.SetCmdClientContext(cmd, ctx))
			cmd.SetOut(&bytes.Buffer{})
			cmd.SetErr(&bytes.Buffer{})
			cmd.SetArgs([]string{tc.action, path, "--from", signer.String(), "--gas", "1000000"})
			require.NoError(t, cmd.Execute())
			tx, err := config.TxJSONDecoder()(output.Bytes())
			require.NoError(t, err)
			require.Len(t, tx.GetMsgs(), 1)
			decoded, err := cdc.MarshalJSON(tx.GetMsgs()[0])
			require.NoError(t, err)
			require.Equal(t, data, decoded)
		})
	}
	for _, tc := range []struct{ name, action, data string }{
		{"wrong signer", "refund", `{"creator":"` + sdk.AccAddress(bytes20(8)).String() + `"}`},
		{"missing creator", "refund", `{}`},
		{"unknown field", "refund", `{"creator":"` + signer.String() + `","typo":1}`},
		{"malformed JSON", "open", `{`},
		{"unknown action", "cancel", `{}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "message.json")
			require.NoError(t, os.WriteFile(path, []byte(tc.data), 0600))
			output := &bytes.Buffer{}
			ctx := client.Context{}.WithCodec(cdc).WithTxConfig(config).WithFromAddress(signer).WithGenerateOnly(true).WithOutput(output)
			cmd := CmdRetrievalSessionV3()
			cmd.SetContext(context.Background())
			require.NoError(t, client.SetCmdClientContext(cmd, ctx))
			cmd.SetOut(&bytes.Buffer{})
			cmd.SetErr(&bytes.Buffer{})
			cmd.SetArgs([]string{tc.action, path, "--from", signer.String()})
			require.Error(t, cmd.Execute())
			require.Empty(t, output.Bytes())
		})
	}
}

func TestRetrievalSessionV3CLIClassifiesPreBroadcastFailure(t *testing.T) {
	cdc, config := retrievalTestEncoding()
	signer := sdk.AccAddress(bytes20(7))
	message := filepath.Join(t.TempDir(), "message.json")
	require.NoError(t, os.WriteFile(message, []byte("{"), 0600))
	phase := filepath.Join(t.TempDir(), "phase")
	require.NoError(t, os.WriteFile(phase, nil, 0600))
	ctx := client.Context{}.WithCodec(cdc).WithTxConfig(config).WithFromAddress(signer).WithChainID("cli-test").WithGenerateOnly(true).WithOutput(&bytes.Buffer{})
	cmd := CmdRetrievalSessionV3()
	cmd.SetContext(context.Background())
	require.NoError(t, client.SetCmdClientContext(cmd, ctx))
	cmd.SetOut(&bytes.Buffer{})
	cmd.SetErr(&bytes.Buffer{})
	cmd.SetArgs([]string{"refund", message, "--from", signer.String(), "--" + submissionPhaseFlag, phase})
	require.Error(t, cmd.Execute())
	marker, err := os.ReadFile(phase)
	require.NoError(t, err)
	require.Equal(t, submissionNotBroadcast, string(marker))
}

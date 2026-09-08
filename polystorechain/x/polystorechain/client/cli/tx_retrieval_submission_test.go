package cli

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	abci "github.com/cometbft/cometbft/abci/types"
	cmtbytes "github.com/cometbft/cometbft/libs/bytes"
	rpcclient "github.com/cometbft/cometbft/rpc/client"
	coretypes "github.com/cometbft/cometbft/rpc/core/types"
	cmttypes "github.com/cometbft/cometbft/types"
	"github.com/cosmos/cosmos-sdk/client"
	"github.com/cosmos/cosmos-sdk/client/flags"
	clienttx "github.com/cosmos/cosmos-sdk/client/tx"
	"github.com/cosmos/cosmos-sdk/codec"
	codectypes "github.com/cosmos/cosmos-sdk/codec/types"
	cryptocodec "github.com/cosmos/cosmos-sdk/crypto/codec"
	"github.com/cosmos/cosmos-sdk/crypto/hd"
	"github.com/cosmos/cosmos-sdk/crypto/keyring"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdktx "github.com/cosmos/cosmos-sdk/types/tx"
	"github.com/cosmos/cosmos-sdk/types/tx/signing"
	authsigning "github.com/cosmos/cosmos-sdk/x/auth/signing"
	authtx "github.com/cosmos/cosmos-sdk/x/auth/tx"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
	"github.com/stretchr/testify/require"

	"polystorechain/x/polystorechain/keeper"
	"polystorechain/x/polystorechain/types"
)

func retrievalTestEncoding() (codec.Codec, client.TxConfig) {
	registry := codectypes.NewInterfaceRegistry()
	cryptocodec.RegisterInterfaces(registry)
	types.RegisterInterfaces(registry)
	cdc := codec.NewProtoCodec(registry)
	return cdc, authtx.NewTxConfig(cdc, authtx.DefaultSignModes)
}

func retrievalTestSessions(t *testing.T, signer sdk.AccAddress) []types.MsgSubmitRetrievalSessionProof {
	t.Helper()
	var sessions []types.MsgSubmitRetrievalSessionProof
	for i := 0; i < 2; i++ {
		owner := sdk.AccAddress(bytes20(byte(i + 20)))
		id, err := types.HashRetrievalSessionID(owner, uint64(i+1), signer, bytes.Repeat([]byte{3}, 32), 2, 0, 1, 1, 100)
		require.NoError(t, err)
		sessions = append(sessions, types.MsgSubmitRetrievalSessionProof{
			Creator: owner.String(), SessionId: id,
			Proofs: []types.ChainedProof{{MduIndex: 2, BlobIndex: uint32(i), ZValue: bytes.Repeat([]byte{byte(i + 1)}, 32)}},
		})
	}
	return sessions
}

func retrievalTestJSON(t *testing.T, value any) []byte {
	t.Helper()
	bz, err := json.Marshal(value)
	require.NoError(t, err)
	return bz
}

func retrievalTestCommand(t *testing.T, ctx client.Context, bz []byte, extraArgs ...string) *cobra.Command {
	t.Helper()
	oldGet, oldBroadcast := getClientTxContextFn, generateOrBroadcastTxCLIFn
	t.Cleanup(func() { getClientTxContextFn, generateOrBroadcastTxCLIFn = oldGet, oldBroadcast })
	getClientTxContextFn = func(*cobra.Command) (client.Context, error) { return ctx, nil }
	generateOrBroadcastTxCLIFn = clienttx.GenerateOrBroadcastTxCLI
	path := filepath.Join(t.TempDir(), "proofs.json")
	require.NoError(t, os.WriteFile(path, bz, 0600))
	cmd := CmdSubmitRetrievalProof()
	cmd.SetContext(context.Background())
	cmd.SetOut(&bytes.Buffer{})
	cmd.SetErr(&bytes.Buffer{})
	cmd.SetArgs(append([]string{path, "--gas", "1500000"}, extraArgs...))
	return cmd
}

func TestSubmitRetrievalProofOneUnsignedTransactionForDistinctOwners(t *testing.T) {
	cdc, config := retrievalTestEncoding()
	signer := sdk.AccAddress(bytes20(7))
	sessions := retrievalTestSessions(t, signer)
	for _, single := range []bool{false, true} {
		t.Run(fmt.Sprintf("single=%t", single), func(t *testing.T) {
			output := &bytes.Buffer{}
			ctx := client.Context{}.WithCodec(cdc).WithTxConfig(config).WithFromAddress(signer).
				WithChainID("cli-test").WithGenerateOnly(true).WithOutput(output)
			var input any = map[string]any{"sessions": sessions}
			want := sessions
			if single {
				input, want = sessions[0], sessions[:1]
			}
			cmd := retrievalTestCommand(t, ctx, retrievalTestJSON(t, input))
			calls := 0
			generateOrBroadcastTxCLIFn = func(c client.Context, f *pflag.FlagSet, msgs ...sdk.Msg) error {
				calls++
				return clienttx.GenerateOrBroadcastTxCLI(c, f, msgs...)
			}
			require.NoError(t, cmd.Execute())
			require.Equal(t, 1, calls)
			transaction, err := config.TxJSONDecoder()(output.Bytes())
			require.NoError(t, err)
			require.Len(t, transaction.GetMsgs(), len(want))
			for i, raw := range transaction.GetMsgs() {
				msg := raw.(*types.MsgSubmitRetrievalSessionProof)
				require.Equal(t, signer.String(), msg.Creator)
				require.Equal(t, want[i].SessionId, msg.SessionId)
				require.Equal(t, want[i].Proofs, msg.Proofs)
			}
		})
	}
}

func TestRetrievalProofInputDiscriminationAndLimits(t *testing.T) {
	signer := sdk.AccAddress(bytes20(7))
	sessions := retrievalTestSessions(t, signer)
	one := string(retrievalTestJSON(t, sessions[0]))
	id := base64.StdEncoding.EncodeToString(sessions[0].SessionId)
	cases := map[string]string{
		"null root": `null`, "array root": `[]`, "null list": `{"sessions":null}`,
		"empty list": `{"sessions":[]}`, "trailing": `{"sessions":[` + one + `]} {}`,
		"duplicate discriminator":         `{"sessions":[` + one + `],"sessions":[` + one + `]}`,
		"duplicate escaped discriminator": `{"sessions":[` + one + `],"sessio\u006es":[` + one + `]}`,
		"mixed single":                    `{"sessions":[` + one + `],"session_id":"` + id + `"}`,
		"mixed receipt":                   `{"sessions":[` + one + `],"session_receipt":{}}`,
		"mixed batch":                     `{"sessions":[` + one + `],"receipts":[]}`,
		"mixed chunk":                     `{"sessions":[` + one + `],"chunks":[]}`,
		"mixed singular legacy":           `{"session_id":"` + id + `","proofs":[{}],"receipts":[]}`,
		"duplicate entry id":              `{"session_id":"` + id + `","session_id":"` + id + `","proofs":[{}]}`,
		"case alias entry":                `{"session_id":"` + id + `","SESSION_ID":"` + id + `","proofs":[{}]}`,
		"nested plural":                   `{"sessions":[{"sessions":[` + one + `]}]}`,
		"null entry":                      `{"sessions":[null]}`, "null id": `{"session_id":null,"proofs":[{}]}`,
		"short id":           `{"session_id":"AQ==","proofs":[{}]}`,
		"invalid id":         `{"session_id":"!!!","proofs":[{}]}`,
		"missing proofs":     `{"session_id":"` + id + `"}`,
		"null proofs":        `{"session_id":"` + id + `","proofs":null}`,
		"empty proofs":       `{"session_id":"` + id + `","proofs":[]}`,
		"too many proofs":    `{"session_id":"` + id + `","proofs":[` + strings.Repeat(`{},`, 64) + `{}]}`,
		"oversized proof":    `{"session_id":"` + id + `","proofs":[{"mdu_root_fr":"` + strings.Repeat("A", keeper.MaxProofEnvelopeBytes) + `"}]}`,
		"duplicate sessions": `{"sessions":[` + one + `,` + one + `]}`,
		"too many sessions":  `{"sessions":[` + strings.Repeat(one+`,`, 64) + one + `]}`,
	}
	for name, input := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := retrievalProofMessages([]byte(input), signer.String())
			require.Error(t, err)
		})
	}
	entries := make([]types.MsgSubmitRetrievalSessionProof, 64)
	for i := range entries {
		entries[i] = sessions[0]
		entries[i].SessionId = bytes.Repeat([]byte{byte(i)}, 32)
	}
	msgs, err := retrievalProofMessages(retrievalTestJSON(t, map[string]any{"sessions": entries}), signer.String())
	require.NoError(t, err)
	require.Len(t, msgs, 64)
	_, err = retrievalProofMessages([]byte(one), "")
	require.ErrorContains(t, err, "--from")
}

func TestRetrievalProofLegacyShapesRemainSingleMessages(t *testing.T) {
	signer := sdk.AccAddress(bytes20(7)).String()
	receipt := types.RetrievalReceipt{DealId: 3, EpochId: 4}
	for _, input := range []any{receipt, types.RetrievalReceiptBatch{Receipts: []types.RetrievalReceipt{receipt}},
		types.RetrievalSessionProof{SessionReceipt: types.DownloadSessionReceipt{DealId: 3, EpochId: 4}}} {
		msgs, err := retrievalProofMessages(retrievalTestJSON(t, input), signer)
		require.NoError(t, err)
		require.Len(t, msgs, 1)
		msg := msgs[0].(*types.MsgProveLiveness)
		require.Equal(t, signer, msg.Creator)
		require.Equal(t, uint64(3), msg.DealId)
		require.Equal(t, uint64(4), msg.EpochId)
	}
}

type retrievalTestRPC struct {
	client.CometRPC
	block        *cmttypes.BlockParams
	err          error
	broadcasts   []cmttypes.Tx
	simulatedGas uint64
}

func (r *retrievalTestRPC) ConsensusParams(context.Context, *int64) (*coretypes.ResultConsensusParams, error) {
	return &coretypes.ResultConsensusParams{BlockHeight: 7, ConsensusParams: cmttypes.ConsensusParams{Block: *r.block}}, r.err
}
func (r *retrievalTestRPC) BroadcastTxSync(_ context.Context, bz cmttypes.Tx) (*coretypes.ResultBroadcastTx, error) {
	r.broadcasts = append(r.broadcasts, bytes.Clone(bz))
	return &coretypes.ResultBroadcastTx{Hash: bz.Hash()}, nil
}
func (r *retrievalTestRPC) ABCIQueryWithOptions(_ context.Context, path string, _ cmtbytes.HexBytes, _ rpcclient.ABCIQueryOptions) (*coretypes.ResultABCIQuery, error) {
	if path != "/cosmos.tx.v1beta1.Service/Simulate" {
		return nil, fmt.Errorf("unexpected query %q", path)
	}
	bz, err := (&sdktx.SimulateResponse{GasInfo: &sdk.GasInfo{GasUsed: r.simulatedGas}}).Marshal()
	return &coretypes.ResultABCIQuery{Response: abci.ResponseQuery{Value: bz}}, err
}

func TestRetrievalProofSDKSignsOnceAndChecksFinalAutoGas(t *testing.T) {
	cdc, config := retrievalTestEncoding()
	keys := keyring.NewInMemory(cdc)
	record, _, err := keys.NewMnemonic("submitter", keyring.English, sdk.FullFundraiserPath, "", hd.Secp256k1)
	require.NoError(t, err)
	signer, err := record.GetAddress()
	require.NoError(t, err)
	sessions := retrievalTestSessions(t, signer)
	for _, tc := range []struct {
		name          string
		gas           uint64
		inflateSigned bool
		wantError     string
	}{
		{name: "valid signed transaction", gas: 1_000_000},
		{name: "final estimated gas exceeds cap", gas: uint64(types.MaxRetrievalV2BlockGas) + 1, wantError: "gas exceeds"},
		{name: "final signed bytes exceed cap", gas: 1_000_000, inflateSigned: true, wantError: "protobuf bytes"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rpc := &retrievalTestRPC{block: &cmttypes.BlockParams{MaxBytes: types.MaxRetrievalV2BlockBytes, MaxGas: types.MaxRetrievalV2BlockGas}, simulatedGas: tc.gas}
			ctx := client.Context{}.WithCodec(cdc).WithTxConfig(config).WithFromAddress(signer).WithFromName("submitter").
				WithKeyring(keys).WithChainID("cli-test").WithClient(rpc).WithAccountRetriever(client.MockAccountRetriever{ReturnAccNum: 2, ReturnAccSeq: 7}).
				WithSkipConfirmation(true).WithBroadcastMode(flags.BroadcastSync).WithOutput(&bytes.Buffer{}).WithCmdContext(context.Background())
			postSignCalls := 0
			if tc.inflateSigned {
				// The real SDK invokes this hook after signing. Grow the transaction
				// there to prove the final encoder, not just preflight, gates broadcast.
				ctx = ctx.WithPreprocessTxHook(func(_ string, _ keyring.KeyType, builder client.TxBuilder) error {
					postSignCalls++
					sigs, err := builder.GetTx().GetSignaturesV2()
					require.NoError(t, err)
					require.Len(t, sigs, 1)
					require.NotEmpty(t, sigs[0].Data.(*signing.SingleSignatureData).Signature)
					builder.SetMemo(strings.Repeat("x", types.MaxTransactionBytes))
					return nil
				})
			}
			cmd := retrievalTestCommand(t, ctx, retrievalTestJSON(t, map[string]any{"sessions": sessions}), "--gas", "auto", "--gas-adjustment", "1")
			err := cmd.Execute()
			if tc.inflateSigned {
				require.Equal(t, 1, postSignCalls)
			}
			if tc.wantError != "" {
				require.ErrorContains(t, err, tc.wantError)
				require.Empty(t, rpc.broadcasts)
				return
			}
			require.NoError(t, err)
			require.Len(t, rpc.broadcasts, 1)
			transaction, err := config.TxDecoder()(rpc.broadcasts[0])
			require.NoError(t, err)
			signed := transaction.(authsigning.Tx)
			require.Len(t, signed.GetMsgs(), 2)
			sigs, err := signed.GetSignaturesV2()
			require.NoError(t, err)
			require.Len(t, sigs, 1)
			data := sigs[0].Data.(*signing.SingleSignatureData)
			signBytes, err := authsigning.GetSignBytesAdapter(context.Background(), config.SignModeHandler(), data.SignMode,
				authsigning.SignerData{ChainID: "cli-test", AccountNumber: 2, Sequence: 7, PubKey: sigs[0].PubKey, Address: signer.String()}, signed)
			require.NoError(t, err)
			require.True(t, sigs[0].PubKey.VerifySignature(signBytes, data.Signature))
			for i, raw := range signed.GetMsgs() {
				msg := raw.(*types.MsgSubmitRetrievalSessionProof)
				require.Equal(t, signer.String(), msg.Creator)
				require.Equal(t, sessions[i].SessionId, msg.SessionId)
			}
		})
	}
}

func TestRetrievalProofFileLimitPrecedesDecodeAndBroadcast(t *testing.T) {
	ctx := client.Context{}.WithFromAddress(sdk.AccAddress(bytes20(7)))
	cmd := retrievalTestCommand(t, ctx, bytes.Repeat([]byte{'x'}, retrievalProofFileBytes+1))
	called := false
	generateOrBroadcastTxCLIFn = func(client.Context, *pflag.FlagSet, ...sdk.Msg) error { called = true; return nil }
	require.ErrorContains(t, cmd.Execute(), "JSON exceeds")
	require.False(t, called)
}

func TestRetrievalProofOversizedUnsignedEnvelopePrecedesSigning(t *testing.T) {
	cdc, config := retrievalTestEncoding()
	signer := sdk.AccAddress(bytes20(7))
	ctx := client.Context{}.WithCodec(cdc).WithTxConfig(config).WithFromAddress(signer).
		WithChainID("cli-test").WithGenerateOnly(true)
	cmd := retrievalTestCommand(t, ctx, retrievalTestJSON(t, retrievalTestSessions(t, signer)[0]),
		"--"+flags.FlagNote, strings.Repeat("x", types.MaxTransactionBytes))
	called := false
	generateOrBroadcastTxCLIFn = func(client.Context, *pflag.FlagSet, ...sdk.Msg) error { called = true; return nil }
	require.ErrorContains(t, cmd.Execute(), "protobuf bytes")
	require.False(t, called, "reject unsigned envelope before the SDK signer is invoked")
}

func TestRetrievalProofUnsignedAndSignedLimits(t *testing.T) {
	cdc, config := retrievalTestEncoding()
	msg := &retrievalTestSessions(t, sdk.AccAddress(bytes20(7)))[0]
	builder := config.NewTxBuilder()
	require.NoError(t, builder.SetMsgs(msg))
	builder.SetGasLimit(1_000_000)
	cfg := retrievalProofTxConfig{TxConfig: config, maxBytes: types.MaxTransactionBytes, maxGas: uint64(types.MaxRetrievalV2BlockGas)}
	builder.SetMemo(strings.Repeat("x", types.MaxTransactionBytes))
	_, err := cfg.encode(builder.GetTx(), retrievalSigningReserve)
	require.ErrorContains(t, err, "protobuf bytes")
	_, err = cfg.TxEncoder()(builder.GetTx())
	require.ErrorContains(t, err, "protobuf bytes")
	builder.SetMemo("")
	msg.Proofs[0].MduRootFr = bytes.Repeat([]byte{1}, 20000)
	require.NoError(t, builder.SetMsgs(msg))
	binary, err := config.TxEncoder()(builder.GetTx())
	require.NoError(t, err)
	jsonBytes, err := config.TxJSONEncoder()(builder.GetTx())
	require.NoError(t, err)
	require.Greater(t, len(jsonBytes), len(binary)+retrievalSigningReserve)
	cfg.maxBytes = len(binary) + retrievalSigningReserve
	_, err = cfg.TxJSONEncoder()(builder.GetTx())
	require.NoError(t, err, "JSON inflation is not protobuf transaction size")
	cfg.maxBytes--
	_, err = cfg.TxJSONEncoder()(builder.GetTx())
	require.ErrorContains(t, err, "reserved for signing")
	ctx := client.Context{}.WithCodec(cdc).WithTxConfig(config).WithFromAddress(sdk.AccAddress(bytes20(7))).WithChainID("cli-test").WithGenerateOnly(true)
	for _, gas := range []string{"64000001", "not-gas"} {
		cmd := CmdSubmitRetrievalProof()
		cmd.SetContext(context.Background())
		require.NoError(t, cmd.Flags().Set(flags.FlagGas, gas))
		_, err = boundRetrievalProofTx(cmd, ctx, []sdk.Msg{msg})
		require.Error(t, err)
	}
	msg.Proofs = make([]types.ChainedProof, keeper.MaxProofsPerMessage)
	cmd := CmdSubmitRetrievalProof()
	cmd.SetContext(context.Background())
	_, err = boundRetrievalProofTx(cmd, ctx, []sdk.Msg{msg, msg, msg})
	require.ErrorContains(t, err, "session proofs exceed")
	ctx = ctx.WithGenerateOnly(false)
	_, err = boundRetrievalProofTx(cmd, ctx, []sdk.Msg{msg})
	require.ErrorContains(t, err, "block limits")
	rpc := &retrievalTestRPC{block: &cmttypes.BlockParams{MaxBytes: 100000, MaxGas: 1_000_000}}
	ctx = ctx.WithClient(rpc)
	msg.Proofs = msg.Proofs[:1]
	require.NoError(t, cmd.Flags().Set(flags.FlagGas, "1000001"))
	_, err = boundRetrievalProofTx(cmd, ctx, []sdk.Msg{msg})
	require.ErrorContains(t, err, "gas exceeds 1000000")
	require.NoError(t, cmd.Flags().Set(flags.FlagGas, "1000000"))
	bounded, err := boundRetrievalProofTx(cmd, ctx, []sdk.Msg{msg})
	require.NoError(t, err)
	require.Equal(t, 99990, bounded.TxConfig.(retrievalProofTxConfig).maxBytes)
}

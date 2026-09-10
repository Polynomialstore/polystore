package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	coretypes "github.com/cometbft/cometbft/rpc/core/types"
	cmttypes "github.com/cometbft/cometbft/types"
	"github.com/cosmos/cosmos-sdk/client"
	"github.com/cosmos/cosmos-sdk/client/flags"
	"github.com/cosmos/cosmos-sdk/crypto/hd"
	"github.com/cosmos/cosmos-sdk/crypto/keyring"
	"github.com/stretchr/testify/require"
	"polystorechain/x/polystorechain/types"
)

type phaseFailureRPC struct{ *retrievalTestRPC }

func (r *phaseFailureRPC) BroadcastTxSync(_ context.Context, _ cmttypes.Tx) (*coretypes.ResultBroadcastTx, error) {
	return nil, errors.New("network write failed")
}

func TestSubmissionPhaseRealSDKLocalAndBroadcastFailures(t *testing.T) {
	cdc, config := retrievalTestEncoding()
	keys := keyring.NewInMemory(cdc)
	record, _, err := keys.NewMnemonic("submitter", keyring.English, "m/44'/118'/0'/0/0", "", hd.Secp256k1)
	require.NoError(t, err)
	signer, err := record.GetAddress()
	require.NoError(t, err)
	for _, mode := range []string{"build", "simulated_gas", "network"} {
		t.Run(mode, func(t *testing.T) {
			rpc := &retrievalTestRPC{block: &cmttypes.BlockParams{MaxBytes: types.MaxRetrievalV2BlockBytes, MaxGas: types.MaxRetrievalV2BlockGas}, simulatedGas: 1_000_000}
			var node client.CometRPC = rpc
			if mode == "network" {
				node = &phaseFailureRPC{rpc}
			}
			if mode == "simulated_gas" {
				rpc.simulatedGas = uint64(types.MaxRetrievalV2BlockGas) + 1
			}
			ctx := client.Context{}.WithCodec(cdc).WithTxConfig(config).WithFromAddress(signer).WithFromName("submitter").WithKeyring(keys).
				WithChainID("cli-test").WithClient(node).WithAccountRetriever(client.MockAccountRetriever{ReturnAccNum: 2, ReturnAccSeq: 7}).
				WithSkipConfirmation(true).WithBroadcastMode(flags.BroadcastSync).WithOutput(&bytes.Buffer{}).WithCmdContext(context.Background())
			payload := retrievalTestJSON(t, retrievalTestSessions(t, signer)[0])
			if mode == "build" {
				payload = []byte("bad json")
			}
			path := filepath.Join(t.TempDir(), "phase")
			require.NoError(t, os.WriteFile(path, nil, 0600))
			cmd := retrievalTestCommand(t, ctx, payload, "--gas", "auto", "--gas-adjustment", "1", "--"+submissionPhaseFlag, path)
			require.Error(t, cmd.Execute())
			marker, err := os.ReadFile(path)
			require.NoError(t, err)
			if mode == "network" {
				var timing submissionTiming
				require.NoError(t, json.Unmarshal(marker, &timing))
				require.Equal(t, submissionTimingSchema, timing.Schema)
			} else {
				require.Equal(t, submissionNotBroadcast, string(marker))
			}
		})
	}
}

func TestSubmissionPhaseCrashAndWriteFailureAreUnclassified(t *testing.T) {
	path := filepath.Join(t.TempDir(), "phase")
	require.NoError(t, os.WriteFile(path, nil, 0600))
	err := errors.New("earlier error")
	func() {
		defer func() { require.Equal(t, "crash", recover()) }()
		phase := &submissionPhase{path: path}
		defer phase.finish(&err)
		panic("crash")
	}()
	marker, readErr := os.ReadFile(path)
	require.NoError(t, readErr)
	require.Empty(t, marker)
	phase := &submissionPhase{path: filepath.Join(t.TempDir(), "missing", "phase")}
	phase.finish(&err)
	_, readErr = os.Stat(phase.path)
	require.True(t, os.IsNotExist(readErr))
}

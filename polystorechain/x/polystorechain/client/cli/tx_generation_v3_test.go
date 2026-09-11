package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cosmos/cosmos-sdk/client"
	"github.com/cosmos/cosmos-sdk/client/flags"
	clienttx "github.com/cosmos/cosmos-sdk/client/tx"
	"github.com/cosmos/cosmos-sdk/crypto/hd"
	"github.com/cosmos/cosmos-sdk/crypto/keyring"
	"github.com/spf13/cobra"
	"github.com/stretchr/testify/require"
)

func TestAcceptDealGenerationV3SubmissionPhase(t *testing.T) {
	cdc, config := retrievalTestEncoding()
	keys := keyring.NewInMemory(cdc)
	record, _, err := keys.NewMnemonic("provider", keyring.English, "m/44'/118'/0'/0/0", "", hd.Secp256k1)
	require.NoError(t, err)
	signer, err := record.GetAddress()
	require.NoError(t, err)
	rpc := &retrievalTestRPC{simulatedGas: 100_000}
	ctx := client.Context{}.WithCodec(cdc).WithTxConfig(config).WithFromAddress(signer).WithFromName("provider").WithKeyring(keys).
		WithChainID("cli-test").WithClient(&phaseFailureRPC{rpc}).WithAccountRetriever(client.MockAccountRetriever{ReturnAccNum: 2, ReturnAccSeq: 7}).
		WithSkipConfirmation(true).WithBroadcastMode(flags.BroadcastSync).WithOutput(&bytes.Buffer{}).WithCmdContext(context.Background())
	oldGet, oldBroadcast := getClientTxContextFn, generateOrBroadcastTxCLIFn
	t.Cleanup(func() { getClientTxContextFn, generateOrBroadcastTxCLIFn = oldGet, oldBroadcast })
	getClientTxContextFn = func(*cobra.Command) (client.Context, error) { return ctx, nil }
	generateOrBroadcastTxCLIFn = clienttx.GenerateOrBroadcastTxCLI

	for _, tc := range []struct {
		name, digest string
		broadcast    bool
	}{
		{name: "local", digest: "zz"},
		{name: "broadcast", digest: strings.Repeat("ab", 32), broadcast: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			phase := filepath.Join(t.TempDir(), "phase")
			require.NoError(t, os.WriteFile(phase, nil, 0600))
			cmd := CmdAcceptDealGenerationV3()
			cmd.SetContext(context.Background())
			cmd.SetOut(&bytes.Buffer{})
			cmd.SetErr(&bytes.Buffer{})
			cmd.SetArgs([]string{"--deal-id", "0", "--slot", "0", "--acceptance-digest", tc.digest, "--gas", "1000000", "--" + submissionPhaseFlag, phase})
			require.Error(t, cmd.Execute())
			marker, err := os.ReadFile(phase)
			require.NoError(t, err)
			if tc.broadcast {
				require.NotEqual(t, submissionNotBroadcast, string(marker))
				var timing submissionTiming
				require.NoError(t, json.Unmarshal(marker, &timing))
				require.Equal(t, submissionTimingSchema, timing.Schema)
				require.Positive(t, timing.PreBroadcastNS)
				require.Positive(t, timing.BroadcastTxSyncNS)
			} else {
				require.Equal(t, submissionNotBroadcast, string(marker))
			}
		})
	}
}

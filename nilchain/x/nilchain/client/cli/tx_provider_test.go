package cli

import (
	"testing"

	"github.com/cosmos/cosmos-sdk/client"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
	"github.com/stretchr/testify/require"

	"nilchain/x/nilchain/types"
)

func TestCmdUpdateProviderEndpointsRequiresEndpoint(t *testing.T) {
	originalGetClientTxContext := getClientTxContextFn
	originalBroadcast := generateOrBroadcastTxCLIFn
	t.Cleanup(func() {
		getClientTxContextFn = originalGetClientTxContext
		generateOrBroadcastTxCLIFn = originalBroadcast
	})

	getClientTxContextFn = func(cmd *cobra.Command) (client.Context, error) {
		return client.Context{FromAddress: sdk.AccAddress(bytes20(1))}, nil
	}
	broadcastCalled := false
	generateOrBroadcastTxCLIFn = func(clientCtx client.Context, flags *pflag.FlagSet, msgs ...sdk.Msg) error {
		broadcastCalled = true
		return nil
	}

	cmd := CmdUpdateProviderEndpoints()
	cmd.SetArgs(nil)

	err := cmd.Execute()
	require.Error(t, err)
	require.Contains(t, err.Error(), "at least one --endpoint")
	require.False(t, broadcastCalled)
}

func TestCmdUpdateProviderEndpointsBuildsMessageAndBroadcasts(t *testing.T) {
	originalGetClientTxContext := getClientTxContextFn
	originalBroadcast := generateOrBroadcastTxCLIFn
	t.Cleanup(func() {
		getClientTxContextFn = originalGetClientTxContext
		generateOrBroadcastTxCLIFn = originalBroadcast
	})

	from := sdk.AccAddress(bytes20(2))
	getClientTxContextFn = func(cmd *cobra.Command) (client.Context, error) {
		return client.Context{FromAddress: from}, nil
	}

	var captured types.MsgUpdateProviderEndpoints
	broadcastCalled := false
	generateOrBroadcastTxCLIFn = func(clientCtx client.Context, flags *pflag.FlagSet, msgs ...sdk.Msg) error {
		broadcastCalled = true
		require.Len(t, msgs, 1)
		msg, ok := msgs[0].(*types.MsgUpdateProviderEndpoints)
		require.True(t, ok)
		captured = *msg
		return nil
	}

	cmd := CmdUpdateProviderEndpoints()
	endpoints := []string{
		"/dns4/provider.nil/tcp/443/https",
		"/ip4/127.0.0.1/tcp/8081/http",
	}
	cmd.SetArgs([]string{
		"--endpoint", endpoints[0],
		"--endpoint", endpoints[1],
	})

	err := cmd.Execute()
	require.NoError(t, err)
	require.True(t, broadcastCalled)
	require.Equal(t, from.String(), captured.Creator)
	require.Equal(t, endpoints, captured.Endpoints)
}

func TestCmdOpenProviderPairingBuildsMessageAndBroadcasts(t *testing.T) {
	originalGetClientTxContext := getClientTxContextFn
	originalBroadcast := generateOrBroadcastTxCLIFn
	t.Cleanup(func() {
		getClientTxContextFn = originalGetClientTxContext
		generateOrBroadcastTxCLIFn = originalBroadcast
	})

	from := sdk.AccAddress(bytes20(3))
	getClientTxContextFn = func(cmd *cobra.Command) (client.Context, error) {
		return client.Context{FromAddress: from}, nil
	}

	var captured types.MsgOpenProviderPairing
	generateOrBroadcastTxCLIFn = func(clientCtx client.Context, flags *pflag.FlagSet, msgs ...sdk.Msg) error {
		require.Len(t, msgs, 1)
		msg, ok := msgs[0].(*types.MsgOpenProviderPairing)
		require.True(t, ok)
		captured = *msg
		return nil
	}

	cmd := CmdOpenProviderPairing()
	cmd.SetArgs([]string{"pairing-123", "77"})

	err := cmd.Execute()
	require.NoError(t, err)
	require.Equal(t, from.String(), captured.Creator)
	require.Equal(t, "pairing-123", captured.PairingId)
	require.Equal(t, uint64(77), captured.ExpiresAt)
}

func TestCmdConfirmProviderPairingBuildsMessageAndBroadcasts(t *testing.T) {
	originalGetClientTxContext := getClientTxContextFn
	originalBroadcast := generateOrBroadcastTxCLIFn
	t.Cleanup(func() {
		getClientTxContextFn = originalGetClientTxContext
		generateOrBroadcastTxCLIFn = originalBroadcast
	})

	from := sdk.AccAddress(bytes20(4))
	getClientTxContextFn = func(cmd *cobra.Command) (client.Context, error) {
		return client.Context{FromAddress: from}, nil
	}

	var captured types.MsgConfirmProviderPairing
	generateOrBroadcastTxCLIFn = func(clientCtx client.Context, flags *pflag.FlagSet, msgs ...sdk.Msg) error {
		require.Len(t, msgs, 1)
		msg, ok := msgs[0].(*types.MsgConfirmProviderPairing)
		require.True(t, ok)
		captured = *msg
		return nil
	}

	cmd := CmdConfirmProviderPairing()
	cmd.SetArgs([]string{"pairing-456"})

	err := cmd.Execute()
	require.NoError(t, err)
	require.Equal(t, from.String(), captured.Creator)
	require.Equal(t, "pairing-456", captured.PairingId)
}

func TestCmdUnpairProviderBuildsMessageAndBroadcasts(t *testing.T) {
	originalGetClientTxContext := getClientTxContextFn
	originalBroadcast := generateOrBroadcastTxCLIFn
	t.Cleanup(func() {
		getClientTxContextFn = originalGetClientTxContext
		generateOrBroadcastTxCLIFn = originalBroadcast
	})

	from := sdk.AccAddress(bytes20(5))
	getClientTxContextFn = func(cmd *cobra.Command) (client.Context, error) {
		return client.Context{FromAddress: from}, nil
	}

	var captured types.MsgUnpairProvider
	generateOrBroadcastTxCLIFn = func(clientCtx client.Context, flags *pflag.FlagSet, msgs ...sdk.Msg) error {
		require.Len(t, msgs, 1)
		msg, ok := msgs[0].(*types.MsgUnpairProvider)
		require.True(t, ok)
		captured = *msg
		return nil
	}

	cmd := CmdUnpairProvider()
	cmd.SetArgs([]string{"nil1provideraddress"})

	err := cmd.Execute()
	require.NoError(t, err)
	require.Equal(t, from.String(), captured.Creator)
	require.Equal(t, "nil1provideraddress", captured.Provider)
}

func bytes20(fill byte) []byte {
	out := make([]byte, 20)
	for i := range out {
		out[i] = fill
	}
	return out
}

package cli

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"github.com/cosmos/cosmos-sdk/client"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"
	"strings"
	"testing"

	"polystorechain/x/polystorechain/types"
)

func TestDecodeHexBytes(t *testing.T) {
	value := "0x" + strings.Repeat("11", types.POLYFS_ROOT_SIZE)
	out, err := decodeHexBytes(value, types.POLYFS_ROOT_SIZE)
	if err != nil {
		t.Fatalf("decodeHexBytes failed: %v", err)
	}
	if len(out) != types.POLYFS_ROOT_SIZE {
		t.Fatalf("expected %d bytes, got %d", types.POLYFS_ROOT_SIZE, len(out))
	}

	_, err = decodeHexBytes("0x"+strings.Repeat("22", 16), types.POLYFS_ROOT_SIZE)
	if err == nil {
		t.Fatal("expected error for invalid length")
	}
}

func TestDecodeSessionID(t *testing.T) {
	raw := make([]byte, 32)
	for i := range raw {
		raw[i] = byte(i)
	}
	hexStr := hex.EncodeToString(raw)
	for _, input := range []string{hexStr, "0x" + hexStr} {
		out, err := decodeSessionID(input)
		if err != nil {
			t.Fatalf("decodeSessionID hex failed: %v", err)
		}
		if !bytes.Equal(out, raw) {
			t.Fatalf("decodeSessionID hex mismatch")
		}
	}

	for _, input := range []string{
		base64.StdEncoding.EncodeToString(raw),
		base64.RawStdEncoding.EncodeToString(raw),
	} {
		out, err := decodeSessionID(input)
		if err != nil {
			t.Fatalf("decodeSessionID base64 failed: %v", err)
		}
		if !bytes.Equal(out, raw) {
			t.Fatalf("decodeSessionID base64 mismatch")
		}
	}

	_, err := decodeSessionID("0x1234")
	if err == nil {
		t.Fatal("expected error for invalid session id")
	}
}

func TestOpenRetrievalSessionSecurityFlags(t *testing.T) {
	cdc, config := retrievalTestEncoding()
	signer, payee := sdk.AccAddress(bytes20(7)), sdk.AccAddress(bytes20(8))
	for _, tc := range []struct {
		name    string
		args    []string
		version uint32
		payee   string
		bad     bool
	}{
		{name: "legacy"},
		{name: "v2", args: []string{"--challenge-version", "2"}, version: 2},
		{name: "deputy", args: []string{"--challenge-version", "2", "--authorized-proof-provider", payee.String()}, version: 2, payee: payee.String()},
		{name: "legacy-deputy", args: []string{"--authorized-proof-provider", payee.String()}, bad: true},
		{name: "unknown", args: []string{"--challenge-version", "1"}, bad: true},
		{name: "malformed", args: []string{"--challenge-version", "2", "--authorized-proof-provider", "bad"}, bad: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			output := &bytes.Buffer{}
			ctx := client.Context{}.WithCodec(cdc).WithTxConfig(config).WithFromAddress(signer).WithChainID("cli-test").WithGenerateOnly(true).WithOutput(output)
			cmd := CmdOpenRetrievalSession()
			cmd.SetContext(context.Background())
			require.NoError(t, client.SetCmdClientContext(cmd, ctx))
			cmd.SetOut(&bytes.Buffer{})
			cmd.SetErr(&bytes.Buffer{})
			args := []string{"--deal-id", "9007199254740993", "--provider", signer.String(), "--manifest-root", strings.Repeat("11", 32), "--start-mdu-index", "2", "--blob-count", "1", "--nonce", "1", "--expires-at", "100", "--gas", "1000000"}
			cmd.SetArgs(append(args, tc.args...))
			err := cmd.Execute()
			if tc.bad {
				require.Error(t, err)
				require.Empty(t, output.Bytes())
				return
			}
			require.NoError(t, err)
			transaction, err := config.TxJSONDecoder()(output.Bytes())
			require.NoError(t, err)
			require.Len(t, transaction.GetMsgs(), 1)
			msg := transaction.GetMsgs()[0].(*types.MsgOpenRetrievalSession)
			require.Equal(t, uint64(9007199254740993), msg.DealId)
			require.Equal(t, tc.version, msg.ChallengeVersion)
			require.Equal(t, tc.payee, msg.AuthorizedProofProvider)
		})
	}
}

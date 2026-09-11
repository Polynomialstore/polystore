package cmd

import (
	"bufio"
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cosmos/cosmos-sdk/client"
	sdk "github.com/cosmos/cosmos-sdk/types"
	moduletestutil "github.com/cosmos/cosmos-sdk/types/module/testutil"
	"github.com/cosmos/cosmos-sdk/x/auth"
)

func TestEncodeBatchCommand(t *testing.T) {
	encoding := moduletestutil.MakeTestEncodingConfig(auth.AppModuleBasic{})
	clientCtx := client.Context{}.WithTxConfig(encoding.TxConfig).WithCodec(encoding.Codec)
	execute := func(args ...string) error {
		cmd := newEncodeBatchCommand()
		cmd.SetArgs(args)
		ctx := context.WithValue(context.Background(), client.ClientContextKey, &clientCtx)
		return cmd.ExecuteContext(ctx)
	}

	t.Run("preserves file and transaction order", func(t *testing.T) {
		directory := t.TempDir()
		inputs, expected := []string{}, []string{}
		for i, memo := range []string{"first", "second"} {
			builder := encoding.TxConfig.NewTxBuilder()
			builder.SetGasLimit(uint64(50_000 + i))
			builder.SetFeeAmount(sdk.Coins{sdk.NewInt64Coin("stake", int64(150+i))})
			builder.SetMemo(memo)
			jsonTx, err := encoding.TxConfig.TxJSONEncoder()(builder.GetTx())
			if err != nil {
				t.Fatal(err)
			}
			input := filepath.Join(directory, memo+".jsonl")
			if err := os.WriteFile(input, append(jsonTx, '\n'), 0o600); err != nil {
				t.Fatal(err)
			}
			inputs = append(inputs, input)
			raw, err := encoding.TxConfig.TxEncoder()(builder.GetTx())
			if err != nil {
				t.Fatal(err)
			}
			expected = append(expected, base64.StdEncoding.EncodeToString(raw))
		}
		output := filepath.Join(directory, "encoded.txt")
		if err := execute(append(inputs, "--output-document", output)...); err != nil {
			t.Fatal(err)
		}
		contents, err := os.ReadFile(output)
		if err != nil {
			t.Fatal(err)
		}
		if got, want := strings.TrimSpace(string(contents)), strings.Join(expected, "\n"); got != want {
			t.Fatalf("encoded transactions = %q, want %q", got, want)
		}
	})

	t.Run("returns JSON decode errors", func(t *testing.T) {
		input := filepath.Join(t.TempDir(), "malformed.jsonl")
		if err := os.WriteFile(input, []byte("not-json\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := execute(input); err == nil {
			t.Fatal("expected JSON decode error")
		}
	})

	t.Run("returns scanner errors", func(t *testing.T) {
		input := filepath.Join(t.TempDir(), "oversized.jsonl")
		if err := os.WriteFile(input, []byte(strings.Repeat("x", bufio.MaxScanTokenSize+1)), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := execute(input); err == nil || !strings.Contains(err.Error(), "token too long") {
			t.Fatalf("scanner error = %v", err)
		}
	})
}

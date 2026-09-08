package cmd

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	svrcmd "github.com/cosmos/cosmos-sdk/server/cmd"
	evmconfig "github.com/cosmos/evm/server/config"
	"github.com/spf13/viper"
)

// Exercise the command after its real pre-run installs the EVM app.toml
// template. A plain SDK config here panics during validator file generation.
func TestMultiNodeRendersEVMAppConfig(t *testing.T) {
	dir := t.TempDir()
	outputDir := filepath.Join(dir, "nodes")
	root := NewRootCmd()
	var output bytes.Buffer
	root.SetOut(&output)
	root.SetErr(&output)
	root.SetArgs([]string{
		"multi-node", "--v", "1", "--output-dir", outputDir,
		"--chain-id", "polystore_260-1", "--starting-ip-address", "127.0.0.1",
		"--keyring-backend", "test", "--home", filepath.Join(dir, "bootstrap"),
	})
	if err := svrcmd.Execute(root, "", filepath.Join(dir, "bootstrap")); err != nil {
		t.Fatalf("multi-node: %v\n%s", err, output.String())
	}
	appPath := filepath.Join(outputDir, "validator0", "config", "app.toml")
	v := viper.New()
	v.SetConfigFile(appPath)
	if err := v.ReadInConfig(); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"evm.tracer", "json-rpc.enable", "tls.certificate-path"} {
		if !v.IsSet(field) {
			t.Errorf("validator app.toml missing %s", field)
		}
	}
	config, err := evmconfig.GetConfig(v)
	if err != nil {
		t.Fatal(err)
	}
	if config.EVM.Tracer != evmconfig.DefaultConfig().EVM.Tracer || config.API.Enable || config.MinGasPrices == "" {
		t.Fatalf("unexpected validator EVM/API/gas settings: %q, %v, %q", config.EVM.Tracer, config.API.Enable, config.MinGasPrices)
	}
	if _, err := os.Stat(filepath.Join(outputDir, "validator0", "config", "genesis.json")); err != nil {
		t.Fatalf("bootstrap did not finish writing genesis: %v", err)
	}
}

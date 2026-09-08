package cmd

import (
	"fmt"
	"os"
	"path/filepath"

	"cosmossdk.io/client/v2/autocli"
	"cosmossdk.io/depinject"
	"cosmossdk.io/log"
	"github.com/cosmos/cosmos-sdk/client"
	"github.com/cosmos/cosmos-sdk/client/config"
	"github.com/cosmos/cosmos-sdk/codec"
	codectypes "github.com/cosmos/cosmos-sdk/codec/types"
	"github.com/cosmos/cosmos-sdk/server"
	"github.com/cosmos/cosmos-sdk/types/module"
	"github.com/cosmos/cosmos-sdk/x/auth/tx"
	authtxconfig "github.com/cosmos/cosmos-sdk/x/auth/tx/config"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	"github.com/cosmos/cosmos-sdk/x/genutil"
	genutiltypes "github.com/cosmos/cosmos-sdk/x/genutil/types"
	"github.com/spf13/cobra"

	// Module Basic Managers Types (for minimal genutil)
	feemarket "github.com/cosmos/evm/x/feemarket"
	feemarkettypes "github.com/cosmos/evm/x/feemarket/types"
	evm "github.com/cosmos/evm/x/vm"
	evmtypes "github.com/cosmos/evm/x/vm/types"

	"polystorechain/app"
	"polystorechain/x/crypto_ffi"
)

// NewRootCmd creates a new root command for polystorechaind. It is called once in the main function.
func NewRootCmd() *cobra.Command {
	var (
		autoCliOpts        autocli.AppOptions
		moduleBasicManager module.BasicManager
		clientCtx          client.Context
	)

	if err := depinject.Inject(
		depinject.Configs(app.AppConfig(),
			depinject.Supply(log.NewNopLogger()),
			depinject.Provide(
				ProvideClientContext,
				app.ProvideCustomGetSigner,
			),
		),
		&autoCliOpts,
		&moduleBasicManager,
		&clientCtx,
	); err != nil {
		panic(err)
	}

	rootCmd := &cobra.Command{
		Use:           app.Name + "d",
		Short:         "polystorechain node",
		SilenceErrors: true,
		PersistentPreRunE: func(cmd *cobra.Command, _ []string) error {
			// Both commands run a validator. Reject an unusable setup before
			// opening stores or listeners. Other CLI commands do not need KZG;
			// local proof-generating commands initialize their explicit setup.
			if cmd.Name() == "start" || cmd.Name() == "in-place-testnet" {
				tsPath := validatorTrustedSetupPath()
				if err := crypto_ffi.Init(tsPath); err != nil {
					return fmt.Errorf("initialize validator KZG trusted setup %q: %w", tsPath, err)
				}
			}

			// set the default command outputs
			cmd.SetOut(cmd.OutOrStdout())
			cmd.SetErr(cmd.ErrOrStderr())

			clientCtx = clientCtx.WithCmdContext(cmd.Context()).WithViper(app.Name)
			clientCtx, err := client.ReadPersistentCommandFlags(clientCtx, cmd.Flags())
			if err != nil {
				return err
			}

			clientCtx, err = config.ReadFromClientConfig(clientCtx)
			if err != nil {
				return err
			}

			if err := client.SetCmdClientContextHandler(clientCtx, cmd); err != nil {
				return err
			}

			customAppTemplate, customAppConfig := initAppConfig()
			customCMTConfig := initCometBFTConfig()

			return server.InterceptConfigsPreRunHandler(cmd, customAppTemplate, customAppConfig, customCMTConfig)
		},
	}

	// Since the IBC modules don't support dependency injection, we need to
	// manually register the modules on the client side.
	// This needs to be removed after IBC supports App Wiring.
	ibcModules := app.RegisterIBC(clientCtx.Codec)
	for name, mod := range ibcModules {
		moduleBasicManager[name] = module.CoreAppModuleBasicAdaptor(name, mod)
		autoCliOpts.Modules[name] = mod
	}

	// Manually register EVM basics so default genesis includes EVM/feemarket state.
	moduleBasicManager[evmtypes.ModuleName] = evm.AppModuleBasic{}
	moduleBasicManager[feemarkettypes.ModuleName] = feemarket.AppModuleBasic{}
	moduleBasicManager[genutiltypes.ModuleName] = genutil.NewAppModuleBasic(genutiltypes.DefaultMessageValidator)
	initRootCmd(rootCmd, clientCtx.TxConfig, moduleBasicManager)

	if err := autoCliOpts.EnhanceRootCommand(rootCmd); err != nil {
		panic(err)
	}

	return rootCmd
}

func validatorTrustedSetupPath() string {
	if path := os.Getenv("POLYSTORE_TRUSTED_SETUP"); path != "" {
		return path
	}
	path := "polystorechain/trusted_setup.txt"
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		return path
	}
	// release.sh packages bin/polystorechaind beside config/trusted_setup.txt.
	// Resolve a symlinked executable so launching outside the archive also works.
	if executable, err := os.Executable(); err == nil {
		if executable, err = filepath.EvalSymlinks(executable); err == nil {
			return filepath.Join(filepath.Dir(executable), "..", "config", "trusted_setup.txt")
		}
	}
	return path
}

// ProvideClientContext creates and provides a fully initialized client.Context,
// allowing it to be used for dependency injection and CLI operations.
func ProvideClientContext(
	appCodec codec.Codec,
	interfaceRegistry codectypes.InterfaceRegistry,
	txConfigOpts tx.ConfigOptions,
	legacyAmino *codec.LegacyAmino,
	basicManager module.BasicManager,
) client.Context {
	basicManager.RegisterInterfaces(interfaceRegistry)
	// app.AppConfig currently wires the core Cosmos modules, while EVM/feemarket are
	// registered manually in app.New(). Explicitly register their interfaces here
	// so the JSON-RPC server can decode MsgEthereumTx and extension options.
	evmtypes.RegisterInterfaces(interfaceRegistry)
	feemarkettypes.RegisterInterfaces(interfaceRegistry)
	basicManager.RegisterLegacyAminoCodec(legacyAmino)
	legacyAmino.RegisterConcrete(&authtypes.AccountRetriever{}, "cosmos-sdk/AccountRetriever", nil)

	clientCtx := client.Context{}.
		WithCodec(appCodec).
		WithInterfaceRegistry(interfaceRegistry).
		WithLegacyAmino(legacyAmino).
		WithInput(os.Stdin).
		WithAccountRetriever(authtypes.AccountRetriever{}).
		WithHomeDir(app.DefaultNodeHome).
		WithViper(app.Name) // env variable prefix

	// Read the config again to overwrite the default values with the values from the config file
	clientCtx, _ = config.ReadFromClientConfig(clientCtx)

	// textual is enabled by default, we need to re-create the tx config grpc instead of bank keeper.
	txConfigOpts.TextualCoinMetadataQueryFn = authtxconfig.NewGRPCCoinMetadataQueryFn(clientCtx)
	txConfig, err := tx.NewTxConfigWithOptions(clientCtx.Codec, txConfigOpts)
	if err != nil {
		panic(err)
	}
	clientCtx = clientCtx.WithTxConfig(txConfig)

	return clientCtx
}

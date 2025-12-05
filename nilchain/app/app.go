package app

import (
	"io"

	clienthelpers "cosmossdk.io/client/v2/helpers"
	"cosmossdk.io/core/appmodule"
	"cosmossdk.io/depinject"
	"cosmossdk.io/log"
	storetypes "cosmossdk.io/store/types"
	circuitkeeper "cosmossdk.io/x/circuit/keeper"
	upgradekeeper "cosmossdk.io/x/upgrade/keeper"
	feegrantkeeper "cosmossdk.io/x/feegrant/keeper"

	abci "github.com/cometbft/cometbft/abci/types"
	dbm "github.com/cosmos/cosmos-db"
	"github.com/cosmos/cosmos-sdk/baseapp"
	"github.com/cosmos/cosmos-sdk/client"
	"github.com/cosmos/cosmos-sdk/codec"
	codectypes "github.com/cosmos/cosmos-sdk/codec/types"
	"github.com/cosmos/cosmos-sdk/runtime"
	"github.com/cosmos/cosmos-sdk/server"
	"github.com/cosmos/cosmos-sdk/server/api"
	"github.com/cosmos/cosmos-sdk/server/config"
	servertypes "github.com/cosmos/cosmos-sdk/server/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/cosmos-sdk/types/module"
	"github.com/cosmos/cosmos-sdk/x/auth"
	sdkante "github.com/cosmos/cosmos-sdk/x/auth/ante"
	authkeeper "github.com/cosmos/cosmos-sdk/x/auth/keeper"
	authsims "github.com/cosmos/cosmos-sdk/x/auth/simulation"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	authzkeeper "github.com/cosmos/cosmos-sdk/x/authz/keeper"
	bankkeeper "github.com/cosmos/cosmos-sdk/x/bank/keeper"
	consensuskeeper "github.com/cosmos/cosmos-sdk/x/consensus/keeper"
	distrkeeper "github.com/cosmos/cosmos-sdk/x/distribution/keeper"
	_ "github.com/cosmos/cosmos-sdk/x/genutil"
	govkeeper "github.com/cosmos/cosmos-sdk/x/gov/keeper"
	// govtypes "github.com/cosmos/cosmos-sdk/x/gov/types"
	mintkeeper "github.com/cosmos/cosmos-sdk/x/mint/keeper"
	paramskeeper "github.com/cosmos/cosmos-sdk/x/params/keeper"
	paramstypes "github.com/cosmos/cosmos-sdk/x/params/types"
	slashingkeeper "github.com/cosmos/cosmos-sdk/x/slashing/keeper"
	stakingkeeper "github.com/cosmos/cosmos-sdk/x/staking/keeper"
	icacontrollerkeeper "github.com/cosmos/ibc-go/v10/modules/apps/27-interchain-accounts/controller/keeper"
	icahostkeeper "github.com/cosmos/ibc-go/v10/modules/apps/27-interchain-accounts/host/keeper"
	ibctransferkeeper "github.com/cosmos/ibc-go/v10/modules/apps/transfer/keeper"
	ibckeeper "github.com/cosmos/ibc-go/v10/modules/core/keeper"

	// EVM Imports
	// codecaddress "github.com/cosmos/cosmos-sdk/codec/address"
	// ethcommon "github.com/ethereum/go-ethereum/common"
	// evmante "github.com/cosmos/evm/ante"
	// evm "github.com/cosmos/evm/x/vm"
	// evmkeeper "github.com/cosmos/evm/x/vm/keeper"
	// evmtypes "github.com/cosmos/evm/x/vm/types"
	// feemarket "github.com/cosmos/evm/x/feemarket"
	// feemarketkeeper "github.com/cosmos/evm/x/feemarket/keeper"
	// feemarkettypes "github.com/cosmos/evm/x/feemarket/types"

	"nilchain/docs"
	nilchainmodulekeeper "nilchain/x/nilchain/keeper"
)

const (
	// Name is the name of the application.
	Name = "nilchain"
	// AccountAddressPrefix is the prefix for accounts addresses.
	AccountAddressPrefix = "nil"
	// ChainCoinType is the coin type of the chain.
	ChainCoinType = 118
)

// DefaultNodeHome default home directories for the application daemon
var DefaultNodeHome string

var (
	_ runtime.AppI            = (*App)(nil)
	_ servertypes.Application = (*App)(nil)
)

// App extends an ABCI application, but with most of its parameters exported.
// They are exported for convenience in creating helper functions, as object
// capabilities aren't needed for testing.
type App struct {
	*runtime.App
	legacyAmino       *codec.LegacyAmino
	appCodec          codec.Codec
	txConfig          client.TxConfig
	interfaceRegistry codectypes.InterfaceRegistry

	// keepers
	// only keepers required by the app are exposed
	// the list of all modules is available in the app_config
	AuthKeeper            authkeeper.AccountKeeper
	BankKeeper            bankkeeper.Keeper
	StakingKeeper         *stakingkeeper.Keeper
	SlashingKeeper        slashingkeeper.Keeper
	MintKeeper            mintkeeper.Keeper
	DistrKeeper           distrkeeper.Keeper
	GovKeeper             *govkeeper.Keeper
	UpgradeKeeper         *upgradekeeper.Keeper
	AuthzKeeper           authzkeeper.Keeper
	ConsensusParamsKeeper consensuskeeper.Keeper
	CircuitBreakerKeeper  circuitkeeper.Keeper
	ParamsKeeper          paramskeeper.Keeper
	FeegrantKeeper        feegrantkeeper.Keeper

	// ibc keepers
	IBCKeeper           *ibckeeper.Keeper
	ICAControllerKeeper icacontrollerkeeper.Keeper
	ICAHostKeeper       icahostkeeper.Keeper
	TransferKeeper      ibctransferkeeper.Keeper

	// EVM Keepers
	// EVMKeeper       *evmkeeper.Keeper
	// FeeMarketKeeper *feemarketkeeper.Keeper

	// simulation manager
	sm             *module.SimulationManager
	NilchainKeeper nilchainmodulekeeper.Keeper
}

func init() {
	var err error
	clienthelpers.EnvPrefix = Name
	DefaultNodeHome, err = clienthelpers.GetNodeHomeDirectory("." + Name)
	if err != nil {
		panic(err)
	}
}

// AppConfig returns the default app config.
func AppConfig() depinject.Config {
	return appConfig
}

// New returns a reference to an initialized App.
func New(
	logger log.Logger,
	db dbm.DB,
	traceStore io.Writer,
	loadLatest bool,
	appOpts servertypes.AppOptions,
	baseAppOptions ...func(*baseapp.BaseApp),
) *App {
	var (
		app        = &App{}
		appBuilder *runtime.AppBuilder

		// merge the AppConfig and other configuration in one config
		appConfig = depinject.Configs(
			AppConfig(),
			depinject.Supply(
				appOpts, // supply app options
				logger,  // supply logger
				// here alternative options can be supplied to the DI container.
				// those options can be used f.e to override the default behavior of some modules.
				// for instance supplying a custom address codec for not using bech32 addresses.
				// read the depinject documentation and depinject module wiring for more information
				// on available options and how to use them.
			),
		)
	)

	var appModules map[string]appmodule.AppModule
	if err := depinject.Inject(appConfig,
		&appBuilder,
		&appModules,
		&app.appCodec,
		&app.legacyAmino,
		&app.txConfig,
		&app.interfaceRegistry,
		&app.AuthKeeper,
		&app.BankKeeper,
		&app.StakingKeeper,
		&app.SlashingKeeper,
		&app.MintKeeper,
		&app.DistrKeeper,
		&app.GovKeeper,
		&app.UpgradeKeeper,
		&app.AuthzKeeper,
		&app.ConsensusParamsKeeper,
		&app.CircuitBreakerKeeper,
		&app.ParamsKeeper,
		&app.FeegrantKeeper,
		&app.NilchainKeeper,
		// &app.EVMKeeper,
		// &app.FeeMarketKeeper,
	); err != nil {
		panic(err)
	}

	app.App = appBuilder.Build(db, traceStore, baseAppOptions...)

	// ----------------------------------------------------------------------------

	// EVM & FeeMarket Manual Wiring

	// ----------------------------------------------------------------------------
	// NOTE: EVM IS DISABLED FOR SIMULATION TESTS
	// 1. Now we can get the keys
	// evmKey := app.UnsafeFindStoreKey(evmtypes.StoreKey)
	// fmKey := app.UnsafeFindStoreKey(feemarkettypes.StoreKey)
	
	// 2. Manually Mount Transient Key (Runtime doesn't do this for us)
	// transientKey := storetypes.NewTransientStoreKey(evmtypes.TransientKey)
	// app.MountTransientStores(map[string]*storetypes.TransientStoreKey{evmtypes.TransientKey: transientKey})

	// 3. Initialize FeeMarket Keeper
	// We need the subspace.
	// fmKeeper := feemarketkeeper.NewKeeper(
	// 	app.appCodec,
	// 	authtypes.NewModuleAddress(govtypes.ModuleName), // Authority
	// 	fmKey,
	// 	transientKey,
	// )
	// app.FeeMarketKeeper = &fmKeeper

	// 4. Initialize EVM Keeper
	// app.EVMKeeper = evmkeeper.NewKeeper(
	// 	app.appCodec,
	// 	evmKey,
	// 	transientKey,
	// 	map[string]*storetypes.KVStoreKey{}, // Hack: Empty store keys map
	// 	authtypes.NewModuleAddress(govtypes.ModuleName), // Authority
	// 	app.AuthKeeper,
	// 	app.BankKeeper,
	// 	app.StakingKeeper,
	// 	app.FeeMarketKeeper,
	// 	app.ConsensusParamsKeeper,
	// 	nil, // Erc20Keeper
	// 	0,   // ChainID (will be set from genesis?)
	// 	"",  // HomePath
	// )

	// 5. Update Modules in the Manager with the Real Keepers
	// We create the REAL modules now.
	// addressCodec := codecaddress.NewBech32Codec(AccountAddressPrefix)
	// realEvmModule := evm.NewAppModule(app.EVMKeeper, app.AuthKeeper, app.BankKeeper, addressCodec)
	// realFmModule := feemarket.NewAppModule(*app.FeeMarketKeeper)

	// We need to swap them in the ModuleManager.
	// The ModuleManager was created during `appBuilder.Build`.
	// It holds the dummy modules.
	// app.ModuleManager.Modules[evmtypes.ModuleName] = realEvmModule
	// app.ModuleManager.Modules[feemarkettypes.ModuleName] = realFmModule

	// Manually update module order
	// We append EVM modules to the end of the lists maintained by runtime
	// Note: We need to get the current order first?
	// runtime sets the order in ModuleManager during Build.
	// app.ModuleManager.SetOrderBeginBlockers(append(app.ModuleManager.OrderBeginBlockers, feemarkettypes.ModuleName, evmtypes.ModuleName)...)
	// app.ModuleManager.SetOrderEndBlockers(append(app.ModuleManager.OrderEndBlockers, evmtypes.ModuleName, feemarkettypes.ModuleName)...)
	// app.ModuleManager.SetOrderInitGenesis(append(app.ModuleManager.OrderInitGenesis, evmtypes.ModuleName, feemarkettypes.ModuleName)...)

	// 6. Set AnteHandler
	// options := evmante.HandlerOptions{
	// 	Cdc:               app.appCodec,
	// 	AccountKeeper:     app.AuthKeeper,
	// 	BankKeeper:        app.BankKeeper,
	// 	IBCKeeper:         app.IBCKeeper,
	// 	FeeMarketKeeper:   app.FeeMarketKeeper,
	// 	EvmKeeper:         app.EVMKeeper,
	// 	FeegrantKeeper:    app.FeegrantKeeper,
	// 	SignModeHandler:   app.txConfig.SignModeHandler(),
	// 	SigGasConsumer:    sdkante.DefaultSigVerificationGasConsumer,
	// 	PendingTxListener: func(ethcommon.Hash) {}, // No-op
	// }
	
	// if err := options.Validate(); err != nil {
	// 	panic(err)
	// }

	// app.SetAnteHandler(evmante.NewAnteHandler(options))

	// Fallback AnteHandler
	anteHandler, err := sdkante.NewAnteHandler(
		sdkante.HandlerOptions{
			AccountKeeper:   app.AuthKeeper,
			BankKeeper:      app.BankKeeper,
			SignModeHandler: app.txConfig.SignModeHandler(),
			FeegrantKeeper:  app.FeegrantKeeper,
			SigGasConsumer:  sdkante.DefaultSigVerificationGasConsumer,
		},
	)
	if err != nil {
		panic(err)
	}
	app.SetAnteHandler(anteHandler)

	// ----------------------------------------------------------------------------

	// register legacy modules
	if err := app.registerIBCModules(appOpts); err != nil {
		panic(err)
	}

	/****  Module Options ****/

	// create the simulation manager and define the order of the modules for deterministic simulations
	// NOTE: We exclude EVM and FeeMarket from simulation for now to avoid MsgEthereumTx signer panics.
	overrideModules := map[string]module.AppModuleSimulation{
		authtypes.ModuleName: auth.NewAppModule(app.appCodec, app.AuthKeeper, authsims.RandomGenesisAccounts, nil),
		// evmtypes.ModuleName:       realEvmModule,
		// feemarkettypes.ModuleName: realFmModule,
	}
	app.sm = module.NewSimulationManagerFromAppModules(app.ModuleManager.Modules, overrideModules)

	app.sm.RegisterStoreDecoders()

	// A custom InitChainer sets if extra pre-init-genesis logic is required.
	// This is necessary for manually registered modules that do not support app wiring.
	// Manually set the module version map as shown below.
	// The upgrade module will automatically handle de-duplication of the module version map.
	app.SetInitChainer(func(ctx sdk.Context, req *abci.RequestInitChain) (*abci.ResponseInitChain, error) {
		if err := app.UpgradeKeeper.SetModuleVersionMap(ctx, app.ModuleManager.GetVersionMap()); err != nil {
			return nil, err
		}
		return app.App.InitChainer(ctx, req)
	})

	if err := app.Load(loadLatest); err != nil {
		panic(err)
	}

	return app
}

// GetSubspace returns a param subspace for a given module name.
func (app *App) GetSubspace(moduleName string) paramstypes.Subspace {
	subspace, _ := app.ParamsKeeper.GetSubspace(moduleName)
	return subspace
}

// LegacyAmino returns App's amino codec.
func (app *App) LegacyAmino() *codec.LegacyAmino {
	return app.legacyAmino
}

// AppCodec returns App's app codec.
func (app *App) AppCodec() codec.Codec {
	return app.appCodec
}

// InterfaceRegistry returns App's InterfaceRegistry.
func (app *App) InterfaceRegistry() codectypes.InterfaceRegistry {
	return app.interfaceRegistry
}

// TxConfig returns App's TxConfig
func (app *App) TxConfig() client.TxConfig {
	return app.txConfig
}

// GetKey returns the KVStoreKey for the provided store key.
func (app *App) GetKey(storeKey string) *storetypes.KVStoreKey {
	kvStoreKey, ok := app.UnsafeFindStoreKey(storeKey).(*storetypes.KVStoreKey)
	if !ok {
		return nil
	}
	return kvStoreKey
}

// SimulationManager implements the SimulationApp interface
func (app *App) SimulationManager() *module.SimulationManager {
	return app.sm
}

// RegisterAPIRoutes registers all application module routes with the provided
// API server.
func (app *App) RegisterAPIRoutes(apiSvr *api.Server, apiConfig config.APIConfig) {
	app.App.RegisterAPIRoutes(apiSvr, apiConfig)
	// register swagger API in app.go so that other applications can override easily
	if err := server.RegisterSwaggerAPI(apiSvr.ClientCtx, apiSvr.Router, apiConfig.Swagger); err != nil {
		panic(err)
	}

	// register app's OpenAPI routes.
	docs.RegisterOpenAPIService(Name, apiSvr.Router)
}

// GetMaccPerms returns a copy of the module account permissions
//
// NOTE: This is solely to be used for testing purposes.
func GetMaccPerms() map[string][]string {
	dup := make(map[string][]string)
	for _, perms := range moduleAccPerms {
		dup[perms.GetAccount()] = perms.GetPermissions()
	}

	return dup
}

// BlockedAddresses returns all the app's blocked account addresses.
func BlockedAddresses() map[string]bool {
	result := make(map[string]bool)

	if len(blockAccAddrs) > 0 {
		for _, addr := range blockAccAddrs {
			result[addr] = true
		}
	} else {
		for addr := range GetMaccPerms() {
			result[addr] = true
		}
	}

	return result
}

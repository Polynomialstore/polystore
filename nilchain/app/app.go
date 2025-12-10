package app

import (
	"io"

	clienthelpers "cosmossdk.io/client/v2/helpers"
	"cosmossdk.io/core/appmodule"
	"cosmossdk.io/depinject"
	"cosmossdk.io/log"
	storetypes "cosmossdk.io/store/types"
	circuitkeeper "cosmossdk.io/x/circuit/keeper"
	feegrantkeeper "cosmossdk.io/x/feegrant/keeper"
	"cosmossdk.io/x/tx/signing"
	upgradekeeper "cosmossdk.io/x/upgrade/keeper"
	gogoproto "github.com/cosmos/gogoproto/proto"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"

	abci "github.com/cometbft/cometbft/abci/types"
	dbm "github.com/cosmos/cosmos-db"
	"github.com/cosmos/cosmos-sdk/baseapp"
	gogogrpc "github.com/cosmos/gogoproto/grpc"
	"github.com/cosmos/cosmos-sdk/client"
	"github.com/cosmos/cosmos-sdk/codec"
	codectypes "github.com/cosmos/cosmos-sdk/codec/types"
	"github.com/cosmos/cosmos-sdk/runtime"
	"github.com/cosmos/cosmos-sdk/server"
	"github.com/cosmos/cosmos-sdk/server/api"
	"github.com/cosmos/cosmos-sdk/server/config"
	servertypes "github.com/cosmos/cosmos-sdk/server/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkmempool "github.com/cosmos/cosmos-sdk/types/mempool"
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
	govtypes "github.com/cosmos/cosmos-sdk/x/gov/types"
	mintkeeper "github.com/cosmos/cosmos-sdk/x/mint/keeper"
	paramskeeper "github.com/cosmos/cosmos-sdk/x/params/keeper"
	paramstypes "github.com/cosmos/cosmos-sdk/x/params/types"
	slashingkeeper "github.com/cosmos/cosmos-sdk/x/slashing/keeper"
	stakingkeeper "github.com/cosmos/cosmos-sdk/x/staking/keeper"
	icacontrollerkeeper "github.com/cosmos/ibc-go/v10/modules/apps/27-interchain-accounts/controller/keeper"
	icahostkeeper "github.com/cosmos/ibc-go/v10/modules/apps/27-interchain-accounts/host/keeper"
	icatypes "github.com/cosmos/ibc-go/v10/modules/apps/27-interchain-accounts/types"
	ibctransferkeeper "github.com/cosmos/ibc-go/v10/modules/apps/transfer/keeper"
	ibctransfertypes "github.com/cosmos/ibc-go/v10/modules/apps/transfer/types"
	ibcexported "github.com/cosmos/ibc-go/v10/modules/core/exported"
	ibckeeper "github.com/cosmos/ibc-go/v10/modules/core/keeper"

	// EVM Imports
	codecaddress "github.com/cosmos/cosmos-sdk/codec/address"
	evmante "github.com/cosmos/evm/ante"
	feemarket "github.com/cosmos/evm/x/feemarket"
	feemarketkeeper "github.com/cosmos/evm/x/feemarket/keeper"
	feemarkettypes "github.com/cosmos/evm/x/feemarket/types"
	evm "github.com/cosmos/evm/x/vm"
	evmkeeper "github.com/cosmos/evm/x/vm/keeper"
	evmtypes "github.com/cosmos/evm/x/vm/types"
	ethcommon "github.com/ethereum/go-ethereum/common"

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
	EVMKeeper       *evmkeeper.Keeper
	FeeMarketKeeper *feemarketkeeper.Keeper

	// EVM JSON-RPC integration
	clientCtx          client.Context
	pendingTxListeners []evmante.PendingTxListener
	evmMempool         sdkmempool.ExtMempool

	// simulation manager
	sm             *module.SimulationManager
	NilchainKeeper nilchainmodulekeeper.Keeper

	// cached server options and logger (used by runtime-wired components like the EVM mempool)
	appOpts servertypes.AppOptions
	logger  log.Logger
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
		app        = &App{
			appOpts: appOpts,
			logger:  logger,
		}
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
			depinject.Provide(
				ProvideCustomGetSigner,
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
	); err != nil {
		panic(err)
	}

	app.App = appBuilder.Build(db, traceStore, baseAppOptions...)

	// register legacy modules
	if err := app.registerIBCModules(appOpts); err != nil {
		panic(err)
	}

	// Ensure the GRPC query router and msg service router are initialized so we can
	// register additional gRPC services (such as the EVM query and msg servers)
	// before the gRPC server is started.
	//
	// The underlying BaseApp already initializes these, but we defensively ensure
	// they are non-nil and implement the expected gogo grpc Server interface.
	if app.GRPCQueryRouter() == nil {
		app.SetGRPCQueryRouter(baseapp.NewGRPCQueryRouter())
	}
	if app.MsgServiceRouter() == nil {
		app.SetMsgServiceRouter(baseapp.NewMsgServiceRouter())
	}
	if _, ok := any(app.GRPCQueryRouter()).(gogogrpc.Server); !ok {
		panic("GRPCQueryRouter does not implement gogogrpc.Server")
	}
	if _, ok := any(app.MsgServiceRouter()).(gogogrpc.Server); !ok {
		panic("MsgServiceRouter does not implement gogogrpc.Server")
	}

	// Manually register EVM and FeeMarket stores and keepers (not wired via depinject).
	if err := app.RegisterStores(
		storetypes.NewKVStoreKey(evmtypes.StoreKey),
		storetypes.NewKVStoreKey(feemarkettypes.StoreKey),
	); err != nil {
		panic(err)
	}

	evmKey, _ := app.UnsafeFindStoreKey(evmtypes.StoreKey).(*storetypes.KVStoreKey)
	fmKey, _ := app.UnsafeFindStoreKey(feemarkettypes.StoreKey).(*storetypes.KVStoreKey)
	if evmKey == nil || fmKey == nil {
		panic("failed to register EVM/FeeMarket store keys")
	}

	transientKey := storetypes.NewTransientStoreKey(evmtypes.TransientKey)
	app.MountTransientStores(map[string]*storetypes.TransientStoreKey{evmtypes.TransientKey: transientKey})

	fmKeeper := feemarketkeeper.NewKeeper(
		app.appCodec,
		authtypes.NewModuleAddress(govtypes.ModuleName), // Authority
		fmKey,
		transientKey,
	)
	app.FeeMarketKeeper = &fmKeeper

	evmKeeper := evmkeeper.NewKeeper(
		app.appCodec,
		evmKey,
		transientKey,
		map[string]*storetypes.KVStoreKey{evmtypes.StoreKey: evmKey},
		authtypes.NewModuleAddress(govtypes.ModuleName), // Authority
		app.AuthKeeper,
		app.BankKeeper,
		app.StakingKeeper,
		app.FeeMarketKeeper,
		app.ConsensusParamsKeeper,
		nil, // Erc20Keeper
		evmtypes.DefaultEVMChainID,
		"",
	)
	app.EVMKeeper = evmKeeper.WithDefaultEvmCoinInfo(
		evmtypes.EvmCoinInfo{
			Denom:         evmtypes.DefaultEVMExtendedDenom,
			ExtendedDenom: evmtypes.DefaultEVMExtendedDenom,
			DisplayDenom:  evmtypes.DefaultEVMDisplayDenom,
			Decimals:      uint32(evmtypes.DefaultEVMDecimals),
		},
	)

	addressCodec := codecaddress.NewBech32Codec(AccountAddressPrefix)
	realEvmModule := evm.NewAppModule(app.EVMKeeper, app.AuthKeeper, app.BankKeeper, addressCodec)
	realFmModule := feemarket.NewAppModule(*app.FeeMarketKeeper)

	if err := app.RegisterModules(realEvmModule, realFmModule); err != nil {
		panic(err)
	}

	// Set EVM ante handler using the DI-provided keepers.
	options := evmante.HandlerOptions{
		Cdc:               app.appCodec,
		AccountKeeper:     app.AuthKeeper,
		BankKeeper:        app.BankKeeper,
		IBCKeeper:         app.IBCKeeper,
		FeeMarketKeeper:   app.FeeMarketKeeper,
		EvmKeeper:         app.EVMKeeper,
		FeegrantKeeper:  app.FeegrantKeeper,
		SignModeHandler: app.txConfig.SignModeHandler(),
		SigGasConsumer:  sdkante.DefaultSigVerificationGasConsumer,
		// Wire the pending tx listener so the JSON-RPC server can stream new
		// Ethereum transactions from the mempool.
		PendingTxListener: app.onPendingTx,
	}

	if err := options.Validate(); err != nil {
		panic(err)
	}

	app.SetAnteHandler(evmante.NewAnteHandler(options))

	// ----------------------------------------------------------------------------

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

	// WORKAROUND: Temporarily remove manually wired modules from ModuleManager
	// to pass validation in app.Load() which resets module order based on AppConfig.
	manualModules := []string{
		ibcexported.ModuleName,
		ibctransfertypes.ModuleName,
		icatypes.ModuleName,
		evmtypes.ModuleName,
		feemarkettypes.ModuleName,
		"07-tendermint",  // ibctm.ModuleName
		"07-tendermint",  // ibctm.ModuleName
		"06-solomachine", // solomachine.ModuleName
	}
	cachedModules := make(map[string]interface{})
	for _, name := range manualModules {
		if mod, ok := app.ModuleManager.Modules[name]; ok {
			cachedModules[name] = mod
			delete(app.ModuleManager.Modules, name)
		}
	}

	// Init EVM mempool before sealing BaseApp (which happens in Load)
	if err := app.initEVMMempool(); err != nil {
		panic(err)
	}

	if err := app.Load(loadLatest); err != nil {
		panic(err)
	}

	// RESTORE manually wired modules
	for name, mod := range cachedModules {
		// We can cast it back to AppModule if needed, but Modules map seems to be interface{}
		if appMod, ok := mod.(module.AppModule); ok {
			app.ModuleManager.Modules[name] = appMod
		} else {
			// Fallback if it's not AppModule (e.g. AppModuleBasic only? shouldn't happen for Modules map)
			// Actually if Modules is map[string]AppModule, then mod IS AppModule.
			// If Modules is map[string]interface{}, we can just assign it back.
			// But compiler complained 'mod' is 'any'.
			// So Modules IS map[string]interface{} (or similar).
			// Let's try direct assignment if compiler allows.
			// But I can't assign 'any' to 'AppModule' if Modules is map[string]AppModule.
			// The error said: "cannot use mod (variable of interface type any) as ...AppModule value in assignment"
			// This confirms target IS AppModule, but source IS any.
			// So app.ModuleManager.Modules IS map[string]AppModule?
			// NO. The error said: "cannot use mod (variable of interface type any) as ...AppModule".
			// This happens if I try to assign TO cachedModules (which I defined as map[string]AppModule).
			// So 'mod' (from app.ModuleManager.Modules[name]) IS 'any'.
			// So app.ModuleManager.Modules IS map[string]any.
			// So I should define cachedModules as map[string]any.
			app.ModuleManager.Modules[name] = mod
		}
	}

	// Manually update module order lists to include restored modules
	app.ModuleManager.SetOrderBeginBlockers(append(app.ModuleManager.OrderBeginBlockers, ibcexported.ModuleName, feemarkettypes.ModuleName, evmtypes.ModuleName)...)
	app.ModuleManager.SetOrderEndBlockers(append(app.ModuleManager.OrderEndBlockers, evmtypes.ModuleName, feemarkettypes.ModuleName)...)
	app.ModuleManager.SetOrderInitGenesis(append(app.ModuleManager.OrderInitGenesis, ibcexported.ModuleName, ibctransfertypes.ModuleName, icatypes.ModuleName, feemarkettypes.ModuleName, evmtypes.ModuleName)...)

	return app
}

// GetSubspace returns a param subspace for a given module name.
func (app *App) GetSubspace(moduleName string) paramstypes.Subspace {
	subspace, _ := app.ParamsKeeper.GetSubspace(moduleName)
	return subspace
}

// RegisterPendingTxListener is used by the Cosmos EVM JSON-RPC server to
// subscribe to pending Ethereum transactions.
func (app *App) RegisterPendingTxListener(listener func(ethcommon.Hash)) {
	if listener == nil {
		return
	}
	app.pendingTxListeners = append(app.pendingTxListeners, listener)
}

// onPendingTx fan-outs a pending Ethereum tx hash to all registered listeners.
func (app *App) onPendingTx(hash ethcommon.Hash) {
	for _, listener := range app.pendingTxListeners {
		listener(hash)
	}
}

// GetMempool returns the underlying mempool used for EVM transactions.
func (app *App) GetMempool() sdkmempool.ExtMempool {
	return app.evmMempool
}

// SetClientCtx is called by the Cosmos EVM server stack once a client.Context
// is available.
func (app *App) SetClientCtx(clientCtx client.Context) {
	app.clientCtx = clientCtx
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

// ProvideCustomGetSigner returns a custom signer for MsgEthereumTx
// to bypass the runtime panic checks during initialization.
func ProvideCustomGetSigner() signing.CustomGetSigner {
	return signing.CustomGetSigner{
		MsgType: protoreflect.FullName(gogoproto.MessageName(&evmtypes.MsgEthereumTx{})),
		Fn: func(msg proto.Message) ([][]byte, error) {
			return nil, nil
		},
	}
}

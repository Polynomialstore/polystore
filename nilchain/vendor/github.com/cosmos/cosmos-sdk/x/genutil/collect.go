package genutil

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"

	cfg "github.com/cometbft/cometbft/config"

	"github.com/cosmos/cosmos-sdk/client"
	"github.com/cosmos/cosmos-sdk/codec"
	sdkruntime "github.com/cosmos/cosmos-sdk/runtime"
	sdk "github.com/cosmos/cosmos-sdk/types"
	authtx "github.com/cosmos/cosmos-sdk/x/auth/tx"
	bankexported "github.com/cosmos/cosmos-sdk/x/bank/exported"
	banktypes "github.com/cosmos/cosmos-sdk/x/bank/types"
	"github.com/cosmos/cosmos-sdk/x/genutil/types"
	stakingtypes "github.com/cosmos/cosmos-sdk/x/staking/types"
	evmtypes "github.com/cosmos/evm/x/vm/types"
)

// GenAppStateFromConfig gets the genesis app state from the config
func GenAppStateFromConfig(cdc codec.JSONCodec, txEncodingConfig client.TxEncodingConfig,
	config *cfg.Config, initCfg types.InitConfig, genesis *types.AppGenesis, genBalIterator types.GenesisBalancesIterator,
	validator types.MessageValidator, valAddrCodec sdkruntime.ValidatorAddressCodec,
) (appState json.RawMessage, err error) {
	txJSONDecoder := txEncodingConfig.TxJSONDecoder()
	if txJSONDecoder == nil {
		if fullCodec, ok := cdc.(codec.Codec); ok {
			txJSONDecoder = authtx.DefaultJSONTxDecoder(fullCodec)
		} else {
			return appState, fmt.Errorf("tx JSON decoder is nil and codec assertion failed")
		}
	}

	// process genesis transactions, else create default genesis.json
	appGenTxs, persistentPeers, err := CollectTxs(
		cdc, txJSONDecoder, config.Moniker, initCfg.GenTxsDir, genesis, genBalIterator, validator, valAddrCodec)
	if err != nil {
		return appState, err
	}

	config.P2P.PersistentPeers = persistentPeers
	cfg.WriteConfigFile(filepath.Join(config.RootDir, "config", "config.toml"), config)

	// if there are no gen txs to be processed, return the default empty state
	if len(appGenTxs) == 0 {
		return appState, errors.New("there must be at least one genesis tx")
	}

	// create the app state
	appGenesisState, err := types.GenesisStateFromAppGenesis(genesis)
	if err != nil {
		return appState, err
	}
	appGenesisState, err = ensureEvmDenomMetadata(cdc, appGenesisState)
	if err != nil {
		return appState, err
	}

	appGenesisState, err = SetGenTxsInAppGenesisState(cdc, txEncodingConfig.TxJSONEncoder(), appGenesisState, appGenTxs)
	if err != nil {
		return appState, err
	}

	appState, err = json.MarshalIndent(appGenesisState, "", "  ")
	if err != nil {
		return appState, err
	}

	genesis.AppState = appState
	err = ExportGenesisFile(genesis, config.GenesisFile())

	return appState, err
}

// CollectTxs processes and validates application's genesis Txs and returns
// the list of appGenTxs, and persistent peers required to generate genesis.json.
func CollectTxs(cdc codec.JSONCodec, txJSONDecoder sdk.TxDecoder, moniker, genTxsDir string,
	genesis *types.AppGenesis, genBalIterator types.GenesisBalancesIterator,
	validator types.MessageValidator, valAddrCodec sdkruntime.ValidatorAddressCodec,
) (appGenTxs []sdk.Tx, persistentPeers string, err error) {
	// prepare a map of all balances in genesis state to then validate
	// against the validators addresses
	var appState map[string]json.RawMessage
	if err := json.Unmarshal(genesis.AppState, &appState); err != nil {
		return appGenTxs, persistentPeers, err
	}

	var fos []os.DirEntry
	fos, err = os.ReadDir(genTxsDir)
	if err != nil {
		return appGenTxs, persistentPeers, err
	}

	balancesMap := make(map[string]bankexported.GenesisBalance)

	genBalIterator.IterateGenesisBalances(
		cdc, appState,
		func(balance bankexported.GenesisBalance) (stop bool) {
			addr := balance.GetAddress()
			balancesMap[addr] = balance
			return false
		},
	)

	// addresses and IPs (and port) validator server info
	var addressesIPs []string

	for _, fo := range fos {
		if fo.IsDir() {
			continue
		}
		if !strings.HasSuffix(fo.Name(), ".json") {
			continue
		}

		// get the genTx
		jsonRawTx, err := os.ReadFile(filepath.Join(genTxsDir, fo.Name()))
		if err != nil {
			return appGenTxs, persistentPeers, err
		}

		genTx, err := txJSONDecoder(jsonRawTx)
		if err != nil {
			return appGenTxs, persistentPeers, fmt.Errorf("failed to decode gentx %s: %w", fo.Name(), err)
		}
		if genTx == nil || (reflect.ValueOf(genTx).Kind() == reflect.Ptr && reflect.ValueOf(genTx).IsNil()) {
			return appGenTxs, persistentPeers, fmt.Errorf("decoded nil gentx for %s", fo.Name())
		}

		msgs := genTx.GetMsgs()
		if validator != nil {
			if err := validator(msgs); err != nil {
				return appGenTxs, persistentPeers, err
			}
		}

		appGenTxs = append(appGenTxs, genTx)

		// the memo flag is used to store
		// the ip and node-id, for example this may be:
		// "528fd3df22b31f4969b05652bfe8f0fe921321d5@192.168.2.37:26656"

		memoTx, ok := genTx.(sdk.TxWithMemo)
		if !ok {
			return appGenTxs, persistentPeers, fmt.Errorf("expected TxWithMemo, got %T", genTx)
		}
		nodeAddrIP := memoTx.GetMemo()

		// genesis transactions must be single-message
		// msgs already decoded above

		// TODO abstract out staking message validation back to staking
		msg := msgs[0].(*stakingtypes.MsgCreateValidator)

		// validate validator addresses and funds against the accounts in the state
		valAddr, err := valAddrCodec.StringToBytes(msg.ValidatorAddress)
		if err != nil {
			return appGenTxs, persistentPeers, err
		}

		valAccAddr := sdk.AccAddress(valAddr).String()

		delBal, delOk := balancesMap[valAccAddr]
		if !delOk {
			_, file, no, ok := runtime.Caller(1)
			if ok {
				fmt.Printf("CollectTxs-1, called from %s#%d\n", file, no)
			}

			return appGenTxs, persistentPeers, fmt.Errorf("account %s balance not in genesis state: %+v", valAccAddr, balancesMap)
		}

		_, valOk := balancesMap[sdk.AccAddress(valAddr).String()]
		if !valOk {
			_, file, no, ok := runtime.Caller(1)
			if ok {
				fmt.Printf("CollectTxs-2, called from %s#%d - %s\n", file, no, sdk.AccAddress(msg.ValidatorAddress).String())
			}
			return appGenTxs, persistentPeers, fmt.Errorf("account %s balance not in genesis state: %+v", valAddr, balancesMap)
		}

		if delBal.GetCoins().AmountOf(msg.Value.Denom).LT(msg.Value.Amount) {
			return appGenTxs, persistentPeers, fmt.Errorf(
				"insufficient fund for delegation %v: %v < %v",
				delBal.GetAddress(), delBal.GetCoins().AmountOf(msg.Value.Denom), msg.Value.Amount,
			)
		}

		// exclude itself from persistent peers
		if msg.Description.Moniker != moniker {
			addressesIPs = append(addressesIPs, nodeAddrIP)
		}
	}

	sort.Strings(addressesIPs)
	persistentPeers = strings.Join(addressesIPs, ",")

	return appGenTxs, persistentPeers, nil
}

func ensureEvmDenomMetadata(cdc codec.JSONCodec, genesis map[string]json.RawMessage) (map[string]json.RawMessage, error) {
	bankState, ok := genesis[banktypes.ModuleName]
	if !ok {
		return genesis, nil
	}

	var bankGen banktypes.GenesisState
	if err := cdc.UnmarshalJSON(bankState, &bankGen); err != nil {
		return genesis, err
	}

	for _, md := range bankGen.DenomMetadata {
		if md.Base == evmtypes.DefaultEVMExtendedDenom {
			return genesis, nil
		}
	}

	metadata := banktypes.Metadata{
		Description: "EVM fee token metadata",
		Base:        evmtypes.DefaultEVMExtendedDenom,
		Display:     evmtypes.DefaultEVMDisplayDenom,
		DenomUnits: []*banktypes.DenomUnit{
			{Denom: evmtypes.DefaultEVMExtendedDenom, Exponent: 0, Aliases: []string{evmtypes.DefaultEVMDenom}},
			{Denom: evmtypes.DefaultEVMDisplayDenom, Exponent: uint32(evmtypes.DefaultEVMDecimals)},
		},
	}

	bankGen.DenomMetadata = append(bankGen.DenomMetadata, metadata)
	genesis[banktypes.ModuleName] = cdc.MustMarshalJSON(&bankGen)

	return genesis, nil
}

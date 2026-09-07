package app

import (
	"errors"
	"fmt"
	"math/big"
	"strings"
	"testing"

	"cosmossdk.io/log"
	sdkmath "cosmossdk.io/math"
	storetypes "cosmossdk.io/store/types"
	cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"
	dbm "github.com/cosmos/cosmos-db"
	"github.com/cosmos/cosmos-sdk/baseapp"
	simtestutil "github.com/cosmos/cosmos-sdk/testutil/sims"
	sdk "github.com/cosmos/cosmos-sdk/types"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	cmn "github.com/cosmos/evm/precompiles/common"
	"github.com/cosmos/evm/x/vm/statedb"
	evmtypes "github.com/cosmos/evm/x/vm/types"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core"
	"github.com/ethereum/go-ethereum/core/vm"
	"github.com/ethereum/go-ethereum/params"
	"github.com/holiman/uint256"
	"github.com/stretchr/testify/require"

	polystoreprecompile "polystorechain/precompiles/polystore"
	types "polystorechain/x/polystorechain/types"
)

// callAndReturn forwards its calldata and returns the CALL success bit. Keeping
// the outer contract successful is essential: top-level failure hides the bug.
func callAndReturn(target common.Address, gas uint32, revert bool) []byte {
	code := []byte{0x36, 0x60, 0, 0x60, 0, 0x37, 0x60, 0, 0x60, 0, 0x36, 0x60, 0, 0x60, 0, 0x73}
	code = append(code, target.Bytes()...)
	code = append(code, 0x62, byte(gas>>16), byte(gas>>8), byte(gas), 0xf1)
	if revert {
		return append(code, 0x50, 0x60, 0, 0x60, 0, 0xfd)
	}
	return append(code, 0x60, 0, 0x52, 0x60, 32, 0x60, 0, 0xf3)
}

func TestNativePrecompileNestedRollback(t *testing.T) {
	a, baseCtx := nativePrecompileApp(t)
	for _, tc := range []struct {
		name    string
		revert  bool
		gas     uint32
		present bool
		sibling bool
	}{{"nested_success", false, 5000000, true, false}, {"caught_child_revert", true, 5000000, false, false}, {"caught_out_of_gas", false, 210000, false, false}, {"caught_revert_then_success", true, 5000000, false, true}} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, _ := baseCtx.CacheContext()
			require.NoError(t, a.PolyStoreChainKeeper.Params.Set(ctx, types.DefaultParams()))
			anteEvent := sdk.NewEvent("ante_marker", sdk.NewAttribute("id", "before-evm"))
			ctx.EventManager().EmitEvent(anteEvent)
			evm, state := nativeEVM(t, a, ctx)
			caller := common.HexToAddress("0xaa01")
			outer := common.HexToAddress("0xaa02")
			child := common.HexToAddress("0xaa03")
			state.SetCode(outer, callAndReturn(child, 8000000, false))
			state.SetCode(child, callAndReturn(polystoreprecompile.Address, tc.gas, tc.revert))
			sibling := common.HexToAddress("0xaa04")
			if tc.sibling {
				first := callAndReturn(child, 8000000, false)
				// Discard the first CALL result, then execute and return the sibling's result.
				first = append(first[:len(first)-8], 0x50)
				state.SetCode(outer, append(first, callAndReturn(sibling, 8000000, false)...))
				state.SetCode(sibling, callAndReturn(polystoreprecompile.Address, 5000000, false))
			}
			api, err := abi.JSON(strings.NewReader(`[{"name":"requestProviderLink","type":"function","inputs":[{"name":"operator","type":"string"}],"outputs":[{"name":"ok","type":"bool"}]}]`))
			require.NoError(t, err)
			input, err := api.Pack("requestProviderLink", sdk.AccAddress(caller.Bytes()).String())
			require.NoError(t, err)
			result, left, err := evm.Call(caller, outer, input, 12000000, uint256.NewInt(0))
			require.NoError(t, err)
			require.Len(t, result, 32)
			require.Less(t, left, uint64(12000000))
			require.Equal(t, sdk.Events{anteEvent}, ctx.EventManager().Events(), "native events remain private until Commit")
			require.NoError(t, state.Commit())
			require.Equal(t, anteEvent, ctx.EventManager().Events()[0], "preexisting caller event remains once")
			require.Equal(t, state.GetContext().EventManager().Events(), ctx.EventManager().Events()[1:])
			present, err := a.PolyStoreChainKeeper.PendingProviderLinks.Has(ctx, sdk.AccAddress(child.Bytes()).String())
			require.NoError(t, err)
			require.Equal(t, tc.present, present, "native child state must follow EVM rollback")
			if tc.revert && !tc.sibling {
				require.Zero(t, result[31])
			} else {
				require.Equal(t, byte(1), result[31])
			}
			if tc.sibling {
				present, err = a.PolyStoreChainKeeper.PendingProviderLinks.Has(ctx, sdk.AccAddress(sibling.Bytes()).String())
				require.NoError(t, err)
				require.True(t, present)
				events := []sdk.Event{}
				for _, e := range ctx.EventManager().Events() {
					if e.Type == types.TypeMsgRequestProviderLink {
						events = append(events, e)
					}
				}
				require.Len(t, events, 1, "only the successful sibling SDK event must survive")
				require.Contains(t, fmt.Sprint(events[0]), sdk.AccAddress(sibling.Bytes()).String())
				require.NotContains(t, fmt.Sprint(events[0]), sdk.AccAddress(child.Bytes()).String())
			}
		})
	}
}

func nativePrecompileApp(t *testing.T) (*App, sdk.Context) {
	t.Helper()
	a := New(log.NewNopLogger(), dbm.NewMemDB(), nil, true, simtestutil.AppOptionsMap{"home": t.TempDir(), "evm.evm-chain-id": evmtypes.DefaultEVMChainID}, baseapp.SetChainID(SimAppChainID))
	ctx := a.NewContextLegacy(true, cmtproto.Header{Height: 10, ChainID: SimAppChainID}).WithGasMeter(storetypes.NewInfiniteGasMeter()).WithKVGasConfig(storetypes.GasConfig{}).WithTransientKVGasConfig(storetypes.GasConfig{})
	evmParams := evmtypes.DefaultParams()
	evmParams.ActiveStaticPrecompiles = append(evmParams.ActiveStaticPrecompiles, polystoreprecompile.AddressHex)
	require.NoError(t, a.EVMKeeper.SetParams(ctx, evmParams))

	return a, ctx
}

func nativeEVM(t *testing.T, a *App, ctx sdk.Context) (*vm.EVM, *statedb.StateDB) {
	t.Helper()
	state := statedb.New(ctx, a.EVMKeeper, statedb.NewEmptyTxConfig())
	config := *params.AllEthashProtocolChanges
	config.ChainID = big.NewInt(31337)
	evm := vm.NewEVM(vm.BlockContext{CanTransfer: core.CanTransfer, Transfer: core.Transfer, BlockNumber: big.NewInt(10), GasLimit: 28000000}, state, &config, vm.Config{})
	contracts, found, err := a.EVMKeeper.GetPrecompileInstance(ctx, polystoreprecompile.Address)
	require.NoError(t, err)
	require.True(t, found)
	evm.SetPrecompiles(contracts.Map)
	return evm, state
}

func TestNativePrecompileBankRollback(t *testing.T) {
	a, baseCtx := nativePrecompileApp(t)
	api, err := abi.JSON(strings.NewReader(`[{"name":"createDeal","type":"function","inputs":[{"type":"uint64"},{"type":"string"},{"type":"uint256"},{"type":"uint256"}],"outputs":[{"type":"uint64"}]}]`))
	require.NoError(t, err)
	for _, tc := range []struct {
		name                     string
		revert, invalid, sibling bool
		gas                      uint32
	}{
		{"success", false, false, false, 5000000}, {"caught_revert", true, false, false, 5000000},
		{"error_after_fee_and_counter", false, true, false, 5000000}, {"out_of_gas", false, false, false, 280000}, {"revert_then_sibling_success", true, false, true, 5000000},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, _ := baseCtx.CacheContext()
			caller := common.HexToAddress("0xbb01")
			outer := common.HexToAddress("0xbb02")
			child := common.HexToAddress("0xbb03")
			owner := sdk.AccAddress(child.Bytes())
			sibling := common.HexToAddress("0xbb04")
			siblingOwner := sdk.AccAddress(sibling.Bytes())
			moduleAddr := a.AuthKeeper.GetModuleAddress(authtypes.FeeCollectorName)
			denom := evmtypes.GetEVMCoinDenom()
			pp := types.DefaultParams()
			pp.DealCreationFee = sdk.NewInt64Coin(denom, 7)
			require.NoError(t, a.PolyStoreChainKeeper.Params.Set(ctx, pp))
			for i := 1; i <= 3; i++ {
				address := sdk.AccAddress(common.HexToAddress(fmt.Sprintf("0xcc%02x", i)).Bytes()).String()
				require.NoError(t, a.PolyStoreChainKeeper.Providers.Set(ctx, address, types.Provider{Address: address, Capabilities: "General", Status: "Active", TotalStorage: 1 << 40}))
			}
			funds := sdk.NewCoins(sdk.NewInt64Coin(denom, 1000), sdk.NewInt64Coin(sdk.DefaultBondDenom, 1000))
			require.NoError(t, a.BankKeeper.MintCoins(ctx, types.ModuleName, funds))
			require.NoError(t, a.BankKeeper.SendCoinsFromModuleToAccount(ctx, types.ModuleName, owner, funds))
			if tc.sibling {
				require.NoError(t, a.BankKeeper.MintCoins(ctx, types.ModuleName, funds))
				require.NoError(t, a.BankKeeper.SendCoinsFromModuleToAccount(ctx, types.ModuleName, siblingOwner, funds))
			}
			ctx = ctx.WithEventManager(sdk.NewEventManager()).WithGasMeter(storetypes.NewInfiniteGasMeter())
			anteEvent := sdk.NewEvent("ante_marker", sdk.NewAttribute("id", "before-evm"))
			ctx.EventManager().EmitEvent(anteEvent)
			evm, state := nativeEVM(t, a, ctx)
			state.SetCode(outer, callAndReturn(child, 8000000, false))
			state.SetCode(child, callAndReturn(polystoreprecompile.Address, tc.gas, tc.revert))
			if tc.sibling {
				first := callAndReturn(child, 8000000, false)
				first = append(first[:len(first)-8], 0x50)
				state.SetCode(outer, append(first, callAndReturn(sibling, 8000000, false)...))
				state.SetCode(sibling, callAndReturn(polystoreprecompile.Address, 5000000, false))
				require.Equal(t, uint64(1000), state.GetBalance(sibling).Uint64())
			}
			// Load the balance before native mutation, as BALANCE/CALL does in contracts.
			require.Equal(t, uint64(1000), state.GetBalance(child).Uint64())
			hint := "General:rs=2+1"
			if tc.invalid {
				hint = "bad service hint"
			}
			input, err := api.Pack("createDeal", pp.MinDurationBlocks+100, hint, big.NewInt(11), big.NewInt(0))
			require.NoError(t, err)
			result, left, err := evm.Call(caller, outer, input, 12000000, uint256.NewInt(0))
			require.NoError(t, err)
			require.Len(t, result, 32)
			require.Less(t, left, uint64(12000000))
			success := !tc.revert && !tc.invalid && tc.gas == 5000000
			expected := int64(1000)
			escrow := int64(1000)
			fee := int64(0)
			if success {
				expected -= 7
				escrow -= 11
				fee = 7
			}
			require.Equal(t, uint64(expected), state.GetBalance(child).Uint64(), "EVM cached balance must reflect only the configured denomination")
			if tc.sibling {
				require.Equal(t, uint64(993), state.GetBalance(sibling).Uint64())
				fee = 7
			}
			committed := success || tc.sibling
			logs := state.Logs()
			if committed {
				require.Len(t, logs, 1)
			} else {
				require.Empty(t, logs)
			}
			require.Equal(t, sdk.Events{anteEvent}, ctx.EventManager().Events(), "native events remain private until Commit")
			require.NoError(t, state.Commit())
			require.Equal(t, anteEvent, ctx.EventManager().Events()[0], "preexisting caller event remains once")
			require.Equal(t, state.GetContext().EventManager().Events(), ctx.EventManager().Events()[1:])
			require.Equal(t, sdkmath.NewInt(expected), a.BankKeeper.GetBalance(ctx, owner, denom).Amount)
			require.Equal(t, sdkmath.NewInt(escrow), a.BankKeeper.GetBalance(ctx, owner, sdk.DefaultBondDenom).Amount)
			require.Equal(t, sdkmath.NewInt(fee), a.BankKeeper.GetBalance(ctx, moduleAddr, denom).Amount)
			count, err := a.PolyStoreChainKeeper.DealCount.Peek(ctx)
			require.NoError(t, err)
			if committed {
				require.Equal(t, uint64(1), count)
			} else {
				require.Zero(t, count)
			}
			events := 0
			for _, e := range ctx.EventManager().Events() {
				if e.Type == types.TypeMsgCreateDeal {
					events++
				}
			}
			if committed {
				require.Equal(t, 1, events)
			} else {
				require.Zero(t, events)
			}
			if tc.sibling {
				require.Equal(t, sdkmath.NewInt(993), a.BankKeeper.GetBalance(ctx, siblingOwner, denom).Amount)
				require.Equal(t, sdkmath.NewInt(989), a.BankKeeper.GetBalance(ctx, siblingOwner, sdk.DefaultBondDenom).Amount)
				require.Equal(t, common.BytesToHash(sibling.Bytes()), logs[0].Topics[2])
				require.Contains(t, fmt.Sprint(ctx.EventManager().Events()), siblingOwner.String())
				require.NotContains(t, fmt.Sprint(ctx.EventManager().Events()), owner.String())
			}
			spent := uint64(12000000) - left
			if tc.gas == 280000 {
				require.GreaterOrEqual(t, spent, uint64(tc.gas), "SDK OOG must exhaust the child gas allocation")
			}
			if tc.invalid {
				require.Greater(t, spent, uint64(219000), "failed native bank work must be charged")
			}
			t.Logf("native creation consumed %d EVM gas", spent)
		})
	}
}

// gasActionPrecompile exercises the shared dependency with a known amount of
// native work, independent of PolyStore's ABI and variable keeper gas schedule.
type gasActionPrecompile struct {
	cmn.Precompile
	action cmn.NativeAction
}

func (p gasActionPrecompile) RequiredGas([]byte) uint64 { return 0 }
func (p gasActionPrecompile) Run(e *vm.EVM, c *vm.Contract, _ bool) ([]byte, error) {
	return p.RunNativeAction(e, c, p.action)
}

func TestNativeGasAccounting(t *testing.T) {
	a, baseCtx := nativePrecompileApp(t)
	for _, parentGas := range []uint64{0, 1000} {
		for _, tc := range []struct {
			name         string
			work         uint64
			failure      error
			left         uint64
			expected     error
			badBankEvent bool
		}{
			{"success", 50, nil, 50, nil, false}, {"error", 50, errors.New("after mutation"), 50, vm.ErrExecutionReverted, false},
			{"sdk_oog", 101, nil, 0, vm.ErrOutOfGas, false}, {"returned_oog", 10, vm.ErrOutOfGas, 0, vm.ErrOutOfGas, false}, {"balance_handler_error", 50, nil, 50, vm.ErrExecutionReverted, true},
		} {
			t.Run(fmt.Sprintf("%s/parent_%d", tc.name, parentGas), func(t *testing.T) {
				ctx, _ := baseCtx.CacheContext()
				ctx = ctx.WithGasMeter(storetypes.NewInfiniteGasMeter())
				ctx.GasMeter().ConsumeGas(parentGas, "prior SDK work")
				evm, state := nativeEVM(t, a, ctx)
				address := common.HexToAddress("0x9999")
				p := gasActionPrecompile{Precompile: cmn.Precompile{ContractAddress: address, BalanceHandlerFactory: cmn.NewBalanceHandlerFactory(a.BankKeeper)}, action: func(native sdk.Context) ([]byte, error) {
					native.KVStore(a.GetKey(types.StoreKey)).Set([]byte("gas-regression"), []byte("written"))
					native.EventManager().EmitEvent(sdk.NewEvent("gas-regression"))
					native.GasMeter().ConsumeGas(tc.work, "controlled native work")
					if tc.badBankEvent {
						native.EventManager().EmitEvent(sdk.NewEvent("coin_spent"))
					}
					return nil, tc.failure
				}}
				evm.SetPrecompiles(vm.PrecompiledContracts{address: p})
				_, left, err := evm.Call(common.HexToAddress("0x9911"), address, nil, 100, uint256.NewInt(0))
				require.ErrorIs(t, err, tc.expected)
				require.Equal(t, tc.left, left, "native SDK work must be deducted exactly once")
				require.Equal(t, parentGas, ctx.GasMeter().GasConsumed(), "child meter must not mutate parent accounting")
				require.NoError(t, state.Commit())
				present := ctx.KVStore(a.GetKey(types.StoreKey)).Has([]byte("gas-regression"))
				require.Equal(t, tc.expected == nil, present)
				if tc.expected == nil {
					require.Len(t, ctx.EventManager().Events(), 1)
				} else {
					require.Empty(t, ctx.EventManager().Events())
				}
			})
		}
	}
}

func TestNativeBalanceDenominationConversion(t *testing.T) {
	nativePrecompileApp(t)
	original := evmtypes.EvmCoinInfo{Denom: evmtypes.GetEVMCoinDenom(), ExtendedDenom: evmtypes.GetEVMCoinExtendedDenom(), DisplayDenom: evmtypes.GetEVMCoinDisplayDenom(), Decimals: evmtypes.GetEVMCoinDecimals().Uint32()}
	t.Cleanup(func() { evmtypes.SetDefaultEvmCoinInfo(original) })
	evmtypes.SetDefaultEvmCoinInfo(evmtypes.EvmCoinInfo{Denom: "utest", ExtendedDenom: "atest", DisplayDenom: "test", Decimals: 6})
	for _, tc := range []struct {
		amount   string
		expected uint64
	}{{"2utest,17zother", 2000000000000}, {"17zother", 0}} {
		event := sdk.NewEvent("coin_received", sdk.NewAttribute(sdk.AttributeKeyAmount, tc.amount))
		amount, err := cmn.ParseAmount(event)
		require.NoError(t, err)
		require.Equal(t, tc.expected, amount.Uint64())
	}
}

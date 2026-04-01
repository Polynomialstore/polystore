package nilstore

import (
	"context"
	"testing"

	"cosmossdk.io/core/address"
	"cosmossdk.io/math"
	storetypes "cosmossdk.io/store/types"
	addresscodec "github.com/cosmos/cosmos-sdk/codec/address"
	"github.com/cosmos/cosmos-sdk/runtime"
	"github.com/cosmos/cosmos-sdk/testutil"
	sdk "github.com/cosmos/cosmos-sdk/types"
	moduletestutil "github.com/cosmos/cosmos-sdk/types/module/testutil"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/vm"
	"github.com/holiman/uint256"
	"github.com/stretchr/testify/require"

	nilkeeper "nilchain/x/nilchain/keeper"
	module "nilchain/x/nilchain/module"
	"nilchain/x/nilchain/types"
)

type mockBankKeeper struct{}

func (mockBankKeeper) SpendableCoins(context.Context, sdk.AccAddress) sdk.Coins {
	return sdk.NewCoins()
}
func (mockBankKeeper) GetBalance(_ context.Context, _ sdk.AccAddress, denom string) sdk.Coin {
	return sdk.NewCoin(denom, math.NewInt(0))
}
func (mockBankKeeper) MintCoins(context.Context, string, sdk.Coins) error { return nil }
func (mockBankKeeper) SendCoinsFromModuleToAccount(context.Context, string, sdk.AccAddress, sdk.Coins) error {
	return nil
}
func (mockBankKeeper) SendCoinsFromModuleToModule(context.Context, string, string, sdk.Coins) error {
	return nil
}
func (mockBankKeeper) SendCoinsFromAccountToModule(context.Context, sdk.AccAddress, string, sdk.Coins) error {
	return nil
}
func (mockBankKeeper) BurnCoins(context.Context, string, sdk.Coins) error { return nil }

type mockAccountKeeper struct{}

func (mockAccountKeeper) AddressCodec() address.Codec                             { return nil }
func (mockAccountKeeper) GetAccount(context.Context, sdk.AccAddress) sdk.AccountI { return nil }

type testFixture struct {
	ctx          context.Context
	keeper       nilkeeper.Keeper
	addressCodec address.Codec
}

func initFixture(t *testing.T) *testFixture {
	t.Helper()

	encCfg := moduletestutil.MakeTestEncodingConfig(module.AppModule{})
	addrCodec := addresscodec.NewBech32Codec(sdk.GetConfig().GetBech32AccountAddrPrefix())
	storeKey := storetypes.NewKVStoreKey(types.StoreKey)
	storeService := runtime.NewKVStoreService(storeKey)
	ctx := testutil.DefaultContextWithDB(t, storeKey, storetypes.NewTransientStoreKey("transient_test")).Ctx

	sdkCtx := sdk.UnwrapSDKContext(ctx).WithChainID("test-chain")
	authority := authtypes.NewModuleAddress(types.GovModuleName)
	keeper := nilkeeper.NewKeeper(
		storeService,
		encCfg.Codec,
		addrCodec,
		authority,
		mockBankKeeper{},
		mockAccountKeeper{},
	)
	require.NoError(t, keeper.Params.Set(sdkCtx, types.DefaultParams()))

	return &testFixture{
		ctx:          sdkCtx,
		keeper:       keeper,
		addressCodec: addrCodec,
	}
}

func TestPrecompileIncludesRequestProviderLinkMethod(t *testing.T) {
	f := initFixture(t)
	precompile, err := New(&f.keeper)
	require.NoError(t, err)

	method, ok := precompile.abi.Methods["requestProviderLink"]
	require.True(t, ok)
	require.Equal(t, "requestProviderLink", method.Name)
	require.Len(t, method.Inputs, 1)
	require.Len(t, method.Outputs, 1)
}

func TestPrecompileIncludesApproveProviderLinkMethod(t *testing.T) {
	f := initFixture(t)
	precompile, err := New(&f.keeper)
	require.NoError(t, err)

	method, ok := precompile.abi.Methods["approveProviderLink"]
	require.True(t, ok)
	require.Equal(t, "approveProviderLink", method.Name)
	require.Len(t, method.Inputs, 1)
	require.Len(t, method.Outputs, 1)
}

func TestPrecompileIncludesCancelProviderLinkMethod(t *testing.T) {
	f := initFixture(t)
	precompile, err := New(&f.keeper)
	require.NoError(t, err)

	method, ok := precompile.abi.Methods["cancelProviderLink"]
	require.True(t, ok)
	require.Equal(t, "cancelProviderLink", method.Name)
	require.Len(t, method.Inputs, 0)
	require.Len(t, method.Outputs, 1)
}

func TestPrecompileIncludesUnpairProviderMethod(t *testing.T) {
	f := initFixture(t)
	precompile, err := New(&f.keeper)
	require.NoError(t, err)

	method, ok := precompile.abi.Methods["unpairProvider"]
	require.True(t, ok)
	require.Equal(t, "unpairProvider", method.Name)
	require.Len(t, method.Inputs, 1)
	require.Len(t, method.Outputs, 1)
}

func TestRunRequestProviderLinkCreatesPendingLinkFromEvmCaller(t *testing.T) {
	f := initFixture(t)
	precompile, err := New(&f.keeper)
	require.NoError(t, err)

	sdkCtx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(10)
	method := precompile.abi.Methods["requestProviderLink"]
	operator := sdk.AccAddress(common.HexToAddress("0x00000000000000000000000000000000000000ac").Bytes()).String()
	input, err := method.Inputs.Pack(operator)
	require.NoError(t, err)

	caller := common.HexToAddress("0x00000000000000000000000000000000000000ab")
	contract := vm.NewPrecompile(caller, Address, uint256.NewInt(0), 5_000_000)
	contract.Input = append(method.ID, input...)

	out, err := precompile.runRequestProviderLink(sdkCtx, nil, contract, &method, input)
	require.NoError(t, err)

	decoded, err := method.Outputs.Unpack(out)
	require.NoError(t, err)
	require.Len(t, decoded, 1)
	ok, cast := decoded[0].(bool)
	require.True(t, cast)
	require.True(t, ok)

	provider := sdk.AccAddress(caller.Bytes()).String()
	pending, err := f.keeper.PendingProviderLinks.Get(sdkCtx, provider)
	require.NoError(t, err)
	require.Equal(t, operator, pending.Operator)
	require.Equal(t, provider, pending.Provider)
	require.Equal(t, int64(10), pending.RequestedHeight)
}

func TestRunApproveProviderLinkPairsProviderFromEvmCaller(t *testing.T) {
	f := initFixture(t)
	precompile, err := New(&f.keeper)
	require.NoError(t, err)

	sdkCtx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(20)
	msgServer := nilkeeper.NewMsgServerImpl(f.keeper)
	provider := sdk.AccAddress(common.HexToAddress("0x00000000000000000000000000000000000000ce").Bytes()).String()
	operatorCaller := common.HexToAddress("0x00000000000000000000000000000000000000cd")
	operator := sdk.AccAddress(operatorCaller.Bytes()).String()
	_, err = msgServer.RequestProviderLink(sdk.WrapSDKContext(sdkCtx), &types.MsgRequestProviderLink{
		Creator:  provider,
		Operator: operator,
	})
	require.NoError(t, err)

	method := precompile.abi.Methods["approveProviderLink"]
	input, err := method.Inputs.Pack(provider)
	require.NoError(t, err)

	contract := vm.NewPrecompile(operatorCaller, Address, uint256.NewInt(0), 5_000_000)
	contract.Input = append(method.ID, input...)

	out, err := precompile.runApproveProviderLink(sdkCtx, nil, contract, &method, input)
	require.NoError(t, err)
	decoded, err := method.Outputs.Unpack(out)
	require.NoError(t, err)
	require.Len(t, decoded, 1)
	ok, cast := decoded[0].(bool)
	require.True(t, cast)
	require.True(t, ok)

	pairing, err := f.keeper.ProviderPairings.Get(sdkCtx, provider)
	require.NoError(t, err)
	require.Equal(t, operator, pairing.Operator)
}

func TestRunCancelProviderLinkRemovesPendingLinkForEvmCaller(t *testing.T) {
	f := initFixture(t)
	precompile, err := New(&f.keeper)
	require.NoError(t, err)

	sdkCtx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(11)
	msgServer := nilkeeper.NewMsgServerImpl(f.keeper)
	providerCaller := common.HexToAddress("0x00000000000000000000000000000000000000da")
	provider := sdk.AccAddress(providerCaller.Bytes()).String()
	operator := sdk.AccAddress(common.HexToAddress("0x00000000000000000000000000000000000000db").Bytes()).String()

	_, err = msgServer.RequestProviderLink(sdk.WrapSDKContext(sdkCtx), &types.MsgRequestProviderLink{
		Creator:  provider,
		Operator: operator,
	})
	require.NoError(t, err)

	method := precompile.abi.Methods["cancelProviderLink"]
	input, err := method.Inputs.Pack()
	require.NoError(t, err)

	contract := vm.NewPrecompile(providerCaller, Address, uint256.NewInt(0), 5_000_000)
	contract.Input = append(method.ID, input...)

	out, err := precompile.runCancelProviderLink(sdkCtx, nil, contract, &method, input)
	require.NoError(t, err)
	decoded, err := method.Outputs.Unpack(out)
	require.NoError(t, err)
	require.Len(t, decoded, 1)
	ok, cast := decoded[0].(bool)
	require.True(t, cast)
	require.True(t, ok)

	_, err = f.keeper.PendingProviderLinks.Get(sdkCtx, provider)
	require.Error(t, err)
}

func TestRunUnpairProviderRemovesPairingForEvmCaller(t *testing.T) {
	f := initFixture(t)
	precompile, err := New(&f.keeper)
	require.NoError(t, err)

	sdkCtx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(10)
	msgServer := nilkeeper.NewMsgServerImpl(f.keeper)
	caller := common.HexToAddress("0x00000000000000000000000000000000000000ef")
	operator := sdk.AccAddress(caller.Bytes()).String()
	providerAddr := common.HexToAddress("0x00000000000000000000000000000000000000f1")
	provider := sdk.AccAddress(providerAddr.Bytes()).String()

	_, err = msgServer.RequestProviderLink(sdk.WrapSDKContext(sdkCtx), &types.MsgRequestProviderLink{
		Creator:  provider,
		Operator: operator,
	})
	require.NoError(t, err)
	_, err = msgServer.ApproveProviderLink(sdk.WrapSDKContext(sdkCtx), &types.MsgApproveProviderLink{
		Creator:  operator,
		Provider: provider,
	})
	require.NoError(t, err)

	method := precompile.abi.Methods["unpairProvider"]
	input, err := method.Inputs.Pack(provider)
	require.NoError(t, err)

	contract := vm.NewPrecompile(caller, Address, uint256.NewInt(0), 5_000_000)
	contract.Input = append(method.ID, input...)

	out, err := precompile.runUnpairProvider(sdkCtx, nil, contract, &method, input)
	require.NoError(t, err)

	decoded, err := method.Outputs.Unpack(out)
	require.NoError(t, err)
	require.Len(t, decoded, 1)
	ok, cast := decoded[0].(bool)
	require.True(t, cast)
	require.True(t, ok)

	_, err = f.keeper.ProviderPairings.Get(sdkCtx, provider)
	require.Error(t, err)
}

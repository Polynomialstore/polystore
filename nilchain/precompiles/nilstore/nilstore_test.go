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

func TestPrecompileIncludesOpenProviderPairingMethod(t *testing.T) {
	f := initFixture(t)
	precompile, err := New(&f.keeper)
	require.NoError(t, err)

	method, ok := precompile.abi.Methods["openProviderPairing"]
	require.True(t, ok)
	require.Equal(t, "openProviderPairing", method.Name)
	require.Len(t, method.Inputs, 2)
	require.Len(t, method.Outputs, 1)
}

func TestRunOpenProviderPairingCreatesPendingPairingFromEvmCaller(t *testing.T) {
	f := initFixture(t)
	precompile, err := New(&f.keeper)
	require.NoError(t, err)

	sdkCtx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(10)
	method := precompile.abi.Methods["openProviderPairing"]
	input, err := method.Inputs.Pack("pair-123", uint64(25))
	require.NoError(t, err)

	caller := common.HexToAddress("0x00000000000000000000000000000000000000ab")
	contract := vm.NewPrecompile(caller, Address, uint256.NewInt(0), 5_000_000)
	contract.Input = append(method.ID, input...)

	out, err := precompile.runOpenProviderPairing(sdkCtx, nil, contract, &method, input)
	require.NoError(t, err)

	decoded, err := method.Outputs.Unpack(out)
	require.NoError(t, err)
	require.Len(t, decoded, 1)
	ok, cast := decoded[0].(bool)
	require.True(t, cast)
	require.True(t, ok)

	operator := sdk.AccAddress(caller.Bytes()).String()
	pending, err := f.keeper.PendingProviderPairings.Get(sdkCtx, "pair-123")
	require.NoError(t, err)
	require.Equal(t, operator, pending.Operator)
	require.Equal(t, uint64(25), pending.ExpiresAt)
	require.Equal(t, int64(10), pending.OpenedHeight)
}

func TestRunOpenProviderPairingRejectsExpiredHeight(t *testing.T) {
	f := initFixture(t)
	precompile, err := New(&f.keeper)
	require.NoError(t, err)

	sdkCtx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(20)
	method := precompile.abi.Methods["openProviderPairing"]
	input, err := method.Inputs.Pack("pair-expired", uint64(20))
	require.NoError(t, err)

	caller := common.HexToAddress("0x00000000000000000000000000000000000000cd")
	contract := vm.NewPrecompile(caller, Address, uint256.NewInt(0), 5_000_000)

	_, err = precompile.runOpenProviderPairing(sdkCtx, nil, contract, &method, input)
	require.Error(t, err)
	require.Contains(t, err.Error(), "expires_at must be in the future")
}

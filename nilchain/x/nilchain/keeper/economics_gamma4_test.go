package keeper_test

import (
	"context"
	"fmt"
	"testing"

	"cosmossdk.io/math"
	storetypes "cosmossdk.io/store/types"
	addresscodec "github.com/cosmos/cosmos-sdk/codec/address"
	"github.com/cosmos/cosmos-sdk/runtime"
	"github.com/cosmos/cosmos-sdk/testutil"
	sdk "github.com/cosmos/cosmos-sdk/types"
	moduletestutil "github.com/cosmos/cosmos-sdk/types/module/testutil"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	"github.com/stretchr/testify/require"

	"nilchain/x/nilchain/keeper"
	module "nilchain/x/nilchain/module"
	"nilchain/x/nilchain/types"
)

type trackingBankKeeper struct {
	accountBalances map[string]sdk.Coins
	moduleBalances  map[string]sdk.Coins
	transfers       []transferRecord
}

type transferRecord struct {
	fromAcc    string
	fromModule string
	toAcc      string
	toModule   string
	amt        sdk.Coins
}

func newTrackingBankKeeper() *trackingBankKeeper {
	return &trackingBankKeeper{
		accountBalances: make(map[string]sdk.Coins),
		moduleBalances:  make(map[string]sdk.Coins),
		transfers:       nil,
	}
}

func (b *trackingBankKeeper) setAccountBalance(addr sdk.AccAddress, coins sdk.Coins) {
	b.accountBalances[addr.String()] = coins.Sort()
}

func (b *trackingBankKeeper) SpendableCoins(_ context.Context, addr sdk.AccAddress) sdk.Coins {
	if coins, ok := b.accountBalances[addr.String()]; ok {
		return coins
	}
	return sdk.NewCoins()
}

func (b *trackingBankKeeper) MintCoins(_ context.Context, moduleName string, amt sdk.Coins) error {
	if !amt.IsValid() {
		return fmt.Errorf("invalid coins: %s", amt)
	}
	b.moduleBalances[moduleName] = b.moduleBalances[moduleName].Add(amt...).Sort()
	return nil
}

func (b *trackingBankKeeper) SendCoinsFromModuleToAccount(_ context.Context, senderModule string, recipientAddr sdk.AccAddress, amt sdk.Coins) error {
	if !amt.IsValid() {
		return fmt.Errorf("invalid coins: %s", amt)
	}
	if amt.IsZero() {
		b.transfers = append(b.transfers, transferRecord{fromModule: senderModule, toAcc: recipientAddr.String(), amt: amt})
		return nil
	}
	have := b.moduleBalances[senderModule]
	next, err := safeSubCoins(have, amt)
	if err != nil {
		return err
	}
	b.moduleBalances[senderModule] = next.Sort()
	b.accountBalances[recipientAddr.String()] = b.accountBalances[recipientAddr.String()].Add(amt...).Sort()
	b.transfers = append(b.transfers, transferRecord{fromModule: senderModule, toAcc: recipientAddr.String(), amt: amt})
	return nil
}

func (b *trackingBankKeeper) SendCoinsFromAccountToModule(_ context.Context, senderAddr sdk.AccAddress, recipientModule string, amt sdk.Coins) error {
	if !amt.IsValid() {
		return fmt.Errorf("invalid coins: %s", amt)
	}
	if amt.IsZero() {
		b.transfers = append(b.transfers, transferRecord{fromAcc: senderAddr.String(), toModule: recipientModule, amt: amt})
		return nil
	}
	have := b.accountBalances[senderAddr.String()]
	next, err := safeSubCoins(have, amt)
	if err != nil {
		return err
	}
	b.accountBalances[senderAddr.String()] = next.Sort()
	b.moduleBalances[recipientModule] = b.moduleBalances[recipientModule].Add(amt...).Sort()
	b.transfers = append(b.transfers, transferRecord{fromAcc: senderAddr.String(), toModule: recipientModule, amt: amt})
	return nil
}

func (b *trackingBankKeeper) BurnCoins(_ context.Context, moduleName string, amt sdk.Coins) error {
	if !amt.IsValid() {
		return fmt.Errorf("invalid coins: %s", amt)
	}
	if amt.IsZero() {
		return nil
	}
	have := b.moduleBalances[moduleName]
	next, err := safeSubCoins(have, amt)
	if err != nil {
		return err
	}
	b.moduleBalances[moduleName] = next.Sort()
	return nil
}

func safeSubCoins(have sdk.Coins, amt sdk.Coins) (sdk.Coins, error) {
	next, hasNeg := have.SafeSub(amt...)
	if hasNeg {
		return nil, fmt.Errorf("insufficient funds for %s (have %s)", amt.String(), have.String())
	}
	return next, nil
}

func initFixtureWithBankKeeper(t *testing.T, bank types.BankKeeper) *fixture {
	t.Helper()

	encCfg := moduletestutil.MakeTestEncodingConfig(module.AppModule{})
	addressCodec := addresscodec.NewBech32Codec(sdk.GetConfig().GetBech32AccountAddrPrefix())
	storeKey := storetypes.NewKVStoreKey(types.StoreKey)

	storeService := runtime.NewKVStoreService(storeKey)
	ctx := testutil.DefaultContextWithDB(t, storeKey, storetypes.NewTransientStoreKey("transient_test")).Ctx

	sdkCtx := sdk.UnwrapSDKContext(ctx)
	sdkCtx = sdkCtx.WithChainID("test-chain")
	ctx = sdkCtx

	authority := authtypes.NewModuleAddress(types.GovModuleName)

	k := keeper.NewKeeper(
		storeService,
		encCfg.Codec,
		addressCodec,
		authority,
		bank,
		MockAccountKeeper{},
	)

	if err := k.Params.Set(ctx, types.DefaultParams()); err != nil {
		t.Fatalf("failed to set params: %v", err)
	}

	return &fixture{ctx: ctx, keeper: k, addressCodec: addressCodec}
}

func TestGamma4_CreateDeal_EnforcesMinDuration(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	p := types.DefaultParams()
	p.MinDurationBlocks = 100
	require.NoError(t, f.keeper.Params.Set(f.ctx, p))

	userBz := []byte("user_min_dur_test")
	user, _ := f.addressCodec.BytesToString(userBz)

	_, err := msgServer.CreateDeal(f.ctx, &types.MsgCreateDeal{
		Creator:             user,
		DurationBlocks:      10,
		ServiceHint:         "General",
		MaxMonthlySpend:     math.NewInt(0),
		InitialEscrowAmount: math.NewInt(0),
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "deal duration must be >=")
}

func TestGamma4_CreateDeal_ChargesCreationFeeInBondDenom(t *testing.T) {
	bank := newTrackingBankKeeper()
	f := initFixtureWithBankKeeper(t, bank)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	for i := 0; i < int(types.DealBaseReplication); i++ {
		addrBz := []byte(fmt.Sprintf("provider_fee_test_%02d", i))
		addr, _ := f.addressCodec.BytesToString(addrBz)
		_, err := msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{
			Creator:      addr,
			Capabilities: "General",
			TotalStorage: 100000000000,
			Endpoints:    testProviderEndpoints,
		})
		require.NoError(t, err)
	}

	p := types.DefaultParams()
	p.DealCreationFee = sdk.NewInt64Coin(sdk.DefaultBondDenom, 123)
	p.MinDurationBlocks = 10
	require.NoError(t, f.keeper.Params.Set(f.ctx, p))

	userBz := []byte("user_fee_test_______")
	user, _ := f.addressCodec.BytesToString(userBz)
	userAddr, err := sdk.AccAddressFromBech32(user)
	require.NoError(t, err)

	// Fund user for: creation fee + initial escrow.
	bank.setAccountBalance(userAddr, sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 1123)))

	_, err = msgServer.CreateDeal(f.ctx, &types.MsgCreateDeal{
		Creator:             user,
		DurationBlocks:      100,
		ServiceHint:         "General",
		MaxMonthlySpend:     math.NewInt(0),
		InitialEscrowAmount: math.NewInt(1000),
	})
	require.NoError(t, err)

	require.Equal(t, sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 123)).String(), bank.moduleBalances[authtypes.FeeCollectorName].String())
	require.Equal(t, sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 1000)).String(), bank.moduleBalances[types.ModuleName].String())
}

func TestGamma4_UpdateDealContent_ChargesTermDepositInBondDenom(t *testing.T) {
	bank := newTrackingBankKeeper()
	f := initFixtureWithBankKeeper(t, bank)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	for i := 0; i < int(types.DealBaseReplication); i++ {
		addrBz := []byte(fmt.Sprintf("provider_deposit_%02d", i))
		addr, _ := f.addressCodec.BytesToString(addrBz)
		_, err := msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{
			Creator:      addr,
			Capabilities: "General",
			TotalStorage: 100000000000,
			Endpoints:    testProviderEndpoints,
		})
		require.NoError(t, err)
	}

	p := types.DefaultParams()
	p.StoragePrice = math.LegacyMustNewDecFromStr("1") // 1 stake per byte per block (test-only)
	p.DealCreationFee = sdk.NewInt64Coin(sdk.DefaultBondDenom, 0)
	p.MinDurationBlocks = 1
	require.NoError(t, f.keeper.Params.Set(f.ctx, p))

	userBz := []byte("user_deposit_test__")
	user, _ := f.addressCodec.BytesToString(userBz)
	userAddr, err := sdk.AccAddressFromBech32(user)
	require.NoError(t, err)

	// Fund user: term deposit will be deltaSize(100) * duration(10) * price(1) = 1000 stake.
	bank.setAccountBalance(userAddr, sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 1000)))

	resDeal, err := msgServer.CreateDeal(f.ctx, &types.MsgCreateDeal{
		Creator:             user,
		DurationBlocks:      10,
		ServiceHint:         "General",
		MaxMonthlySpend:     math.NewInt(0),
		InitialEscrowAmount: math.NewInt(0),
	})
	require.NoError(t, err)

	_, err = msgServer.UpdateDealContent(f.ctx, &types.MsgUpdateDealContent{
		Creator: user,
		DealId:  resDeal.DealId,
		Cid:     validManifestCid,
		Size_:   100,
	})
	require.NoError(t, err)

	deal, err := f.keeper.Deals.Get(f.ctx, resDeal.DealId)
	require.NoError(t, err)
	require.Equal(t, math.NewInt(1000), deal.EscrowBalance)
	require.Equal(t, sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 1000)).String(), bank.moduleBalances[types.ModuleName].String())
}

func TestGamma4_CreateDealFromEvm_EnforcesMinDuration(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	p := types.DefaultParams()
	p.MinDurationBlocks = 100
	require.NoError(t, f.keeper.Params.Set(f.ctx, p))

	// Duration fails min-duration check before signature verification.
	senderBz := []byte("relayer_min_dur__")
	sender, _ := f.addressCodec.BytesToString(senderBz)

	_, err := msgServer.CreateDealFromEvm(f.ctx, &types.MsgCreateDealFromEvm{
		Sender: sender,
		Intent: &types.EvmCreateDealIntent{
			CreatorEvm:      "0x0000000000000000000000000000000000000001",
			DurationBlocks:  10,
			ServiceHint:     "General",
			InitialEscrow:   math.NewInt(0),
			MaxMonthlySpend: math.NewInt(0),
			Nonce:           1,
			ChainId:         sdk.UnwrapSDKContext(f.ctx).ChainID(),
		},
		EvmSignature: make([]byte, 65),
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "deal duration must be >=")
}

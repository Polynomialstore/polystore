package keeper_test

import (
	"fmt"
	"testing"

	"cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"

	"polystorechain/x/polystorechain/keeper"
	"polystorechain/x/polystorechain/types"
)

func registerDynamicPricingProvider(t *testing.T, f *fixture, ctx sdk.Context, label string, totalStorage uint64) string {
	t.Helper()

	msgServer := keeper.NewMsgServerImpl(f.keeper)
	addrBz := make([]byte, 20)
	copy(addrBz, []byte(label))
	addr, err := f.addressCodec.BytesToString(addrBz)
	require.NoError(t, err)
	_, err = msgServer.RegisterProvider(ctx, &types.MsgRegisterProvider{
		Creator:      addr,
		Capabilities: "General",
		TotalStorage: totalStorage,
		Endpoints:    testProviderEndpoints,
	})
	require.NoError(t, err)
	return addr
}

func TestDynamicPricing_EpochStart_ClampsMaxStep(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	p := types.DefaultParams()
	p.DynamicPricingEnabled = true
	p.DynamicPricingMaxStepBps = 500 // 5% per epoch

	p.StoragePrice = math.LegacyMustNewDecFromStr("100")
	p.StoragePriceMin = math.LegacyMustNewDecFromStr("100")
	p.StoragePriceMax = math.LegacyMustNewDecFromStr("200")
	p.StorageTargetUtilizationBps = 1 // any non-zero utilization hits max

	p.BaseRetrievalFee = sdk.NewInt64Coin(sdk.DefaultBondDenom, 0)
	p.RetrievalPricePerBlob = sdk.NewInt64Coin(sdk.DefaultBondDenom, 100)
	p.RetrievalPricePerBlobMin = sdk.NewInt64Coin(sdk.DefaultBondDenom, 100)
	p.RetrievalPricePerBlobMax = sdk.NewInt64Coin(sdk.DefaultBondDenom, 200)
	p.RetrievalTargetBlobsPerEpoch = 1 // any demand hits max

	require.NoError(t, f.keeper.Params.Set(f.ctx, p))

	ctx1 := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(1)

	for i := 0; i < 3; i++ {
		addrBz := make([]byte, 20)
		copy(addrBz, []byte(fmt.Sprintf("dyn_price_p%02d", i)))
		addr, _ := f.addressCodec.BytesToString(addrBz)
		_, err := msgServer.RegisterProvider(ctx1, &types.MsgRegisterProvider{
			Creator:      addr,
			Capabilities: "General",
			TotalStorage: 1_000_000,
			Endpoints:    testProviderEndpoints,
		})
		require.NoError(t, err)
	}

	userBz := make([]byte, 20)
	copy(userBz, []byte("dyn_price_user"))
	user, _ := f.addressCodec.BytesToString(userBz)

	resDeal, err := msgServer.CreateDeal(ctx1, &types.MsgCreateDeal{
		Creator:             user,
		DurationBlocks:      200,
		ServiceHint:         "General",
		MaxMonthlySpend:     math.NewInt(0),
		InitialEscrowAmount: math.NewInt(1_000_000),
	})
	require.NoError(t, err)

	ctx2 := ctx1.WithBlockHeight(2)
	_, err = msgServer.UpdateDealContent(ctx2, &types.MsgUpdateDealContent{
		Creator:     user,
		DealId:      resDeal.DealId,
		Cid:         validManifestCid,
		Size_:       1,
		TotalMdus:   3,
		WitnessMdus: 1,
	})
	require.NoError(t, err)

	deal, err := f.keeper.Deals.Get(ctx2, resDeal.DealId)
	require.NoError(t, err)
	require.NotEmpty(t, deal.Mode2Slots)
	provider := deal.Mode2Slots[0].Provider

	ctx3 := ctx1.WithBlockHeight(3)
	_, err = msgServer.OpenRetrievalSession(ctx3, &types.MsgOpenRetrievalSession{
		Creator:        user,
		DealId:         resDeal.DealId,
		Provider:       provider,
		ManifestRoot:   mustDecodeHexBytes(t, validManifestCid),
		StartMduIndex:  0,
		StartBlobIndex: 0,
		BlobCount:      1,
		Nonce:          1,
		ExpiresAt:      0,
	})
	require.NoError(t, err)

	epoch2Ctx := ctx1.WithBlockHeight(101)
	require.NoError(t, f.keeper.BeginBlock(epoch2Ctx))

	after := f.keeper.GetParams(epoch2Ctx)
	require.True(t, after.StoragePrice.Equal(math.LegacyMustNewDecFromStr("105")))
	require.Equal(t, math.NewInt(105), after.RetrievalPricePerBlob.Amount)
}

func TestDynamicPricing_EpochStart_NoStepClamp_JumpsToTarget(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	p := types.DefaultParams()
	p.DynamicPricingEnabled = true
	p.DynamicPricingMaxStepBps = 0 // no clamp

	p.StoragePrice = math.LegacyMustNewDecFromStr("100")
	p.StoragePriceMin = math.LegacyMustNewDecFromStr("100")
	p.StoragePriceMax = math.LegacyMustNewDecFromStr("200")
	p.StorageTargetUtilizationBps = 1

	p.BaseRetrievalFee = sdk.NewInt64Coin(sdk.DefaultBondDenom, 0)
	p.RetrievalPricePerBlob = sdk.NewInt64Coin(sdk.DefaultBondDenom, 100)
	p.RetrievalPricePerBlobMin = sdk.NewInt64Coin(sdk.DefaultBondDenom, 100)
	p.RetrievalPricePerBlobMax = sdk.NewInt64Coin(sdk.DefaultBondDenom, 200)
	p.RetrievalTargetBlobsPerEpoch = 1

	require.NoError(t, f.keeper.Params.Set(f.ctx, p))

	ctx1 := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(1)

	for i := 0; i < 3; i++ {
		addrBz := make([]byte, 20)
		copy(addrBz, []byte(fmt.Sprintf("dyn_price_nc_p%02d", i)))
		addr, _ := f.addressCodec.BytesToString(addrBz)
		_, err := msgServer.RegisterProvider(ctx1, &types.MsgRegisterProvider{
			Creator:      addr,
			Capabilities: "General",
			TotalStorage: 1_000_000,
			Endpoints:    testProviderEndpoints,
		})
		require.NoError(t, err)
	}

	userBz := make([]byte, 20)
	copy(userBz, []byte("dyn_price_nc_user"))
	user, _ := f.addressCodec.BytesToString(userBz)

	resDeal, err := msgServer.CreateDeal(ctx1, &types.MsgCreateDeal{
		Creator:             user,
		DurationBlocks:      200,
		ServiceHint:         "General",
		MaxMonthlySpend:     math.NewInt(0),
		InitialEscrowAmount: math.NewInt(1_000_000),
	})
	require.NoError(t, err)

	ctx2 := ctx1.WithBlockHeight(2)
	_, err = msgServer.UpdateDealContent(ctx2, &types.MsgUpdateDealContent{
		Creator:     user,
		DealId:      resDeal.DealId,
		Cid:         validManifestCid,
		Size_:       1,
		TotalMdus:   3,
		WitnessMdus: 1,
	})
	require.NoError(t, err)

	deal, err := f.keeper.Deals.Get(ctx2, resDeal.DealId)
	require.NoError(t, err)
	require.NotEmpty(t, deal.Mode2Slots)
	provider := deal.Mode2Slots[0].Provider

	ctx3 := ctx1.WithBlockHeight(3)
	_, err = msgServer.OpenRetrievalSession(ctx3, &types.MsgOpenRetrievalSession{
		Creator:        user,
		DealId:         resDeal.DealId,
		Provider:       provider,
		ManifestRoot:   mustDecodeHexBytes(t, validManifestCid),
		StartMduIndex:  0,
		StartBlobIndex: 0,
		BlobCount:      1,
		Nonce:          1,
		ExpiresAt:      0,
	})
	require.NoError(t, err)

	epoch2Ctx := ctx1.WithBlockHeight(101)
	require.NoError(t, f.keeper.BeginBlock(epoch2Ctx))

	after := f.keeper.GetParams(epoch2Ctx)
	require.True(t, after.StoragePrice.Equal(math.LegacyMustNewDecFromStr("200")))
	require.Equal(t, math.NewInt(200), after.RetrievalPricePerBlob.Amount)
}

func TestDynamicPricing_EpochStart_FallsToFloorsWithoutDemand(t *testing.T) {
	f := initFixture(t)

	p := types.DefaultParams()
	p.DynamicPricingEnabled = true
	p.DynamicPricingMaxStepBps = 0 // no clamp, so the controller can reach the floor in one epoch

	p.StoragePrice = math.LegacyMustNewDecFromStr("200")
	p.StoragePriceMin = math.LegacyMustNewDecFromStr("100")
	p.StoragePriceMax = math.LegacyMustNewDecFromStr("200")
	p.StorageTargetUtilizationBps = 5000

	p.BaseRetrievalFee = sdk.NewInt64Coin(sdk.DefaultBondDenom, 0)
	p.RetrievalPricePerBlob = sdk.NewInt64Coin(sdk.DefaultBondDenom, 200)
	p.RetrievalPricePerBlobMin = sdk.NewInt64Coin(sdk.DefaultBondDenom, 100)
	p.RetrievalPricePerBlobMax = sdk.NewInt64Coin(sdk.DefaultBondDenom, 200)
	p.RetrievalTargetBlobsPerEpoch = 100

	require.NoError(t, f.keeper.Params.Set(f.ctx, p))

	ctx1 := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(1)
	registerDynamicPricingProvider(t, f, ctx1, "dyn_floor_provider", 1_000_000)

	epoch2Ctx := ctx1.WithBlockHeight(101)
	require.NoError(t, f.keeper.BeginBlock(epoch2Ctx))

	after := f.keeper.GetParams(epoch2Ctx)
	require.True(t, after.StoragePrice.Equal(math.LegacyMustNewDecFromStr("100")))
	require.Equal(t, math.NewInt(100), after.RetrievalPricePerBlob.Amount)
}

func TestDynamicPricing_EpochStart_IdempotentWithinEpoch(t *testing.T) {
	f := initFixture(t)

	p := types.DefaultParams()
	p.DynamicPricingEnabled = true
	p.DynamicPricingMaxStepBps = 500 // 5% per epoch

	p.StoragePrice = math.LegacyMustNewDecFromStr("200")
	p.StoragePriceMin = math.LegacyMustNewDecFromStr("100")
	p.StoragePriceMax = math.LegacyMustNewDecFromStr("200")
	p.StorageTargetUtilizationBps = 5000

	p.BaseRetrievalFee = sdk.NewInt64Coin(sdk.DefaultBondDenom, 0)
	p.RetrievalPricePerBlob = sdk.NewInt64Coin(sdk.DefaultBondDenom, 200)
	p.RetrievalPricePerBlobMin = sdk.NewInt64Coin(sdk.DefaultBondDenom, 100)
	p.RetrievalPricePerBlobMax = sdk.NewInt64Coin(sdk.DefaultBondDenom, 200)
	p.RetrievalTargetBlobsPerEpoch = 100

	require.NoError(t, f.keeper.Params.Set(f.ctx, p))

	ctx1 := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(1)
	registerDynamicPricingProvider(t, f, ctx1, "dyn_idempotent_p", 1_000_000)

	epoch2Ctx := ctx1.WithBlockHeight(101)
	require.NoError(t, f.keeper.BeginBlock(epoch2Ctx))

	afterFirst := f.keeper.GetParams(epoch2Ctx)
	require.True(t, afterFirst.StoragePrice.Equal(math.LegacyMustNewDecFromStr("190")))
	require.Equal(t, math.NewInt(190), afterFirst.RetrievalPricePerBlob.Amount)

	require.NoError(t, f.keeper.BeginBlock(epoch2Ctx))

	afterSecond := f.keeper.GetParams(epoch2Ctx)
	require.True(t, afterSecond.StoragePrice.Equal(afterFirst.StoragePrice))
	require.Equal(t, afterFirst.RetrievalPricePerBlob.Amount, afterSecond.RetrievalPricePerBlob.Amount)
}

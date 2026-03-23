package keeper_test

import (
	"fmt"
	"testing"

	"cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"

	"nilchain/x/nilchain/keeper"
	"nilchain/x/nilchain/types"
)

func TestExtendDeal_BeforeExpiry_UpdatesEndAndAnchorAndEscrow(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	// Set a simple non-zero storage price so costs are deterministic.
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(1)
	params := types.DefaultParams()
	params.StoragePrice = math.LegacyNewDec(1)
	params.DealExtensionGraceBlocks = 10
	require.NoError(t, f.keeper.Params.Set(ctx, params))

	// Register minimal providers for Mode 2 (rs=2+1).
	for i := 0; i < 3; i++ {
		providerBz := make([]byte, 20)
		copy(providerBz, []byte(fmt.Sprintf("provider_extend_%02d", i)))
		provider, _ := f.addressCodec.BytesToString(providerBz)
		_, err := msgServer.RegisterProvider(ctx, &types.MsgRegisterProvider{
			Creator:      provider,
			Capabilities: "General",
			TotalStorage: 100000000000,
			Endpoints:    testProviderEndpoints,
		})
		require.NoError(t, err)
	}

	ownerBz := make([]byte, 20)
	copy(ownerBz, []byte("owner_extend_v1____"))
	owner, _ := f.addressCodec.BytesToString(ownerBz)

	resDeal, err := msgServer.CreateDeal(ctx, &types.MsgCreateDeal{
		Creator:             owner,
		DurationBlocks:      10,
		ServiceHint:         "General:rs=2+1",
		InitialEscrowAmount: math.NewInt(0),
		MaxMonthlySpend:     math.NewInt(0),
	})
	require.NoError(t, err)

	// Commit some bytes so ExtendDeal has something to price.
	_, err = msgServer.UpdateDealContent(ctx, &types.MsgUpdateDealContent{
		Creator:              owner,
		DealId:               resDeal.DealId,
		PreviousManifestRoot: "",
		Cid:                  validManifestCid,
		Size_:                100,
		TotalMdus:            3,
		WitnessMdus:          1,
	})
	require.NoError(t, err)

	before, err := f.keeper.Deals.Get(ctx, resDeal.DealId)
	require.NoError(t, err)
	require.Equal(t, uint64(1), before.StartBlock)
	require.Equal(t, uint64(11), before.EndBlock)
	require.Equal(t, uint64(1), before.PricingAnchorBlock)
	require.Equal(t, uint64(100), before.Size_)
	require.Equal(t, math.NewInt(1000), before.EscrowBalance) // 100 bytes * 10 blocks * price=1

	// Extend before expiry at height=5. New end appends after current end.
	ctx5 := ctx.WithBlockHeight(5)
	_, err = msgServer.ExtendDeal(ctx5, &types.MsgExtendDeal{
		Creator:                  owner,
		DealId:                   resDeal.DealId,
		AdditionalDurationBlocks: 10,
	})
	require.NoError(t, err)

	after, err := f.keeper.Deals.Get(ctx5, resDeal.DealId)
	require.NoError(t, err)
	require.Equal(t, uint64(21), after.EndBlock)          // 11 + 10
	require.Equal(t, uint64(5), after.PricingAnchorBlock) // renewal anchor
	require.Equal(t, math.NewInt(2000), after.EscrowBalance)
}

func TestUpdateDealContent_UsesPricingAnchorAfterExtend(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(1)
	params := types.DefaultParams()
	params.StoragePrice = math.LegacyNewDec(1)
	params.DealExtensionGraceBlocks = 10
	require.NoError(t, f.keeper.Params.Set(ctx, params))

	for i := 0; i < 3; i++ {
		providerBz := make([]byte, 20)
		copy(providerBz, []byte(fmt.Sprintf("provider_anchor_%02d", i)))
		provider, _ := f.addressCodec.BytesToString(providerBz)
		_, err := msgServer.RegisterProvider(ctx, &types.MsgRegisterProvider{
			Creator:      provider,
			Capabilities: "General",
			TotalStorage: 100000000000,
			Endpoints:    testProviderEndpoints,
		})
		require.NoError(t, err)
	}

	ownerBz := make([]byte, 20)
	copy(ownerBz, []byte("owner_anchor_v1____"))
	owner, _ := f.addressCodec.BytesToString(ownerBz)

	resDeal, err := msgServer.CreateDeal(ctx, &types.MsgCreateDeal{
		Creator:             owner,
		DurationBlocks:      10,
		ServiceHint:         "General:rs=2+1",
		InitialEscrowAmount: math.NewInt(0),
		MaxMonthlySpend:     math.NewInt(0),
	})
	require.NoError(t, err)

	_, err = msgServer.UpdateDealContent(ctx, &types.MsgUpdateDealContent{
		Creator:     owner,
		DealId:      resDeal.DealId,
		Cid:         validManifestCid,
		Size_:       100,
		TotalMdus:   3,
		WitnessMdus: 1,
	})
	require.NoError(t, err)

	// Extend at height=5 by 10 blocks: end=21, pricing_anchor_block=5.
	ctx5 := ctx.WithBlockHeight(5)
	_, err = msgServer.ExtendDeal(ctx5, &types.MsgExtendDeal{
		Creator:                  owner,
		DealId:                   resDeal.DealId,
		AdditionalDurationBlocks: 10,
	})
	require.NoError(t, err)

	// Increase size by +100 bytes at height=6.
	// Expected duration for delta bytes = end(21) - pricing_anchor_block(5) = 16.
	ctx6 := ctx.WithBlockHeight(6)
	_, err = msgServer.UpdateDealContent(ctx6, &types.MsgUpdateDealContent{
		Creator:              owner,
		DealId:               resDeal.DealId,
		PreviousManifestRoot: validManifestCid,
		Cid:                  validManifestCid,
		Size_:                200,
		TotalMdus:            3,
		WitnessMdus:          1,
	})
	require.NoError(t, err)

	deal, err := f.keeper.Deals.Get(ctx6, resDeal.DealId)
	require.NoError(t, err)
	require.Equal(t, math.NewInt(3600), deal.EscrowBalance) // 1000 (initial) + 1000 (extend) + 1600 (delta after anchor)
}

func TestExtendDeal_AfterExpiryWithinGrace_UsesMaxEndAndNoDeadTime(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(1)
	params := types.DefaultParams()
	params.StoragePrice = math.LegacyNewDec(1)
	params.DealExtensionGraceBlocks = 10
	params.MinDurationBlocks = 1
	require.NoError(t, f.keeper.Params.Set(ctx, params))

	for i := 0; i < 3; i++ {
		providerBz := make([]byte, 20)
		copy(providerBz, []byte(fmt.Sprintf("provider_grace_%02d", i)))
		provider, _ := f.addressCodec.BytesToString(providerBz)
		_, err := msgServer.RegisterProvider(ctx, &types.MsgRegisterProvider{
			Creator:      provider,
			Capabilities: "General",
			TotalStorage: 100000000000,
			Endpoints:    testProviderEndpoints,
		})
		require.NoError(t, err)
	}

	ownerBz := make([]byte, 20)
	copy(ownerBz, []byte("owner_grace_v1_____"))
	owner, _ := f.addressCodec.BytesToString(ownerBz)

	// Create a short deal: start=1, end=6.
	resDeal, err := msgServer.CreateDeal(ctx, &types.MsgCreateDeal{
		Creator:             owner,
		DurationBlocks:      5,
		ServiceHint:         "General:rs=2+1",
		InitialEscrowAmount: math.NewInt(0),
		MaxMonthlySpend:     math.NewInt(0),
	})
	require.NoError(t, err)
	_, err = msgServer.UpdateDealContent(ctx, &types.MsgUpdateDealContent{
		Creator:     owner,
		DealId:      resDeal.DealId,
		Cid:         validManifestCid,
		Size_:       10,
		TotalMdus:   3,
		WitnessMdus: 1,
	})
	require.NoError(t, err)

	// Renew after expiry at height=8 (within grace). base=max(end(6),h(8)) => 8.
	ctx8 := ctx.WithBlockHeight(8)
	_, err = msgServer.ExtendDeal(ctx8, &types.MsgExtendDeal{
		Creator:                  owner,
		DealId:                   resDeal.DealId,
		AdditionalDurationBlocks: 5,
	})
	require.NoError(t, err)

	deal, err := f.keeper.Deals.Get(ctx8, resDeal.DealId)
	require.NoError(t, err)
	require.Equal(t, uint64(13), deal.EndBlock)          // 8 + 5
	require.Equal(t, uint64(8), deal.PricingAnchorBlock) // set to renewal height
}

func TestExtendDeal_AfterGraceFails(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(1)
	params := types.DefaultParams()
	params.StoragePrice = math.LegacyNewDec(1)
	params.DealExtensionGraceBlocks = 2
	params.MinDurationBlocks = 1
	require.NoError(t, f.keeper.Params.Set(ctx, params))

	for i := 0; i < 3; i++ {
		providerBz := make([]byte, 20)
		copy(providerBz, []byte(fmt.Sprintf("provider_fail_%02d", i)))
		provider, _ := f.addressCodec.BytesToString(providerBz)
		_, err := msgServer.RegisterProvider(ctx, &types.MsgRegisterProvider{
			Creator:      provider,
			Capabilities: "General",
			TotalStorage: 100000000000,
			Endpoints:    testProviderEndpoints,
		})
		require.NoError(t, err)
	}

	ownerBz := make([]byte, 20)
	copy(ownerBz, []byte("owner_fail_v1______"))
	owner, _ := f.addressCodec.BytesToString(ownerBz)

	// start=1, end=6, grace=2 => renewable until height<=8.
	resDeal, err := msgServer.CreateDeal(ctx, &types.MsgCreateDeal{
		Creator:             owner,
		DurationBlocks:      5,
		ServiceHint:         "General:rs=2+1",
		InitialEscrowAmount: math.NewInt(0),
		MaxMonthlySpend:     math.NewInt(0),
	})
	require.NoError(t, err)

	ctx9 := ctx.WithBlockHeight(9)
	_, err = msgServer.ExtendDeal(ctx9, &types.MsgExtendDeal{
		Creator:                  owner,
		DealId:                   resDeal.DealId,
		AdditionalDurationBlocks: 1,
	})
	require.Error(t, err)
}

func TestUpdateDealContent_RejectsExpiredDeal(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(1)
	params := types.DefaultParams()
	params.StoragePrice = math.LegacyNewDec(1)
	params.DealExtensionGraceBlocks = 10
	params.MinDurationBlocks = 1
	require.NoError(t, f.keeper.Params.Set(ctx, params))

	for i := 0; i < 3; i++ {
		providerBz := make([]byte, 20)
		copy(providerBz, []byte(fmt.Sprintf("provider_exp_%02d", i)))
		provider, _ := f.addressCodec.BytesToString(providerBz)
		_, err := msgServer.RegisterProvider(ctx, &types.MsgRegisterProvider{
			Creator:      provider,
			Capabilities: "General",
			TotalStorage: 100000000000,
			Endpoints:    testProviderEndpoints,
		})
		require.NoError(t, err)
	}

	ownerBz := make([]byte, 20)
	copy(ownerBz, []byte("owner_exp_v1_______"))
	owner, _ := f.addressCodec.BytesToString(ownerBz)

	resDeal, err := msgServer.CreateDeal(ctx, &types.MsgCreateDeal{
		Creator:             owner,
		DurationBlocks:      1,
		ServiceHint:         "General:rs=2+1",
		InitialEscrowAmount: math.NewInt(0),
		MaxMonthlySpend:     math.NewInt(0),
	})
	require.NoError(t, err)

	// end_block = 2, so height=2 is expired.
	ctx2 := ctx.WithBlockHeight(2)
	_, err = msgServer.UpdateDealContent(ctx2, &types.MsgUpdateDealContent{
		Creator:     owner,
		DealId:      resDeal.DealId,
		Cid:         validManifestCid,
		Size_:       100,
		TotalMdus:   3,
		WitnessMdus: 1,
	})
	require.Error(t, err)
}

func TestOpenRetrievalSession_RejectsExpiredDeal(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(1)
	params := types.DefaultParams()
	params.StoragePrice = math.LegacyNewDec(1)
	params.DealExtensionGraceBlocks = 10
	params.MinDurationBlocks = 1
	require.NoError(t, f.keeper.Params.Set(ctx, params))

	for i := 0; i < 3; i++ {
		providerBz := make([]byte, 20)
		copy(providerBz, []byte(fmt.Sprintf("provider_open_exp_%02d", i)))
		provider, _ := f.addressCodec.BytesToString(providerBz)
		_, err := msgServer.RegisterProvider(ctx, &types.MsgRegisterProvider{
			Creator:      provider,
			Capabilities: "General",
			TotalStorage: 100000000000,
			Endpoints:    testProviderEndpoints,
		})
		require.NoError(t, err)
	}

	ownerBz := make([]byte, 20)
	copy(ownerBz, []byte("owner_open_exp____"))
	owner, _ := f.addressCodec.BytesToString(ownerBz)

	resDeal, err := msgServer.CreateDeal(ctx, &types.MsgCreateDeal{
		Creator:             owner,
		DurationBlocks:      1,
		ServiceHint:         "General:rs=2+1",
		InitialEscrowAmount: math.NewInt(0),
		MaxMonthlySpend:     math.NewInt(0),
	})
	require.NoError(t, err)
	require.NotEmpty(t, resDeal.AssignedProviders)

	// Commit content so manifest_root matches.
	_, err = msgServer.UpdateDealContent(ctx, &types.MsgUpdateDealContent{
		Creator:     owner,
		DealId:      resDeal.DealId,
		Cid:         validManifestCid,
		Size_:       8 * 1024 * 1024,
		TotalMdus:   3,
		WitnessMdus: 1,
	})
	require.NoError(t, err)
	deal, err := f.keeper.Deals.Get(ctx, resDeal.DealId)
	require.NoError(t, err)

	// end_block = 2, so height=2 is expired.
	ctx2 := ctx.WithBlockHeight(2)
	_, err = msgServer.OpenRetrievalSession(ctx2, &types.MsgOpenRetrievalSession{
		Creator:        owner,
		DealId:         resDeal.DealId,
		Provider:       resDeal.AssignedProviders[0],
		ManifestRoot:   deal.ManifestRoot,
		StartMduIndex:  0,
		StartBlobIndex: 0,
		BlobCount:      1,
		Nonce:          1,
		ExpiresAt:      0,
	})
	require.Error(t, err)
}

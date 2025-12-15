package keeper_test

import (
	"encoding/hex"
	"strings"
	"testing"

	"cosmossdk.io/math"
	"github.com/stretchr/testify/require"

	"nilchain/x/nilchain/keeper"
	"nilchain/x/nilchain/types"
)

func TestUpdateDealContent_HappyPath(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	// Register Providers
	for i := 0; i < int(types.DealBaseReplication); i++ {
		addrBz := []byte(string(rune('A' + i)))
		addr, _ := f.addressCodec.BytesToString(addrBz)
		_, err := msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{
			Creator:      addr,
			Capabilities: "General",
			TotalStorage: 100000000000,
			Endpoints:    testProviderEndpoints,
		})
		require.NoError(t, err)
	}

	userBz := []byte("user_update_happy___")
	user, _ := f.addressCodec.BytesToString(userBz)

	// 1. Create Deal (Capacity) - 4 GiB
	resDeal, err := msgServer.CreateDeal(f.ctx, &types.MsgCreateDeal{
		Creator:             user,
		DurationBlocks:      1000,
		ServiceHint:         "General",
		InitialEscrowAmount: math.NewInt(1000000),
		MaxMonthlySpend:     math.NewInt(1000000),
	})
	require.NoError(t, err)

	// 2. Commit Content
	size := uint64(100 * 1024 * 1024) // 100 MB

	resUpd, err := msgServer.UpdateDealContent(f.ctx, &types.MsgUpdateDealContent{
		Creator: user,
		DealId:  resDeal.DealId,
		Cid:     validManifestCid,
		Size_:   size,
	})
	require.NoError(t, err)
	require.True(t, resUpd.Success)

	// 3. Verify State
	deal, err := f.keeper.Deals.Get(f.ctx, resDeal.DealId)
	require.NoError(t, err)

	expectedRoot, _ := hex.DecodeString(strings.TrimPrefix(validManifestCid, "0x"))
	require.Equal(t, expectedRoot, deal.ManifestRoot)
	require.Equal(t, size, deal.Size_)
}

func TestUpdateDealContent_Unauthorized(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	// Register Providers
	for i := 0; i < int(types.DealBaseReplication); i++ {
		addrBz := []byte(string(rune('A' + i)))
		addr, _ := f.addressCodec.BytesToString(addrBz)
		_, err := msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{
			Creator:      addr,
			Capabilities: "General",
			TotalStorage: 100000000000,
			Endpoints:    testProviderEndpoints,
		})
		require.NoError(t, err)
	}

	aliceBz := []byte("alice_______________")
	alice, _ := f.addressCodec.BytesToString(aliceBz)
	bobBz := []byte("bob_________________")
	bob, _ := f.addressCodec.BytesToString(bobBz)

	// 1. Create Deal as Alice
	resDeal, err := msgServer.CreateDeal(f.ctx, &types.MsgCreateDeal{
		Creator:             alice,
		DurationBlocks:      1000,
		ServiceHint:         "General",
		InitialEscrowAmount: math.NewInt(1000000),
		MaxMonthlySpend:     math.NewInt(1000000),
	})
	require.NoError(t, err)

	// 2. Bob tries to update
	_, err = msgServer.UpdateDealContent(f.ctx, &types.MsgUpdateDealContent{
		Creator: bob,
		DealId:  resDeal.DealId,
		Cid:     validManifestCid,
		Size_:   100,
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "unauthorized")
}

func TestUpdateDealContent_AllowsLargeContent(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	// Register Providers
	for i := 0; i < int(types.DealBaseReplication); i++ {
		addrBz := []byte(string(rune('A' + i)))
		addr, _ := f.addressCodec.BytesToString(addrBz)
		_, err := msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{
			Creator:      addr,
			Capabilities: "General",
			TotalStorage: 100000000000,
			Endpoints:    testProviderEndpoints,
		})
		require.NoError(t, err)
	}

	userBz := []byte("user_capacity_______")
	user, _ := f.addressCodec.BytesToString(userBz)

	// 1. Create Deal (thin-provisioned; tier is ignored)
	resDeal, err := msgServer.CreateDeal(f.ctx, &types.MsgCreateDeal{
		Creator:             user,
		DurationBlocks:      1000,
		ServiceHint:         "General",
		InitialEscrowAmount: math.NewInt(1000000),
		MaxMonthlySpend:     math.NewInt(1000000),
	})
	require.NoError(t, err)

	// 2. Commit a large payload (5 GiB); dynamic sizing should allow this.
	size := uint64(5 * 1024 * 1024 * 1024)

	resUpd, err := msgServer.UpdateDealContent(f.ctx, &types.MsgUpdateDealContent{
		Creator: user,
		DealId:  resDeal.DealId,
		Cid:     validManifestCid,
		Size_:   size,
	})
	require.NoError(t, err)
	require.True(t, resUpd.Success)

	deal, err := f.keeper.Deals.Get(f.ctx, resDeal.DealId)
	require.NoError(t, err)
	require.Equal(t, size, deal.Size_)
}

func TestUpdateDealContent_InvalidInput(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	// Register Providers
	for i := 0; i < int(types.DealBaseReplication); i++ {
		addrBz := []byte(string(rune('A' + i)))
		addr, _ := f.addressCodec.BytesToString(addrBz)
		_, err := msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{
			Creator:      addr,
			Capabilities: "General",
			TotalStorage: 100000000000,
			Endpoints:    testProviderEndpoints,
		})
		require.NoError(t, err)
	}

	userBz := []byte("user_invalid________")
	user, _ := f.addressCodec.BytesToString(userBz)

	resDeal, err := msgServer.CreateDeal(f.ctx, &types.MsgCreateDeal{
		Creator:             user,
		DurationBlocks:      1000,
		ServiceHint:         "General",
		InitialEscrowAmount: math.NewInt(1000000),
		MaxMonthlySpend:     math.NewInt(1000000),
	})
	require.NoError(t, err)

	// Empty CID
	_, err = msgServer.UpdateDealContent(f.ctx, &types.MsgUpdateDealContent{
		Creator: user, DealId: resDeal.DealId, Cid: "", Size_: 100,
	})
	require.Error(t, err)

	// Zero Size
	_, err = msgServer.UpdateDealContent(f.ctx, &types.MsgUpdateDealContent{
		Creator: user, DealId: resDeal.DealId, Cid: validManifestCid, Size_: 0,
	})
	require.Error(t, err)
}

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

func TestRetrievalSession_LocksFeesAndCancels(t *testing.T) {
	bank := newTrackingBankKeeper()
	f := initFixtureWithBankKeeper(t, bank)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	for i := 0; i < int(types.DealBaseReplication); i++ {
		addrBz := make([]byte, 20)
		copy(addrBz, []byte(fmt.Sprintf("retrieval_fee_p%02d", i)))
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
	p.BaseRetrievalFee = sdk.NewInt64Coin(sdk.DefaultBondDenom, 2)
	p.RetrievalPricePerBlob = sdk.NewInt64Coin(sdk.DefaultBondDenom, 3)
	p.RetrievalBurnBps = 500
	require.NoError(t, f.keeper.Params.Set(f.ctx, p))

	userBz := make([]byte, 20)
	copy(userBz, []byte("retrieval_fee_user"))
	user, _ := f.addressCodec.BytesToString(userBz)
	userAddr, err := sdk.AccAddressFromBech32(user)
	require.NoError(t, err)

	bank.setAccountBalance(userAddr, sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 100)))

	resDeal, err := msgServer.CreateDeal(f.ctx, &types.MsgCreateDeal{
		Creator:             user,
		DurationBlocks:      100,
		ServiceHint:         "General",
		MaxMonthlySpend:     math.NewInt(0),
		InitialEscrowAmount: math.NewInt(100),
	})
	require.NoError(t, err)

	manifestRoot := make([]byte, 48)
	for i := range manifestRoot {
		manifestRoot[i] = byte(i + 1)
	}
	_, err = msgServer.UpdateDealContent(f.ctx, &types.MsgUpdateDealContent{
		Creator: user, DealId: resDeal.DealId, Cid: "0x" + hexEncode(manifestRoot), Size_: 8 * 1024 * 1024,
	})
	require.NoError(t, err)
	deal, err := f.keeper.Deals.Get(sdk.UnwrapSDKContext(f.ctx), resDeal.DealId)
	require.NoError(t, err)

	openRes, err := msgServer.OpenRetrievalSession(f.ctx, &types.MsgOpenRetrievalSession{
		Creator:        user,
		DealId:         resDeal.DealId,
		Provider:       deal.Providers[0],
		ManifestRoot:   deal.ManifestRoot,
		StartMduIndex:  0,
		StartBlobIndex: 0,
		BlobCount:      2,
		Nonce:          1,
		ExpiresAt:      1,
	})
	require.NoError(t, err)

	dealAfter, err := f.keeper.Deals.Get(sdk.UnwrapSDKContext(f.ctx), resDeal.DealId)
	require.NoError(t, err)
	require.Equal(t, math.NewInt(92), dealAfter.EscrowBalance)

	session, err := f.keeper.RetrievalSessions.Get(sdk.UnwrapSDKContext(f.ctx), openRes.SessionId)
	require.NoError(t, err)
	require.Equal(t, math.NewInt(6), session.LockedFee)

	require.Equal(
		t,
		sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 98)).String(),
		bank.moduleBalances[types.ModuleName].String(),
	)

	cancelCtx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(10)
	_, err = msgServer.CancelRetrievalSession(cancelCtx, &types.MsgCancelRetrievalSession{
		Creator:   user,
		SessionId: openRes.SessionId,
	})
	require.NoError(t, err)

	dealAfterCancel, err := f.keeper.Deals.Get(cancelCtx, resDeal.DealId)
	require.NoError(t, err)
	require.Equal(t, math.NewInt(98), dealAfterCancel.EscrowBalance)

	sessionAfter, err := f.keeper.RetrievalSessions.Get(cancelCtx, openRes.SessionId)
	require.NoError(t, err)
	require.Equal(t, types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_CANCELED, sessionAfter.Status)
	require.True(t, sessionAfter.LockedFee.IsZero())
}

package keeper_test

import (
	"fmt"
	"testing"

	"cosmossdk.io/collections"
	"cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"

	"polystorechain/x/polystorechain/keeper"
	"polystorechain/x/polystorechain/types"
)

func setupRetrievalExpiryDeal(t *testing.T) (*fixture, *trackingBankKeeper, types.MsgServer, string, types.MsgCreateDealResponse, types.Deal) {
	t.Helper()

	bank := newTrackingBankKeeper()
	f := initFixtureWithBankKeeper(t, bank)
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(1)

	params := types.DefaultParams()
	params.StoragePrice = math.LegacyNewDec(0)
	params.BaseRetrievalFee = sdk.NewInt64Coin(sdk.DefaultBondDenom, 2)
	params.RetrievalPricePerBlob = sdk.NewInt64Coin(sdk.DefaultBondDenom, 3)
	require.NoError(t, f.keeper.Params.Set(ctx, params))

	for i := 0; i < 5; i++ {
		addrBz := make([]byte, 20)
		copy(addrBz, []byte(fmt.Sprintf("expired_provider%02d", i)))
		addr, err := f.addressCodec.BytesToString(addrBz)
		require.NoError(t, err)
		_, err = msgServer.RegisterProvider(ctx, &types.MsgRegisterProvider{
			Creator:      addr,
			Capabilities: "General",
			TotalStorage: 100000000000,
			Endpoints:    testProviderEndpoints,
		})
		require.NoError(t, err)
	}

	ownerBz := make([]byte, 20)
	copy(ownerBz, []byte("expired_owner"))
	owner, err := f.addressCodec.BytesToString(ownerBz)
	require.NoError(t, err)
	ownerAddr, err := sdk.AccAddressFromBech32(owner)
	require.NoError(t, err)
	bank.setAccountBalance(ownerAddr, sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 1000)))

	resDeal, err := msgServer.CreateDeal(ctx, &types.MsgCreateDeal{
		Creator:             owner,
		DurationBlocks:      100,
		ServiceHint:         "General:rs=2+1",
		MaxMonthlySpend:     math.NewInt(0),
		InitialEscrowAmount: math.NewInt(100),
	})
	require.NoError(t, err)

	manifestRoot := make([]byte, 48)
	for i := range manifestRoot {
		manifestRoot[i] = byte(i + 1)
	}
	_, err = msgServer.UpdateDealContent(ctx, &types.MsgUpdateDealContent{
		Creator:     owner,
		DealId:      resDeal.DealId,
		Cid:         "0x" + hexEncode(manifestRoot),
		Size_:       8 * 1024 * 1024,
		TotalMdus:   3,
		WitnessMdus: 1,
	})
	require.NoError(t, err)

	deal, err := f.keeper.Deals.Get(ctx, resDeal.DealId)
	require.NoError(t, err)
	return f, bank, msgServer, owner, *resDeal, deal
}

func requireNoRetrievalSessionState(t *testing.T, f *fixture, ctx sdk.Context) {
	t.Helper()

	var sessions int
	err := f.keeper.RetrievalSessions.Walk(ctx, nil, func(_ []byte, _ types.RetrievalSession) (bool, error) {
		sessions++
		return false, nil
	})
	require.NoError(t, err)
	require.Zero(t, sessions)

	var nonces int
	err = f.keeper.RetrievalSessionNonces.Walk(ctx, nil, func(_ collections.Pair[collections.Pair[string, uint64], string], _ uint64) (bool, error) {
		nonces++
		return false, nil
	})
	require.NoError(t, err)
	require.Zero(t, nonces)
}

func TestOpenRetrievalSessionRejectsExpiredDealWithoutBilling(t *testing.T) {
	f, bank, msgServer, owner, resDeal, deal := setupRetrievalExpiryDeal(t)
	expiredCtx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(int64(deal.EndBlock))

	_, err := msgServer.OpenRetrievalSession(expiredCtx, &types.MsgOpenRetrievalSession{
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
	require.Contains(t, err.Error(), "expired")

	dealAfter, err := f.keeper.Deals.Get(expiredCtx, resDeal.DealId)
	require.NoError(t, err)
	require.Equal(t, math.NewInt(100), dealAfter.EscrowBalance)
	require.Equal(t, "100stake", bank.moduleBalances[types.ModuleName].String())
	requireNoRetrievalSessionState(t, f, expiredCtx)
}

func TestOpenSponsoredRetrievalSessionRejectsExpiredDealWithoutBilling(t *testing.T) {
	f, bank, msgServer, owner, resDeal, deal := setupRetrievalExpiryDeal(t)
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(2)

	_, err := msgServer.UpdateDealRetrievalPolicy(ctx, &types.MsgUpdateDealRetrievalPolicy{
		Creator: owner,
		DealId:  resDeal.DealId,
		Policy: types.RetrievalPolicy{
			Mode: types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_PUBLIC,
		},
	})
	require.NoError(t, err)

	requesterBz := make([]byte, 20)
	copy(requesterBz, []byte("expired_requester"))
	requester, err := f.addressCodec.BytesToString(requesterBz)
	require.NoError(t, err)
	requesterAddr, err := sdk.AccAddressFromBech32(requester)
	require.NoError(t, err)
	bank.setAccountBalance(requesterAddr, sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 100)))

	expiredCtx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(int64(deal.EndBlock))
	_, err = msgServer.OpenRetrievalSessionSponsored(expiredCtx, &types.MsgOpenRetrievalSessionSponsored{
		Creator:        requester,
		DealId:         resDeal.DealId,
		Provider:       resDeal.AssignedProviders[0],
		ManifestRoot:   deal.ManifestRoot,
		StartMduIndex:  0,
		StartBlobIndex: 0,
		BlobCount:      1,
		Nonce:          1,
		ExpiresAt:      0,
		MaxTotalFee:    math.NewInt(5),
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "expired")

	dealAfter, err := f.keeper.Deals.Get(expiredCtx, resDeal.DealId)
	require.NoError(t, err)
	require.Equal(t, math.NewInt(100), dealAfter.EscrowBalance)
	require.Equal(t, "100stake", bank.accountBalances[requesterAddr.String()].String())
	require.Equal(t, "100stake", bank.moduleBalances[types.ModuleName].String())
	requireNoRetrievalSessionState(t, f, expiredCtx)
}

func TestOpenProtocolRetrievalSessionRejectsExpiredDealWithoutBilling(t *testing.T) {
	f, bank, msgServer, _, resDeal, deal := setupRetrievalExpiryDeal(t)
	expiredCtx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(int64(deal.EndBlock))

	protocolActor := resDeal.AssignedProviders[0]
	servingProvider := resDeal.AssignedProviders[1]
	bank.moduleBalances[types.ProtocolBudgetModuleName] = sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 100))
	initialProtocolBudget := bank.moduleBalances[types.ProtocolBudgetModuleName]
	initialModuleBalance := bank.moduleBalances[types.ModuleName]

	tests := []struct {
		name      string
		purpose   types.RetrievalSessionPurpose
		configure func(*types.MsgOpenProtocolRetrievalSession)
	}{
		{
			name:    "audit",
			purpose: types.RetrievalSessionPurpose_RETRIEVAL_SESSION_PURPOSE_PROTOCOL_AUDIT,
			configure: func(msg *types.MsgOpenProtocolRetrievalSession) {
				msg.Auth = &types.MsgOpenProtocolRetrievalSession_AuditTask{
					AuditTask: &types.AuditTaskRef{
						EpochId: 1,
						TaskId:  1,
					},
				}
			},
		},
		{
			name:    "repair",
			purpose: types.RetrievalSessionPurpose_RETRIEVAL_SESSION_PURPOSE_PROTOCOL_REPAIR,
			configure: func(msg *types.MsgOpenProtocolRetrievalSession) {
				msg.Auth = &types.MsgOpenProtocolRetrievalSession_Repair{
					Repair: &types.RepairAuth{
						Slot: 0,
					},
				}
			},
		},
	}

	for i, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			msg := &types.MsgOpenProtocolRetrievalSession{
				Creator:        protocolActor,
				DealId:         resDeal.DealId,
				Provider:       servingProvider,
				ManifestRoot:   deal.ManifestRoot,
				StartMduIndex:  0,
				StartBlobIndex: 0,
				BlobCount:      1,
				Nonce:          uint64(i + 1),
				ExpiresAt:      0,
				MaxTotalFee:    math.NewInt(5),
				Purpose:        tt.purpose,
			}
			tt.configure(msg)

			_, err := msgServer.OpenProtocolRetrievalSession(expiredCtx, msg)
			require.Error(t, err)
			require.Contains(t, err.Error(), "expired")

			require.Equal(t, initialProtocolBudget.String(), bank.moduleBalances[types.ProtocolBudgetModuleName].String())
			require.Equal(t, initialModuleBalance.String(), bank.moduleBalances[types.ModuleName].String())
			requireNoRetrievalSessionState(t, f, expiredCtx)
		})
	}
}

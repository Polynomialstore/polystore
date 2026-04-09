package keeper_test

import (
	"strings"
	"testing"

	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"polystorechain/x/polystorechain/keeper"
	"polystorechain/x/polystorechain/types"
)

func TestProviderLinkLifecycleAndQueries(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	queryServer := keeper.NewQueryServerImpl(f.keeper)

	operator := testProviderAddress(t, f, "operator_pairing___")
	provider := testProviderAddress(t, f, "provider_pairing___")
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(10)

	resRequest, err := msgServer.RequestProviderLink(ctx, &types.MsgRequestProviderLink{
		Creator:  provider,
		Operator: operator,
	})
	require.NoError(t, err)
	require.True(t, resRequest.Success)

	pendingRes, err := queryServer.GetPendingProviderLink(ctx, &types.QueryGetPendingProviderLinkRequest{Provider: strings.ToUpper(provider)})
	require.NoError(t, err)
	require.Equal(t, provider, pendingRes.Link.Provider)
	require.Equal(t, operator, pendingRes.Link.Operator)
	require.Equal(t, int64(10), pendingRes.Link.RequestedHeight)

	pendingByOperatorRes, err := queryServer.ListPendingProviderLinksByOperator(ctx, &types.QueryListPendingProviderLinksByOperatorRequest{
		Operator: strings.ToUpper(operator),
	})
	require.NoError(t, err)
	require.Len(t, pendingByOperatorRes.Links, 1)
	require.Equal(t, provider, pendingByOperatorRes.Links[0].Provider)
	require.Equal(t, operator, pendingByOperatorRes.Links[0].Operator)

	resApprove, err := msgServer.ApproveProviderLink(ctx, &types.MsgApproveProviderLink{
		Creator:  operator,
		Provider: provider,
	})
	require.NoError(t, err)
	require.True(t, resApprove.Success)

	getRes, err := queryServer.GetProviderPairing(ctx, &types.QueryGetProviderPairingRequest{Provider: strings.ToUpper(provider)})
	require.NoError(t, err)
	require.Equal(t, provider, getRes.Pairing.Provider)
	require.Equal(t, operator, getRes.Pairing.Operator)
	require.Equal(t, int64(10), getRes.Pairing.PairedHeight)

	listRes, err := queryServer.ListProvidersByOperator(ctx, &types.QueryListProvidersByOperatorRequest{Operator: strings.ToUpper(operator)})
	require.NoError(t, err)
	require.Len(t, listRes.Pairings, 1)
	require.Equal(t, provider, listRes.Pairings[0].Provider)
	require.Equal(t, operator, listRes.Pairings[0].Operator)

	_, err = queryServer.GetPendingProviderLink(ctx, &types.QueryGetPendingProviderLinkRequest{Provider: provider})
	require.Error(t, err)
	require.Equal(t, codes.NotFound, status.Code(err))
}

func TestApproveProviderLinkRejectsWrongOperator(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(3)

	provider := testProviderAddress(t, f, "provider_wrong_op__")
	operator := testProviderAddress(t, f, "operator_wrong_op__")
	otherOperator := testProviderAddress(t, f, "other_wrong_op_____")

	_, err := msgServer.RequestProviderLink(ctx, &types.MsgRequestProviderLink{
		Creator:  provider,
		Operator: operator,
	})
	require.NoError(t, err)

	_, err = msgServer.ApproveProviderLink(ctx, &types.MsgApproveProviderLink{
		Creator:  otherOperator,
		Provider: provider,
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "different operator")
}

func TestCancelProviderLinkRemovesPendingRequest(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	queryServer := keeper.NewQueryServerImpl(f.keeper)
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(5)

	provider := testProviderAddress(t, f, "provider_cancel_____")
	operator := testProviderAddress(t, f, "operator_cancel_____")

	_, err := msgServer.RequestProviderLink(ctx, &types.MsgRequestProviderLink{
		Creator:  provider,
		Operator: operator,
	})
	require.NoError(t, err)

	res, err := msgServer.CancelProviderLink(ctx, &types.MsgCancelProviderLink{
		Creator: provider,
	})
	require.NoError(t, err)
	require.True(t, res.Success)

	_, err = queryServer.GetPendingProviderLink(ctx, &types.QueryGetPendingProviderLinkRequest{Provider: provider})
	require.Error(t, err)
	require.Equal(t, codes.NotFound, status.Code(err))
}

func TestUnpairProviderRequiresLinkedActorAndRemovesIndexes(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	queryServer := keeper.NewQueryServerImpl(f.keeper)

	operator := testProviderAddress(t, f, "operator_unpair___")
	provider := testProviderAddress(t, f, "provider_unpair___")
	other := testProviderAddress(t, f, "other_unpair______")
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(8)

	_, err := msgServer.RequestProviderLink(ctx, &types.MsgRequestProviderLink{
		Creator:  provider,
		Operator: operator,
	})
	require.NoError(t, err)
	_, err = msgServer.ApproveProviderLink(ctx, &types.MsgApproveProviderLink{
		Creator:  operator,
		Provider: provider,
	})
	require.NoError(t, err)

	_, err = msgServer.UnpairProvider(ctx, &types.MsgUnpairProvider{
		Creator:  other,
		Provider: provider,
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "not authorized")

	_, err = queryServer.GetProviderPairing(ctx, &types.QueryGetProviderPairingRequest{Provider: provider})
	require.NoError(t, err)

	res, err := msgServer.UnpairProvider(ctx, &types.MsgUnpairProvider{
		Creator:  operator,
		Provider: provider,
	})
	require.NoError(t, err)
	require.True(t, res.Success)

	_, err = f.keeper.ProviderPairings.Get(ctx, provider)
	require.Error(t, err)

	_, err = queryServer.GetProviderPairing(ctx, &types.QueryGetProviderPairingRequest{Provider: provider})
	require.Error(t, err)
	require.Equal(t, codes.NotFound, status.Code(err))

	listRes, err := queryServer.ListProvidersByOperator(ctx, &types.QueryListProvidersByOperatorRequest{Operator: operator})
	require.NoError(t, err)
	require.Empty(t, listRes.Pairings)
}

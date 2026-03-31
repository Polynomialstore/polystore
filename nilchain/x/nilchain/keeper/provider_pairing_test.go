package keeper_test

import (
	"strings"
	"testing"

	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"nilchain/x/nilchain/keeper"
	"nilchain/x/nilchain/types"
)

func TestProviderPairingLifecycleAndQueries(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	queryServer := keeper.NewQueryServerImpl(f.keeper)

	operator := testProviderAddress(t, f, "operator_pairing___")
	provider := testProviderAddress(t, f, "provider_pairing___")
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(10)

	resOpen, err := msgServer.OpenProviderPairing(ctx, &types.MsgOpenProviderPairing{
		Creator:   operator,
		PairingId: "pair-001",
		ExpiresAt: 25,
	})
	require.NoError(t, err)
	require.True(t, resOpen.Success)

	pendingRes, err := queryServer.GetPendingProviderPairing(ctx, &types.QueryGetPendingProviderPairingRequest{PairingId: "pair-001"})
	require.NoError(t, err)
	require.Equal(t, "pair-001", pendingRes.Pairing.PairingId)
	require.Equal(t, operator, pendingRes.Pairing.Operator)
	require.Equal(t, uint64(25), pendingRes.Pairing.ExpiresAt)

	resConfirm, err := msgServer.ConfirmProviderPairing(ctx, &types.MsgConfirmProviderPairing{
		Creator:   provider,
		PairingId: "pair-001",
	})
	require.NoError(t, err)
	require.True(t, resConfirm.Success)

	getRes, err := queryServer.GetProviderPairing(ctx, &types.QueryGetProviderPairingRequest{Provider: strings.ToUpper(provider)})
	require.NoError(t, err)
	require.Equal(t, provider, getRes.Pairing.Provider)
	require.Equal(t, operator, getRes.Pairing.Operator)
	require.Equal(t, "pair-001", getRes.Pairing.PairingId)
	require.Equal(t, int64(10), getRes.Pairing.PairedHeight)

	listRes, err := queryServer.ListProvidersByOperator(ctx, &types.QueryListProvidersByOperatorRequest{Operator: strings.ToUpper(operator)})
	require.NoError(t, err)
	require.Len(t, listRes.Pairings, 1)
	require.Equal(t, provider, listRes.Pairings[0].Provider)
	require.Equal(t, operator, listRes.Pairings[0].Operator)

	_, err = queryServer.GetPendingProviderPairing(ctx, &types.QueryGetPendingProviderPairingRequest{PairingId: "pair-001"})
	require.Error(t, err)
	require.Equal(t, codes.NotFound, status.Code(err))
}

func TestOpenProviderPairingRejectsDuplicatePendingPairingID(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	operator := testProviderAddress(t, f, "operator_dupe_pair_")
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(3)

	_, err := msgServer.OpenProviderPairing(ctx, &types.MsgOpenProviderPairing{
		Creator:   operator,
		PairingId: "pair-dup",
		ExpiresAt: 20,
	})
	require.NoError(t, err)

	_, err = msgServer.OpenProviderPairing(ctx, &types.MsgOpenProviderPairing{
		Creator:   operator,
		PairingId: "pair-dup",
		ExpiresAt: 30,
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "already open")
}

func TestConfirmProviderPairingRejectsExpiredPendingPairing(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	operator := testProviderAddress(t, f, "operator_expired__")
	provider := testProviderAddress(t, f, "provider_expired__")
	openCtx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(5)

	_, err := msgServer.OpenProviderPairing(openCtx, &types.MsgOpenProviderPairing{
		Creator:   operator,
		PairingId: "pair-expired",
		ExpiresAt: 6,
	})
	require.NoError(t, err)

	confirmCtx := openCtx.WithBlockHeight(6)
	_, err = msgServer.ConfirmProviderPairing(confirmCtx, &types.MsgConfirmProviderPairing{
		Creator:   provider,
		PairingId: "pair-expired",
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "expired")

	_, err = f.keeper.PendingProviderPairings.Get(confirmCtx, "pair-expired")
	require.Error(t, err)
}

func TestUnpairProviderRequiresLinkedActorAndRemovesIndexes(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	queryServer := keeper.NewQueryServerImpl(f.keeper)

	operator := testProviderAddress(t, f, "operator_unpair___")
	provider := testProviderAddress(t, f, "provider_unpair___")
	other := testProviderAddress(t, f, "other_unpair______")
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(8)

	_, err := msgServer.OpenProviderPairing(ctx, &types.MsgOpenProviderPairing{
		Creator:   operator,
		PairingId: "pair-unpair",
		ExpiresAt: 20,
	})
	require.NoError(t, err)
	_, err = msgServer.ConfirmProviderPairing(ctx, &types.MsgConfirmProviderPairing{
		Creator:   provider,
		PairingId: "pair-unpair",
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

package keeper_test

import (
	"testing"

	"cosmossdk.io/collections"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"polystorechain/x/polystorechain/keeper"
	"polystorechain/x/polystorechain/types"
)

func TestVirtualStripeQueries(t *testing.T) {
	f := initFixture(t)
	queryServer := keeper.NewQueryServerImpl(f.keeper)
	ctx := sdk.UnwrapSDKContext(f.ctx)

	stripe2 := types.VirtualStripe{
		DealId:           42,
		StripeIndex:      2,
		OverlayProviders: []string{"provider-a", "provider-b"},
	}
	stripe3 := types.VirtualStripe{
		DealId:           42,
		StripeIndex:      3,
		OverlayProviders: []string{"provider-c", "provider-d"},
	}
	otherDealStripe := types.VirtualStripe{
		DealId:           99,
		StripeIndex:      2,
		OverlayProviders: []string{"provider-z"},
	}

	require.NoError(t, f.keeper.VirtualStripes.Set(ctx, collections.Join(stripe2.DealId, stripe2.StripeIndex), stripe2))
	require.NoError(t, f.keeper.VirtualStripes.Set(ctx, collections.Join(stripe3.DealId, stripe3.StripeIndex), stripe3))
	require.NoError(t, f.keeper.VirtualStripes.Set(ctx, collections.Join(otherDealStripe.DealId, otherDealStripe.StripeIndex), otherDealStripe))

	getRes, err := queryServer.GetVirtualStripe(ctx, &types.QueryGetVirtualStripeRequest{
		DealId:      42,
		StripeIndex: 2,
	})
	require.NoError(t, err)
	require.Equal(t, stripe2, getRes.Stripe)

	listRes, err := queryServer.ListVirtualStripesByDeal(ctx, &types.QueryListVirtualStripesByDealRequest{DealId: 42})
	require.NoError(t, err)
	require.Equal(t, []types.VirtualStripe{stripe2, stripe3}, listRes.Stripes)

	_, err = queryServer.GetVirtualStripe(ctx, &types.QueryGetVirtualStripeRequest{
		DealId:      42,
		StripeIndex: 9,
	})
	require.Error(t, err)
	require.Equal(t, codes.NotFound, status.Code(err))

	_, err = queryServer.ListVirtualStripesByDeal(ctx, &types.QueryListVirtualStripesByDealRequest{})
	require.Error(t, err)
	require.Equal(t, codes.InvalidArgument, status.Code(err))
}

package keeper_test

import (
	"fmt"
	"testing"

	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"

	"polystorechain/x/polystorechain/keeper"
	"polystorechain/x/polystorechain/types"
)

func registerCapabilityProviders(t *testing.T, f *fixture, prefix string, capabilities []string) []string {
	t.Helper()

	msgServer := keeper.NewMsgServerImpl(f.keeper)
	providers := make([]string, 0, len(capabilities))
	for i, capability := range capabilities {
		addrBz := []byte(fmt.Sprintf("%s_%02d", prefix, i))
		addr, err := f.addressCodec.BytesToString(addrBz)
		require.NoError(t, err)
		_, err = msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{
			Creator:      addr,
			Capabilities: capability,
			TotalStorage: 100000000000,
			Endpoints:    testProviderEndpoints,
		})
		require.NoError(t, err)
		providers = append(providers, addr)
	}

	return providers
}

func TestAssignProvidersPrefersEdgeForHotWhenEnoughCapacity(t *testing.T) {
	f := initFixture(t)
	sdkCtx := sdk.UnwrapSDKContext(f.ctx)
	registerCapabilityProviders(t, f, "hot_edge_pref", []string{
		"General", "General", "General",
		"Edge", "Edge", "Edge",
		"Archive", "Archive",
	})

	assigned, err := f.keeper.AssignProviders(sdkCtx, 77, []byte("hot-edge-preference"), "Hot", 3)
	require.NoError(t, err)
	require.Len(t, assigned, 3)

	for _, providerAddr := range assigned {
		provider, err := f.keeper.Providers.Get(sdkCtx, providerAddr)
		require.NoError(t, err)
		require.Equal(t, "Edge", provider.Capabilities)
	}
}

func TestAssignProvidersFallsBackToGeneralForHotWhenEdgeUnderfilled(t *testing.T) {
	f := initFixture(t)
	sdkCtx := sdk.UnwrapSDKContext(f.ctx)
	registerCapabilityProviders(t, f, "hot_edge_fallback", []string{
		"Edge", "Edge",
		"General", "General", "General",
		"Archive", "Archive",
	})

	assigned, err := f.keeper.AssignProviders(sdkCtx, 78, []byte("hot-edge-fallback"), "Hot", 4)
	require.NoError(t, err)
	require.Len(t, assigned, 4)

	var generalCount int
	for _, providerAddr := range assigned {
		provider, err := f.keeper.Providers.Get(sdkCtx, providerAddr)
		require.NoError(t, err)
		require.NotEqual(t, "Archive", provider.Capabilities)
		if provider.Capabilities == "General" {
			generalCount++
		}
	}
	require.Positive(t, generalCount)
}

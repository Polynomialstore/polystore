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

func TestAssignProvidersHotPreferenceIgnoresInactiveAndDrainingEdge(t *testing.T) {
	f := initFixture(t)
	sdkCtx := sdk.UnwrapSDKContext(f.ctx)
	providers := registerCapabilityProviders(t, f, "hot_edge_health", []string{
		"Edge", "Edge", "Edge", "Edge",
		"General", "General",
	})

	offlineEdge, err := f.keeper.Providers.Get(sdkCtx, providers[0])
	require.NoError(t, err)
	offlineEdge.Status = "Offline"
	require.NoError(t, f.keeper.Providers.Set(sdkCtx, providers[0], offlineEdge))

	drainingEdge, err := f.keeper.Providers.Get(sdkCtx, providers[1])
	require.NoError(t, err)
	drainingEdge.Draining = true
	require.NoError(t, f.keeper.Providers.Set(sdkCtx, providers[1], drainingEdge))

	assigned, err := f.keeper.AssignProviders(sdkCtx, 79, []byte("hot-edge-health"), "Hot", 2)
	require.NoError(t, err)
	require.Len(t, assigned, 2)
	require.NotContains(t, assigned, providers[0])
	require.NotContains(t, assigned, providers[1])

	for _, providerAddr := range assigned {
		provider, err := f.keeper.Providers.Get(sdkCtx, providerAddr)
		require.NoError(t, err)
		require.Equal(t, "Edge", provider.Capabilities)
		require.Equal(t, "Active", provider.Status)
		require.False(t, provider.Draining)
	}
}

func TestAssignProvidersDoesNotApplyEdgePreferenceToCold(t *testing.T) {
	f := initFixture(t)
	sdkCtx := sdk.UnwrapSDKContext(f.ctx)
	registerCapabilityProviders(t, f, "cold_no_edge_pref", []string{
		"Edge", "Edge",
		"Archive", "Archive",
		"General",
	})

	assigned, err := f.keeper.AssignProviders(sdkCtx, 80, []byte("cold-no-edge-preference"), "Cold", 3)
	require.NoError(t, err)
	require.Len(t, assigned, 3)

	var archiveCount int
	for _, providerAddr := range assigned {
		provider, err := f.keeper.Providers.Get(sdkCtx, providerAddr)
		require.NoError(t, err)
		require.NotEqual(t, "Edge", provider.Capabilities)
		if provider.Capabilities == "Archive" {
			archiveCount++
		}
	}
	require.Positive(t, archiveCount)
}

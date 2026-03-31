package keeper_test

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"nilchain/x/nilchain/keeper"
	"nilchain/x/nilchain/types"
)

func testProviderAddress(t *testing.T, f *fixture, raw string) string {
	t.Helper()
	addr, err := f.addressCodec.BytesToString([]byte(raw))
	require.NoError(t, err)
	return addr
}

func TestRegisterProviderRejectsCanonicalDuplicateAndPreservesExistingProvider(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	creator := testProviderAddress(t, f, "provider_dup________")

	_, err := msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{
		Creator:      creator,
		Capabilities: "General",
		TotalStorage: 1000,
		Endpoints:    []string{"/ip4/127.0.0.1/tcp/8080/http"},
	})
	require.NoError(t, err)

	original, err := f.keeper.Providers.Get(f.ctx, creator)
	require.NoError(t, err)

	_, err = msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{
		Creator:      creator,
		Capabilities: "Archive",
		TotalStorage: 999999,
		Endpoints:    []string{"/dns4/overwrite.example/tcp/443/https"},
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "already registered")

	stored, err := f.keeper.Providers.Get(f.ctx, creator)
	require.NoError(t, err)
	require.Equal(t, original, stored)
}

func TestRegisterProviderRejectsNonCanonicalCreatorAndPreservesExistingProvider(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	creator := testProviderAddress(t, f, "provider_case_______")

	_, err := msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{
		Creator:      creator,
		Capabilities: "General",
		TotalStorage: 1000,
		Endpoints:    []string{"/ip4/127.0.0.1/tcp/8080/http"},
	})
	require.NoError(t, err)

	original, err := f.keeper.Providers.Get(f.ctx, creator)
	require.NoError(t, err)

	_, err = msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{
		Creator:      strings.ToUpper(creator),
		Capabilities: "Archive",
		TotalStorage: 999999,
		Endpoints:    []string{"/dns4/overwrite.example/tcp/443/https"},
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "canonical address string")

	stored, err := f.keeper.Providers.Get(f.ctx, creator)
	require.NoError(t, err)
	require.Equal(t, original, stored)
}

func TestUpdateProviderEndpointsUpdatesOnlyEndpoints(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	creator := testProviderAddress(t, f, "provider_update_____")

	_, err := msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{
		Creator:      creator,
		Capabilities: "General",
		TotalStorage: 1000,
		Endpoints:    []string{"/ip4/127.0.0.1/tcp/8080/http"},
	})
	require.NoError(t, err)

	provider, err := f.keeper.Providers.Get(f.ctx, creator)
	require.NoError(t, err)
	provider.UsedStorage = 111
	provider.Status = "Offline"
	provider.ReputationScore = 77
	provider.Draining = true
	require.NoError(t, f.keeper.Providers.Set(f.ctx, creator, provider))

	newEndpoints := []string{
		"/dns4/provider.nil/tcp/443/https",
		"/ip4/127.0.0.1/tcp/8081/http",
	}
	res, err := msgServer.UpdateProviderEndpoints(f.ctx, &types.MsgUpdateProviderEndpoints{
		Creator:   creator,
		Endpoints: newEndpoints,
	})
	require.NoError(t, err)
	require.True(t, res.Success)

	updated, err := f.keeper.Providers.Get(f.ctx, creator)
	require.NoError(t, err)
	require.Equal(t, newEndpoints, updated.Endpoints)
	require.Equal(t, provider.Address, updated.Address)
	require.Equal(t, provider.TotalStorage, updated.TotalStorage)
	require.Equal(t, provider.UsedStorage, updated.UsedStorage)
	require.Equal(t, provider.Capabilities, updated.Capabilities)
	require.Equal(t, provider.Status, updated.Status)
	require.Equal(t, provider.ReputationScore, updated.ReputationScore)
	require.Equal(t, provider.Draining, updated.Draining)
}

func TestUpdateProviderEndpointsRejectsInvalidEndpointSet(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	creator := testProviderAddress(t, f, "provider_invalid____")

	_, err := msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{
		Creator:      creator,
		Capabilities: "General",
		TotalStorage: 1000,
		Endpoints:    []string{"/ip4/127.0.0.1/tcp/8080/http"},
	})
	require.NoError(t, err)

	original, err := f.keeper.Providers.Get(f.ctx, creator)
	require.NoError(t, err)

	_, err = msgServer.UpdateProviderEndpoints(f.ctx, &types.MsgUpdateProviderEndpoints{
		Creator:   creator,
		Endpoints: []string{"not-a-multiaddr"},
	})
	require.Error(t, err)

	stored, err := f.keeper.Providers.Get(f.ctx, creator)
	require.NoError(t, err)
	require.Equal(t, original, stored)
}

func TestUpdateProviderEndpointsRejectsUnknownProviderCreator(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	creator := testProviderAddress(t, f, "provider_missing____")

	_, err := msgServer.UpdateProviderEndpoints(f.ctx, &types.MsgUpdateProviderEndpoints{
		Creator:   creator,
		Endpoints: []string{"/ip4/127.0.0.1/tcp/8081/http"},
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "provider not found")
}

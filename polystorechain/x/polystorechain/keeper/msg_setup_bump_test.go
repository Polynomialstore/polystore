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

func registerGeneralProvidersForSetupBump(t *testing.T, f *fixture, prefix string, count int) []string {
	t.Helper()

	msgServer := keeper.NewMsgServerImpl(f.keeper)
	providers := make([]string, 0, count)
	for i := 0; i < count; i += 1 {
		addrBz := []byte(fmt.Sprintf("%s%02d", prefix, i))
		addr, err := f.addressCodec.BytesToString(addrBz)
		require.NoError(t, err)
		_, err = msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{
			Creator:      addr,
			Capabilities: "General",
			TotalStorage: 100000000000,
			Endpoints:    testProviderEndpoints,
		})
		require.NoError(t, err)
		providers = append(providers, addr)
	}
	return providers
}

func createMode2SetupDeal(t *testing.T, f *fixture, prefix string) (user string, deal types.Deal) {
	t.Helper()
	return createMode2SetupDealWithProviderCount(t, f, prefix, 6)
}

func createMode2SetupDealWithProviderCount(t *testing.T, f *fixture, prefix string, providerCount int) (user string, deal types.Deal) {
	t.Helper()

	registerGeneralProvidersForSetupBump(t, f, prefix, providerCount)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	userBz := []byte(fmt.Sprintf("%s_user__________", prefix))
	user, err := f.addressCodec.BytesToString(userBz)
	require.NoError(t, err)

	res, err := msgServer.CreateDeal(f.ctx, &types.MsgCreateDeal{
		Creator:             user,
		DurationBlocks:      1000,
		ServiceHint:         "General:rs=2+1",
		MaxMonthlySpend:     math.NewInt(500000),
		InitialEscrowAmount: math.NewInt(1000000),
	})
	require.NoError(t, err)

	deal, err = f.keeper.Deals.Get(f.ctx, res.DealId)
	require.NoError(t, err)
	require.Len(t, deal.Mode2Slots, 3)
	require.Equal(t, uint64(0), deal.TotalMdus)
	require.Equal(t, uint64(0), deal.Size_)
	return user, deal
}

func TestBumpDealSetupSlot_ReplacesProviderAndTracksNonce(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	user, deal := createMode2SetupDeal(t, f, "setup_bump_replace____")
	sdkCtx := sdk.UnwrapSDKContext(f.ctx).WithEventManager(sdk.NewEventManager())
	f.ctx = sdkCtx

	oldProvider := deal.Mode2Slots[0].Provider
	require.NotEmpty(t, oldProvider)

	res, err := msgServer.BumpDealSetupSlot(f.ctx, &types.MsgBumpDealSetupSlot{
		Creator:          user,
		DealId:           deal.Id,
		Slot:             0,
		ExpectedProvider: oldProvider,
	})
	require.NoError(t, err)
	require.True(t, res.Success)
	require.NotEmpty(t, res.NewProvider)
	require.NotEqual(t, oldProvider, res.NewProvider)

	updated, err := f.keeper.Deals.Get(f.ctx, deal.Id)
	require.NoError(t, err)
	require.Equal(t, res.NewProvider, updated.Mode2Slots[0].Provider)
	require.Equal(t, res.NewProvider, updated.Providers[0])
	require.Equal(t, types.SlotStatus_SLOT_STATUS_ACTIVE, updated.Mode2Slots[0].Status)
	require.Equal(t, "", updated.Mode2Slots[0].PendingProvider)
	require.Empty(t, evidenceSummaries(t, f, sdkCtx, ""), "setup bump should not create punitive or hard-fault evidence")

	oldProviderState, err := f.keeper.Providers.Get(sdkCtx, oldProvider)
	require.NoError(t, err)
	require.Equal(t, "Active", oldProviderState.Status)
	require.False(t, oldProviderState.Draining)

	newProviderState, err := f.keeper.Providers.Get(sdkCtx, res.NewProvider)
	require.NoError(t, err)
	require.Equal(t, "Active", newProviderState.Status)
	require.False(t, newProviderState.Draining)

	nonce, err := f.keeper.SetupBumpNonce.Get(sdk.UnwrapSDKContext(f.ctx), collections.Join(deal.Id, uint32(0)))
	require.NoError(t, err)
	require.Equal(t, uint64(1), nonce)

	tried, err := f.keeper.SetupTriedProvider.Get(
		sdk.UnwrapSDKContext(f.ctx),
		collections.Join(collections.Join(deal.Id, uint32(0)), oldProvider),
	)
	require.NoError(t, err)
	require.True(t, tried)

	foundEvent := false
	for _, event := range sdkCtx.EventManager().Events() {
		if event.Type != types.TypeMsgBumpDealSetupSlot {
			continue
		}
		foundEvent = true
		attrs := map[string]string{}
		for _, attr := range event.Attributes {
			attrs[attr.Key] = attr.Value
		}
		require.Equal(t, fmt.Sprintf("%d", deal.Id), attrs[types.AttributeKeyDealID])
		require.Equal(t, "0", attrs["slot"])
		require.Equal(t, oldProvider, attrs["old_provider"])
		require.Equal(t, res.NewProvider, attrs["new_provider"])
		require.Equal(t, "1", attrs["bump_nonce"])
	}
	require.True(t, foundEvent, "missing setup bump event")
}

func TestBumpDealSetupSlot_IsDeterministicForSameInitialState(t *testing.T) {
	f1 := initFixture(t)
	user1, deal1 := createMode2SetupDeal(t, f1, "setup_bump_determin_1")
	msgServer1 := keeper.NewMsgServerImpl(f1.keeper)
	res1, err := msgServer1.BumpDealSetupSlot(f1.ctx, &types.MsgBumpDealSetupSlot{
		Creator:          user1,
		DealId:           deal1.Id,
		Slot:             0,
		ExpectedProvider: deal1.Mode2Slots[0].Provider,
	})
	require.NoError(t, err)

	f2 := initFixture(t)
	user2, deal2 := createMode2SetupDeal(t, f2, "setup_bump_determin_1")
	msgServer2 := keeper.NewMsgServerImpl(f2.keeper)
	res2, err := msgServer2.BumpDealSetupSlot(f2.ctx, &types.MsgBumpDealSetupSlot{
		Creator:          user2,
		DealId:           deal2.Id,
		Slot:             0,
		ExpectedProvider: deal2.Mode2Slots[0].Provider,
	})
	require.NoError(t, err)

	require.Equal(t, res1.NewProvider, res2.NewProvider)
}

func TestBumpDealSetupSlot_NoCandidateLeavesSlotAndDoesNotPunish(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	user, deal := createMode2SetupDealWithProviderCount(t, f, "setup_bump_no_cand__", 3)
	sdkCtx := sdk.UnwrapSDKContext(f.ctx).WithEventManager(sdk.NewEventManager())
	f.ctx = sdkCtx

	oldProvider := deal.Mode2Slots[0].Provider
	_, err := msgServer.BumpDealSetupSlot(f.ctx, &types.MsgBumpDealSetupSlot{
		Creator:          user,
		DealId:           deal.Id,
		Slot:             0,
		ExpectedProvider: oldProvider,
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "no setup bump provider candidates available")

	updated, err := f.keeper.Deals.Get(sdkCtx, deal.Id)
	require.NoError(t, err)
	require.Equal(t, oldProvider, updated.Mode2Slots[0].Provider)
	require.Equal(t, oldProvider, updated.Providers[0])
	require.Equal(t, types.SlotStatus_SLOT_STATUS_ACTIVE, updated.Mode2Slots[0].Status)
	require.Empty(t, updated.Mode2Slots[0].PendingProvider)
	require.Empty(t, evidenceSummaries(t, f, sdkCtx, ""), "failed setup bump should not create punitive or hard-fault evidence")

	oldProviderState, err := f.keeper.Providers.Get(sdkCtx, oldProvider)
	require.NoError(t, err)
	require.Equal(t, "Active", oldProviderState.Status)
	require.False(t, oldProviderState.Draining)

	_, err = f.keeper.SetupBumpNonce.Get(sdkCtx, collections.Join(deal.Id, uint32(0)))
	require.ErrorIs(t, err, collections.ErrNotFound)
	_, err = f.keeper.SetupTriedProvider.Get(
		sdkCtx,
		collections.Join(collections.Join(deal.Id, uint32(0)), oldProvider),
	)
	require.ErrorIs(t, err, collections.ErrNotFound)
}

func TestBumpDealSetupSlot_RejectsWrongOwnerAndExpectedProvider(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	user, deal := createMode2SetupDeal(t, f, "setup_bump_guard______")

	otherBz := []byte("setup_bump_other_____")
	other, err := f.addressCodec.BytesToString(otherBz)
	require.NoError(t, err)

	_, err = msgServer.BumpDealSetupSlot(f.ctx, &types.MsgBumpDealSetupSlot{
		Creator:          other,
		DealId:           deal.Id,
		Slot:             0,
		ExpectedProvider: deal.Mode2Slots[0].Provider,
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "only deal owner")

	_, err = msgServer.BumpDealSetupSlot(f.ctx, &types.MsgBumpDealSetupSlot{
		Creator:          user,
		DealId:           deal.Id,
		Slot:             0,
		ExpectedProvider: "nil1doesnotmatch",
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "expected_provider")
}

func TestBumpDealSetupSlot_RejectsCommittedDealsAndRespectsCap(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	user, deal := createMode2SetupDeal(t, f, "setup_bump_limits_____")

	params := f.keeper.GetParams(sdk.UnwrapSDKContext(f.ctx))
	params.MaxSetupBumpsPerSlot = 1
	require.NoError(t, f.keeper.Params.Set(sdk.UnwrapSDKContext(f.ctx), params))

	_, err := msgServer.BumpDealSetupSlot(f.ctx, &types.MsgBumpDealSetupSlot{
		Creator:          user,
		DealId:           deal.Id,
		Slot:             0,
		ExpectedProvider: deal.Mode2Slots[0].Provider,
	})
	require.NoError(t, err)

	updated, err := f.keeper.Deals.Get(f.ctx, deal.Id)
	require.NoError(t, err)
	_, err = msgServer.BumpDealSetupSlot(f.ctx, &types.MsgBumpDealSetupSlot{
		Creator:          user,
		DealId:           deal.Id,
		Slot:             0,
		ExpectedProvider: updated.Mode2Slots[0].Provider,
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "max setup bumps")

	committed := updated
	committed.Size_ = 123
	committed.TotalMdus = 5
	require.NoError(t, f.keeper.Deals.Set(sdk.UnwrapSDKContext(f.ctx), committed.Id, committed))

	_, err = msgServer.BumpDealSetupSlot(f.ctx, &types.MsgBumpDealSetupSlot{
		Creator:          user,
		DealId:           committed.Id,
		Slot:             1,
		ExpectedProvider: committed.Mode2Slots[1].Provider,
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "only allowed before the first content commit")
}

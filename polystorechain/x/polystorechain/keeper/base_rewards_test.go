package keeper_test

import (
	"context"
	"fmt"
	"testing"

	"cosmossdk.io/collections"
	"cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"

	"polystorechain/x/polystorechain/keeper"
	"polystorechain/x/polystorechain/types"
)

func setupBaseRewardMode2Deal(t *testing.T, f *fixture, bank *trackingBankKeeper, label string) (sdk.Context, uint64, []string) {
	t.Helper()

	msgServer := keeper.NewMsgServerImpl(f.keeper)

	// Register minimal providers for Mode 2 (rs=2+1).
	for i := 0; i < 3; i++ {
		addrBz := make([]byte, 20)
		copy(addrBz, []byte(fmt.Sprintf("%s_prov_%02d", label, i)))
		addr, _ := f.addressCodec.BytesToString(addrBz)
		_, err := msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{
			Creator:      addr,
			Capabilities: "General",
			TotalStorage: 100000000000,
			Endpoints:    testProviderEndpoints,
		})
		require.NoError(t, err)
	}

	ctx2 := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(2)
	p := types.DefaultParams()
	p.EpochLenBlocks = 10
	p.StoragePrice = math.LegacyMustNewDecFromStr("0.000001")
	p.EmissionStartHeight = 1
	p.BaseRewardHalvingIntervalBlocks = 1000000
	p.BaseRewardBpsStart = 10000
	p.BaseRewardBpsTail = 0
	require.NoError(t, f.keeper.Params.Set(ctx2, p))

	userBz := make([]byte, 20)
	copy(userBz, []byte(label+"_user"))
	user, _ := f.addressCodec.BytesToString(userBz)
	userAddr, err := sdk.AccAddressFromBech32(user)
	require.NoError(t, err)
	bank.setAccountBalance(userAddr, sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 1000000)))

	resDeal, err := msgServer.CreateDeal(ctx2, &types.MsgCreateDeal{
		Creator:             user,
		DurationBlocks:      200,
		ServiceHint:         "General:rs=2+1",
		MaxMonthlySpend:     math.NewInt(0),
		InitialEscrowAmount: math.NewInt(0),
	})
	require.NoError(t, err)
	require.Len(t, resDeal.AssignedProviders, 3)

	_, err = msgServer.UpdateDealContent(ctx2, &types.MsgUpdateDealContent{
		Creator:     user,
		DealId:      resDeal.DealId,
		Cid:         validManifestCid,
		Size_:       1,
		TotalMdus:   2, // meta=1, user=1
		WitnessMdus: 0,
	})
	require.NoError(t, err)
	return ctx2, resDeal.DealId, resDeal.AssignedProviders
}

func setMode2BaseRewardCredits(t *testing.T, f *fixture, ctx sdk.Context, dealID uint64, epochID uint64, slots ...uint32) {
	t.Helper()

	for _, slot := range slots {
		key := collections.Join(collections.Join(dealID, slot), epochID)
		require.NoError(t, f.keeper.Mode2EpochCredits.Set(ctx, key, 100))
	}
}

func requireProviderBalance(t *testing.T, bank *trackingBankKeeper, provider string, expected string) {
	t.Helper()

	addr, err := sdk.AccAddressFromBech32(provider)
	require.NoError(t, err)
	require.Equal(t, expected, bank.GetBalance(context.Background(), addr, sdk.DefaultBondDenom).String())
}

func TestBaseRewardPool_DistributesBySlotBytesWhenCompliant(t *testing.T) {
	bank := newTrackingBankKeeper()
	f := initFixtureWithBankKeeper(t, bank)
	ctx2, dealID, assignedProviders := setupBaseRewardMode2Deal(t, f, bank, "rall")

	// Make both providers quota-compliant for epoch 1.
	epochID := uint64(1)
	deal, err := f.keeper.Deals.Get(ctx2, dealID)
	require.NoError(t, err)
	require.NotEmpty(t, deal.Mode2Slots)
	for _, slot := range deal.Mode2Slots {
		if slot == nil {
			continue
		}
		setMode2BaseRewardCredits(t, f, ctx2, dealID, epochID, slot.Slot)
	}

	// Epoch 1 ends at height 10 when epoch_len_blocks == 10.
	ctx10 := ctx2.WithBlockHeight(10)
	require.NoError(t, f.keeper.CheckMissedProofs(ctx10))

	for _, provider := range assignedProviders {
		requireProviderBalance(t, bank, provider, "42stake")
	}
}

func TestBaseRewardPool_ExcludesQuotaShortfallSlot(t *testing.T) {
	bank := newTrackingBankKeeper()
	f := initFixtureWithBankKeeper(t, bank)
	ctx2, dealID, _ := setupBaseRewardMode2Deal(t, f, bank, "rmiss")

	deal, err := f.keeper.Deals.Get(ctx2, dealID)
	require.NoError(t, err)
	require.Len(t, deal.Mode2Slots, 3)

	epochID := uint64(1)
	setMode2BaseRewardCredits(t, f, ctx2, dealID, epochID, deal.Mode2Slots[0].Slot, deal.Mode2Slots[1].Slot)

	ctx10 := ctx2.WithBlockHeight(10)
	require.NoError(t, f.keeper.CheckMissedProofs(ctx10))

	requireProviderBalance(t, bank, deal.Mode2Slots[0].Provider, "63stake")
	requireProviderBalance(t, bank, deal.Mode2Slots[1].Provider, "63stake")
	requireProviderBalance(t, bank, deal.Mode2Slots[2].Provider, "0stake")

	excludedProvider, err := f.keeper.Providers.Get(ctx10, deal.Mode2Slots[2].Provider)
	require.NoError(t, err)
	require.Equal(t, "Active", excludedProvider.Status)
	require.True(t, hasEvidenceSummary(t, f, ctx10, "quota_miss_recorded"))
	require.False(t, hasEvidenceSummary(t, f, ctx10, "quota_miss_repair_started"))
}

func TestBaseRewardPool_ExcludesRepairingSlotResponsibility(t *testing.T) {
	bank := newTrackingBankKeeper()
	f := initFixtureWithBankKeeper(t, bank)
	ctx2, dealID, _ := setupBaseRewardMode2Deal(t, f, bank, "rrep")

	deal, err := f.keeper.Deals.Get(ctx2, dealID)
	require.NoError(t, err)
	require.Len(t, deal.Mode2Slots, 3)

	repairingProvider := deal.Mode2Slots[2].Provider
	deal.Mode2Slots[2].Status = types.SlotStatus_SLOT_STATUS_REPAIRING
	deal.Mode2Slots[2].StatusSinceHeight = 9
	require.NoError(t, f.keeper.Deals.Set(ctx2, dealID, deal))

	epochID := uint64(1)
	setMode2BaseRewardCredits(t, f, ctx2, dealID, epochID, deal.Mode2Slots[0].Slot, deal.Mode2Slots[1].Slot)

	ctx10 := ctx2.WithBlockHeight(10)
	require.NoError(t, f.keeper.CheckMissedProofs(ctx10))

	requireProviderBalance(t, bank, deal.Mode2Slots[0].Provider, "42stake")
	requireProviderBalance(t, bank, deal.Mode2Slots[1].Provider, "42stake")
	requireProviderBalance(t, bank, repairingProvider, "0stake")
}

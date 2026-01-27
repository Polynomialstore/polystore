package keeper_test

import (
	"fmt"
	"testing"

	"cosmossdk.io/collections"
	"cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"

	"nilchain/x/nilchain/keeper"
	"nilchain/x/nilchain/types"
)

func TestBaseRewardPool_DistributesBySlotBytesWhenCompliant(t *testing.T) {
	bank := newTrackingBankKeeper()
	f := initFixtureWithBankKeeper(t, bank)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	// Register minimal providers for Mode 2 (rs=2+1).
	for i := 0; i < 3; i++ {
		addrBz := make([]byte, 20)
		copy(addrBz, []byte(fmt.Sprintf("provider_reward_%02d", i)))
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
	copy(userBz, []byte("user_reward_test____"))
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

	// Make both providers quota-compliant for epoch 1.
	epochID := uint64(1)
	deal, err := f.keeper.Deals.Get(ctx2, resDeal.DealId)
	require.NoError(t, err)
	require.NotEmpty(t, deal.Mode2Slots)
	for _, slot := range deal.Mode2Slots {
		if slot == nil {
			continue
		}
		key := collections.Join(collections.Join(resDeal.DealId, slot.Slot), epochID)
		require.NoError(t, f.keeper.Mode2EpochCredits.Set(ctx2, key, 100))
	}

	// Epoch 1 ends at height 10 when epoch_len_blocks == 10.
	ctx10 := ctx2.WithBlockHeight(10)
	require.NoError(t, f.keeper.CheckMissedProofs(ctx10))

	for _, provider := range resDeal.AssignedProviders {
		addr, err := sdk.AccAddressFromBech32(provider)
		require.NoError(t, err)
		require.Equal(t, "42stake", bank.accountBalances[addr.String()].String())
	}
}

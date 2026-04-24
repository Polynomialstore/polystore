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

func setupAuditBudgetMode2Deal(t *testing.T, f *fixture, bank *trackingBankKeeper, label string, p types.Params) sdk.Context {
	t.Helper()

	msgServer := keeper.NewMsgServerImpl(f.keeper)

	// Register providers for deterministic placement.
	for i := 0; i < 3; i++ {
		addrBz := make([]byte, 20)
		copy(addrBz, []byte(fmt.Sprintf("%s_aud_%02d", label, i)))
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
	require.NoError(t, f.keeper.Params.Set(ctx2, p))

	userBz := make([]byte, 20)
	copy(userBz, []byte(label+"_user"))
	user, _ := f.addressCodec.BytesToString(userBz)
	userAddr, err := sdk.AccAddressFromBech32(user)
	require.NoError(t, err)
	// Fund the user for the term deposit charged at UpdateDealContent.
	bank.setAccountBalance(userAddr, sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 1000)))

	resDeal, err := msgServer.CreateDeal(ctx2, &types.MsgCreateDeal{
		Creator:             user,
		DurationBlocks:      200,
		ServiceHint:         "General:rs=2+1",
		MaxMonthlySpend:     math.NewInt(0),
		InitialEscrowAmount: math.NewInt(0),
	})
	require.NoError(t, err)

	_, err = msgServer.UpdateDealContent(ctx2, &types.MsgUpdateDealContent{
		Creator:     user,
		DealId:      resDeal.DealId,
		Cid:         validManifestCid,
		Size_:       1,
		TotalMdus:   2, // meta=1, user=1
		WitnessMdus: 0,
	})
	require.NoError(t, err)
	return ctx2
}

func countAuditTasks(t *testing.T, f *fixture, ctx sdk.Context, epochID uint64) int {
	t.Helper()

	taskCount := 0
	require.NoError(t, f.keeper.AuditTasks.Walk(ctx, nil, func(key collections.Pair[uint64, uint64], task types.AuditTask) (stop bool, err error) {
		if task.EpochId == epochID {
			taskCount++
		}
		return false, nil
	}))
	return taskCount
}

func defaultAuditBudgetTestParams() types.Params {
	p := types.DefaultParams()
	p.EpochLenBlocks = 10
	p.StoragePrice = math.LegacyMustNewDecFromStr("0.000001") // 1e-6 stake per byte per block
	p.BaseRetrievalFee = sdk.NewInt64Coin(sdk.DefaultBondDenom, 1)
	p.RetrievalPricePerBlob = sdk.NewInt64Coin(sdk.DefaultBondDenom, 1)
	p.AuditBudgetBps = 10000
	p.AuditBudgetCapBps = 10000
	p.AuditBudgetCarryoverEpochs = 1
	return p
}

func TestBeginBlock_MintsAuditBudgetAndDerivesAuditTasks(t *testing.T) {
	bank := newTrackingBankKeeper()
	f := initFixtureWithBankKeeper(t, bank)
	ctx2 := setupAuditBudgetMode2Deal(t, f, bank, "abb", defaultAuditBudgetTestParams())

	// Epoch 2 starts at height 11 when epoch_len_blocks == 10.
	ctx11 := ctx2.WithBlockHeight(11)
	require.NoError(t, f.keeper.BeginBlock(ctx11))

	// Expected notional rent:
	// storage_price * slot_bytes * epoch_len
	// = 1e-6 * (3 * 4MiB) * 10 = 125.82912, ceil => 126.
	require.Equal(t, "126stake", bank.moduleBalances[types.ProtocolBudgetModuleName].String())

	epochID := uint64(2)
	// Budget=126, cost/task=2 => 63 tasks (bounded by auditTasksMaxPerEpoch=64).
	require.Equal(t, 63, countAuditTasks(t, f, ctx11, epochID))
}

func TestBeginBlock_AuditTasksBoundedByAvailableBudget(t *testing.T) {
	bank := newTrackingBankKeeper()
	f := initFixtureWithBankKeeper(t, bank)

	p := defaultAuditBudgetTestParams()
	p.BaseRetrievalFee = sdk.NewInt64Coin(sdk.DefaultBondDenom, 200)
	p.RetrievalPricePerBlob = sdk.NewInt64Coin(sdk.DefaultBondDenom, 0)
	ctx2 := setupAuditBudgetMode2Deal(t, f, bank, "abound", p)

	ctx11 := ctx2.WithBlockHeight(11)
	require.NoError(t, f.keeper.BeginBlock(ctx11))

	require.Equal(t, "126stake", bank.moduleBalances[types.ProtocolBudgetModuleName].String())
	require.Equal(t, 0, countAuditTasks(t, f, ctx11, 2))
}

func TestBeginBlock_AuditBudgetCarryoverCapBurnsExcess(t *testing.T) {
	bank := newTrackingBankKeeper()
	f := initFixtureWithBankKeeper(t, bank)
	ctx2 := setupAuditBudgetMode2Deal(t, f, bank, "acap", defaultAuditBudgetTestParams())

	ctx11 := ctx2.WithBlockHeight(11)
	require.NoError(t, f.keeper.BeginBlock(ctx11))
	require.Equal(t, "126stake", bank.moduleBalances[types.ProtocolBudgetModuleName].String())

	ctx21 := ctx2.WithBlockHeight(21)
	require.NoError(t, f.keeper.BeginBlock(ctx21))

	require.Equal(t, "126stake", bank.moduleBalances[types.ProtocolBudgetModuleName].String())
	require.Equal(t, 63, countAuditTasks(t, f, ctx21, 2))
	require.Equal(t, 63, countAuditTasks(t, f, ctx21, 3))
}

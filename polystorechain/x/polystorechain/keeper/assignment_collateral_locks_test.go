package keeper_test

import (
	"fmt"
	"testing"

	"cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkquery "github.com/cosmos/cosmos-sdk/types/query"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"polystorechain/x/polystorechain/keeper"
	"polystorechain/x/polystorechain/types"
)

func TestAssignmentCollateralLocksSyncOnCreateDeal(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	queryServer := keeper.NewQueryServerImpl(f.keeper)
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(5)

	require.NoError(t, f.keeper.Params.Set(ctx, collateralPolicyParams(0, 25)))
	providers := make([]string, 0, 20)
	for i := 0; i < 20; i++ {
		provider := makePolicyTestAddr(t, f, byte(i+1))
		providers = append(providers, provider)
	}
	registerPolicyTestProviders(t, f, ctx, providers...)
	for _, provider := range providers {
		setProviderBondForTest(t, f, ctx, provider, 100)
	}

	owner := makePolicyTestAddr(t, f, 0xEE)
	res, err := msgServer.CreateDeal(ctx, &types.MsgCreateDeal{
		Creator:             owner,
		DurationBlocks:      1000,
		ServiceHint:         "General:rs=8+4",
		InitialEscrowAmount: math.NewInt(1_000_000),
		MaxMonthlySpend:     math.NewInt(500_000),
	})
	require.NoError(t, err)

	deal, err := f.keeper.Deals.Get(ctx, res.DealId)
	require.NoError(t, err)
	require.NotEmpty(t, deal.Mode2Slots)

	list, err := queryServer.ListAssignmentCollateralLocksByDeal(ctx, &types.QueryListAssignmentCollateralLocksByDealRequest{
		DealId:     res.DealId,
		Pagination: &sdkquery.PageRequest{Limit: 100, CountTotal: true},
	})
	require.NoError(t, err)
	require.Len(t, list.Locks, len(deal.Mode2Slots))
	require.Equal(t, uint64(len(deal.Mode2Slots)), list.Pagination.Total)

	expectedAmount := sdk.NewInt64Coin(sdk.DefaultBondDenom, 25)
	for _, lock := range list.Locks {
		require.Equal(t, res.DealId, lock.DealId)
		require.Equal(t, types.AssignmentCollateralLockRole_ASSIGNMENT_COLLATERAL_LOCK_ROLE_ACTIVE, lock.Role)
		require.Equal(t, expectedAmount, lock.Amount)
		require.Equal(t, deal.CurrentGen, lock.Generation)
		require.Equal(t, int64(5), lock.LockedAtHeight)
		require.Equal(t, int64(5), lock.UpdatedHeight)
		require.Equal(t, "slot_active", lock.Reason)
		require.NotEmpty(t, lock.Provider)
		require.Less(t, int(lock.Slot), len(deal.Mode2Slots))
		require.Equal(t, lock.Provider, deal.Mode2Slots[lock.Slot].Provider)
	}

	first := list.Locks[0]
	get, err := queryServer.GetAssignmentCollateralLock(ctx, &types.QueryGetAssignmentCollateralLockRequest{
		Provider: first.Provider,
		DealId:   first.DealId,
		Slot:     first.Slot,
	})
	require.NoError(t, err)
	require.Equal(t, first, get.Lock)

	byProvider, err := queryServer.ListAssignmentCollateralLocksByProvider(ctx, &types.QueryListAssignmentCollateralLocksByProviderRequest{
		Provider:   first.Provider,
		Pagination: &sdkquery.PageRequest{Limit: 100, CountTotal: true},
	})
	require.NoError(t, err)
	require.NotEmpty(t, byProvider.Locks)
	for _, lock := range byProvider.Locks {
		require.Equal(t, first.Provider, lock.Provider)
	}
}

func TestAssignmentCollateralLocksMoveAcrossRepairLifecycle(t *testing.T) {
	setup := setupAssignmentCollateralLockRepair(t)
	queryServer := keeper.NewQueryServerImpl(setup.f.keeper)
	oldProvider := setup.deal.Mode2Slots[0].Provider

	active, err := queryServer.GetAssignmentCollateralLock(setup.ctx, &types.QueryGetAssignmentCollateralLockRequest{
		Provider: oldProvider,
		DealId:   setup.deal.Id,
		Slot:     0,
	})
	require.NoError(t, err)
	require.Equal(t, types.AssignmentCollateralLockRole_ASSIGNMENT_COLLATERAL_LOCK_ROLE_ACTIVE, active.Lock.Role)

	_, err = setup.msgServer.StartSlotRepair(setup.ctx, &types.MsgStartSlotRepair{
		Creator:         setup.owner,
		DealId:          setup.deal.Id,
		Slot:            0,
		PendingProvider: setup.candidate,
	})
	require.NoError(t, err)

	_, err = queryServer.GetAssignmentCollateralLock(setup.ctx, &types.QueryGetAssignmentCollateralLockRequest{
		Provider: oldProvider,
		DealId:   setup.deal.Id,
		Slot:     0,
	})
	require.Equal(t, codes.NotFound, status.Code(err), fmt.Sprintf("unexpected old-provider lock error: %v", err))

	repairing, err := setup.f.keeper.Deals.Get(setup.ctx, setup.deal.Id)
	require.NoError(t, err)
	pendingSlot := repairing.Mode2Slots[0]
	pending, err := queryServer.GetAssignmentCollateralLock(setup.ctx, &types.QueryGetAssignmentCollateralLockRequest{
		Provider: setup.candidate,
		DealId:   setup.deal.Id,
		Slot:     0,
	})
	require.NoError(t, err)
	require.Equal(t, setup.candidate, pending.Lock.Provider)
	require.Equal(t, types.AssignmentCollateralLockRole_ASSIGNMENT_COLLATERAL_LOCK_ROLE_PENDING_REPAIR, pending.Lock.Role)
	require.Equal(t, "slot_repair_pending", pending.Lock.Reason)
	require.Equal(t, pendingSlot.RepairTargetGen, pending.Lock.Generation)

	markMode2RepairReadyForTest(t, setup.f, setup.ctx, setup.deal.Id, 0, pendingSlot.RepairTargetGen)
	_, err = setup.msgServer.CompleteSlotRepair(setup.ctx, &types.MsgCompleteSlotRepair{
		Creator: setup.candidate,
		DealId:  setup.deal.Id,
		Slot:    0,
	})
	require.NoError(t, err)

	promotedDeal, err := setup.f.keeper.Deals.Get(setup.ctx, setup.deal.Id)
	require.NoError(t, err)
	promoted, err := queryServer.GetAssignmentCollateralLock(setup.ctx, &types.QueryGetAssignmentCollateralLockRequest{
		Provider: setup.candidate,
		DealId:   setup.deal.Id,
		Slot:     0,
	})
	require.NoError(t, err)
	require.Equal(t, setup.candidate, promoted.Lock.Provider)
	require.Equal(t, types.AssignmentCollateralLockRole_ASSIGNMENT_COLLATERAL_LOCK_ROLE_ACTIVE, promoted.Lock.Role)
	require.Equal(t, "slot_active", promoted.Lock.Reason)
	require.Equal(t, promotedDeal.CurrentGen, promoted.Lock.Generation)
	require.Equal(t, promotedDeal.Mode2Slots[0].Provider, promoted.Lock.Provider)
	require.Empty(t, promotedDeal.Mode2Slots[0].PendingProvider)
}

func setupAssignmentCollateralLockRepair(t *testing.T) manualSlotRepairSetup {
	t.Helper()

	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(5)

	require.NoError(t, f.keeper.Params.Set(ctx, collateralPolicyParams(0, 25)))
	providers := make([]string, 0, 20)
	for i := 0; i < 20; i++ {
		providers = append(providers, makePolicyTestAddr(t, f, byte(i+1)))
	}
	registerPolicyTestProviders(t, f, ctx, providers...)
	for _, provider := range providers {
		setProviderBondForTest(t, f, ctx, provider, 100)
	}

	owner := makePolicyTestAddr(t, f, 0xEE)
	res, err := msgServer.CreateDeal(ctx, &types.MsgCreateDeal{
		Creator:             owner,
		DurationBlocks:      1000,
		ServiceHint:         "General:rs=8+4",
		MaxMonthlySpend:     math.NewInt(500_000),
		InitialEscrowAmount: math.NewInt(1_000_000),
	})
	require.NoError(t, err)

	deal, err := f.keeper.Deals.Get(ctx, res.DealId)
	require.NoError(t, err)
	require.Len(t, deal.Mode2Slots, int(types.DealBaseReplication))
	require.NotEqual(t, deal.Mode2Slots[0].Provider, deal.Mode2Slots[1].Provider)

	return manualSlotRepairSetup{
		f:         f,
		msgServer: msgServer,
		ctx:       ctx,
		deal:      deal,
		owner:     owner,
		candidate: deal.Mode2Slots[1].Provider,
	}
}

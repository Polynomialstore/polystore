package keeper_test

import (
	"fmt"
	"testing"

	"cosmossdk.io/collections"
	"cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	"github.com/stretchr/testify/require"

	"polystorechain/x/polystorechain/keeper"
	"polystorechain/x/polystorechain/types"
)

func TestProtocolRepairSession_PendingProviderOnly_AndBudgetFundsFees(t *testing.T) {
	bank := newTrackingBankKeeper()
	f := initFixtureWithBankKeeper(t, bank)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(5)
	p := types.DefaultParams()
	p.StoragePrice = math.LegacyNewDec(0)
	p.BaseRetrievalFee = sdk.NewInt64Coin(sdk.DefaultBondDenom, 1)
	p.RetrievalPricePerBlob = sdk.NewInt64Coin(sdk.DefaultBondDenom, 2)
	require.NoError(t, f.keeper.Params.Set(ctx, p))

	// Register enough providers for Mode2 rs=8+4 placement.
	for i := 0; i < 20; i++ {
		addrBz := make([]byte, 20)
		copy(addrBz, []byte(fmt.Sprintf("provider_proto_%02d", i)))
		addr, _ := f.addressCodec.BytesToString(addrBz)
		_, err := msgServer.RegisterProvider(ctx, &types.MsgRegisterProvider{
			Creator:      addr,
			Capabilities: "General",
			TotalStorage: 100000000000,
			Endpoints:    testProviderEndpoints,
		})
		require.NoError(t, err)
	}

	userBz := make([]byte, 20)
	copy(userBz, []byte("user_proto_repair____"))
	user, _ := f.addressCodec.BytesToString(userBz)

	resDeal, err := msgServer.CreateDeal(ctx, &types.MsgCreateDeal{
		Creator:             user,
		DurationBlocks:      100,
		ServiceHint:         "General:rs=8+4",
		MaxMonthlySpend:     math.NewInt(0),
		InitialEscrowAmount: math.NewInt(0),
	})
	require.NoError(t, err)

	_, err = msgServer.UpdateDealContent(ctx, &types.MsgUpdateDealContent{
		Creator:     user,
		DealId:      resDeal.DealId,
		Cid:         validManifestCid,
		Size_:       1,
		TotalMdus:   3,
		WitnessMdus: 1,
	})
	require.NoError(t, err)

	deal, err := f.keeper.Deals.Get(ctx, resDeal.DealId)
	require.NoError(t, err)
	require.Equal(t, uint32(2), deal.RedundancyMode)
	require.NotEmpty(t, deal.Mode2Slots)

	active := deal.Mode2Slots[0].Provider
	pending := deal.Mode2Slots[1].Provider
	require.NotEqual(t, active, pending)

	// Force slot 0 into REPAIRING with a known pending provider.
	entry := deal.Mode2Slots[0]
	entry.Status = types.SlotStatus_SLOT_STATUS_REPAIRING
	entry.PendingProvider = pending
	deal.Mode2Slots[0] = entry
	require.NoError(t, f.keeper.Deals.Set(ctx, deal.Id, deal))

	// Fund the protocol budget module for fees.
	require.NoError(t, bank.MintCoins(ctx, types.ProtocolBudgetModuleName, sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 1000))))

	// Pending provider opens a protocol REPAIR session that targets the active slot provider.
	resOpen, err := msgServer.OpenProtocolRetrievalSession(ctx, &types.MsgOpenProtocolRetrievalSession{
		Creator:        pending,
		Purpose:        types.RetrievalSessionPurpose_RETRIEVAL_SESSION_PURPOSE_PROTOCOL_REPAIR,
		DealId:         deal.Id,
		Provider:       active,
		ManifestRoot:   mustDecodeHexBytes(t, validManifestCid),
		StartMduIndex:  1,
		StartBlobIndex: 0, // slot 0
		BlobCount:      1,
		Nonce:          1,
		ExpiresAt:      0,
		MaxTotalFee:    math.NewInt(0),
		Auth: &types.MsgOpenProtocolRetrievalSession_Repair{
			Repair: &types.RepairAuth{Slot: 0},
		},
	})
	require.NoError(t, err)
	require.Len(t, resOpen.SessionId, 32)

	// Fees: base=1 (burned), variable=2; funded by protocol budget.
	require.Equal(t, "997stake", bank.moduleBalances[types.ProtocolBudgetModuleName].String())
	require.Equal(t, "2stake", bank.moduleBalances[types.ModuleName].String())

	sess, err := f.keeper.RetrievalSessions.Get(ctx, resOpen.SessionId)
	require.NoError(t, err)
	require.Equal(t, types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_PROTOCOL, sess.Funding)
	require.Equal(t, types.RetrievalSessionPurpose_RETRIEVAL_SESSION_PURPOSE_PROTOCOL_REPAIR, sess.Purpose)
	require.Equal(t, authtypes.NewModuleAddress(types.ProtocolBudgetModuleName).String(), sess.Payer)

	// Non-pending providers cannot open repair sessions.
	_, err = msgServer.OpenProtocolRetrievalSession(ctx, &types.MsgOpenProtocolRetrievalSession{
		Creator:        active,
		Purpose:        types.RetrievalSessionPurpose_RETRIEVAL_SESSION_PURPOSE_PROTOCOL_REPAIR,
		DealId:         deal.Id,
		Provider:       active,
		ManifestRoot:   mustDecodeHexBytes(t, validManifestCid),
		StartMduIndex:  1,
		StartBlobIndex: 0,
		BlobCount:      1,
		Nonce:          2,
		ExpiresAt:      0,
		MaxTotalFee:    math.NewInt(0),
		Auth: &types.MsgOpenProtocolRetrievalSession_Repair{
			Repair: &types.RepairAuth{Slot: 0},
		},
	})
	require.Error(t, err)
}

func TestProtocolAuditSession_RequiresStoredTask(t *testing.T) {
	bank := newTrackingBankKeeper()
	f := initFixtureWithBankKeeper(t, bank)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(5)
	p := types.DefaultParams()
	p.StoragePrice = math.LegacyNewDec(0)
	p.BaseRetrievalFee = sdk.NewInt64Coin(sdk.DefaultBondDenom, 1)
	p.RetrievalPricePerBlob = sdk.NewInt64Coin(sdk.DefaultBondDenom, 1)
	require.NoError(t, f.keeper.Params.Set(ctx, p))

	// Register providers.
	for i := 0; i < 5; i++ {
		addrBz := make([]byte, 20)
		copy(addrBz, []byte(fmt.Sprintf("provider_audit_%02d", i)))
		addr, _ := f.addressCodec.BytesToString(addrBz)
		_, err := msgServer.RegisterProvider(ctx, &types.MsgRegisterProvider{
			Creator:      addr,
			Capabilities: "General",
			TotalStorage: 100000000000,
			Endpoints:    testProviderEndpoints,
		})
		require.NoError(t, err)
	}

	userBz := make([]byte, 20)
	copy(userBz, []byte("user_proto_audit_____"))
	user, _ := f.addressCodec.BytesToString(userBz)

	resDeal, err := msgServer.CreateDeal(ctx, &types.MsgCreateDeal{
		Creator:             user,
		DurationBlocks:      100,
		ServiceHint:         "General:rs=2+1",
		MaxMonthlySpend:     math.NewInt(0),
		InitialEscrowAmount: math.NewInt(0),
	})
	require.NoError(t, err)

	_, err = msgServer.UpdateDealContent(ctx, &types.MsgUpdateDealContent{
		Creator:     user,
		DealId:      resDeal.DealId,
		Cid:         validManifestCid,
		Size_:       1,
		TotalMdus:   2,
		WitnessMdus: 0,
	})
	require.NoError(t, err)

	deal, err := f.keeper.Deals.Get(ctx, resDeal.DealId)
	require.NoError(t, err)
	serving := deal.Providers[0]

	assigneeBz := make([]byte, 20)
	copy(assigneeBz, []byte("auditor_assignee____"))
	assignee, _ := f.addressCodec.BytesToString(assigneeBz)
	_, err = msgServer.RegisterProvider(ctx, &types.MsgRegisterProvider{
		Creator:      assignee,
		Capabilities: "General",
		TotalStorage: 100000000000,
		Endpoints:    testProviderEndpoints,
	})
	require.NoError(t, err)

	epochID := uint64(1)
	taskID := uint64(7)
	task := types.AuditTask{
		EpochId:        epochID,
		TaskId:         taskID,
		DealId:         deal.Id,
		Assignee:       assignee,
		Provider:       serving,
		ManifestRoot:   mustDecodeHexBytes(t, validManifestCid),
		StartMduIndex:  1,
		StartBlobIndex: 0,
		BlobCount:      1,
		ExpiresAt:      0, // default to deal end_block
	}
	require.NoError(t, f.keeper.AuditTasks.Set(ctx, collections.Join(epochID, taskID), task))

	require.NoError(t, bank.MintCoins(ctx, types.ProtocolBudgetModuleName, sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 1000))))

	// Non-assignee fails.
	_, err = msgServer.OpenProtocolRetrievalSession(ctx, &types.MsgOpenProtocolRetrievalSession{
		Creator:        serving,
		Purpose:        types.RetrievalSessionPurpose_RETRIEVAL_SESSION_PURPOSE_PROTOCOL_AUDIT,
		DealId:         deal.Id,
		Provider:       serving,
		ManifestRoot:   mustDecodeHexBytes(t, validManifestCid),
		StartMduIndex:  1,
		StartBlobIndex: 0,
		BlobCount:      1,
		Nonce:          1,
		ExpiresAt:      0,
		MaxTotalFee:    math.NewInt(0),
		Auth: &types.MsgOpenProtocolRetrievalSession_AuditTask{
			AuditTask: &types.AuditTaskRef{EpochId: epochID, TaskId: taskID},
		},
	})
	require.Error(t, err)

	// Assignee succeeds.
	_, err = msgServer.OpenProtocolRetrievalSession(ctx, &types.MsgOpenProtocolRetrievalSession{
		Creator:        assignee,
		Purpose:        types.RetrievalSessionPurpose_RETRIEVAL_SESSION_PURPOSE_PROTOCOL_AUDIT,
		DealId:         deal.Id,
		Provider:       serving,
		ManifestRoot:   mustDecodeHexBytes(t, validManifestCid),
		StartMduIndex:  1,
		StartBlobIndex: 0,
		BlobCount:      1,
		Nonce:          2,
		ExpiresAt:      0,
		MaxTotalFee:    math.NewInt(0),
		Auth: &types.MsgOpenProtocolRetrievalSession_AuditTask{
			AuditTask: &types.AuditTaskRef{EpochId: epochID, TaskId: taskID},
		},
	})
	require.NoError(t, err)

	// Tasks are one-time: they are consumed on successful session open.
	_, err = f.keeper.AuditTasks.Get(ctx, collections.Join(epochID, taskID))
	require.Error(t, err)
}

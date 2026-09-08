package keeper_test

import (
	"bytes"
	"fmt"
	"testing"

	"cosmossdk.io/collections"
	cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"
	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/keeper"
	"polystorechain/x/polystorechain/types"
)

func TestFrozenStorageAuditSnapshotQuotaAndMutation(t *testing.T) {
	f := initFixture(t)
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(1).WithHeaderHash(bytes.Repeat([]byte{9}, 32)).WithConsensusParams(cmtproto.ConsensusParams{Block: &cmtproto.BlockParams{MaxGas: types.MaxRetrievalV2BlockGas, MaxBytes: types.MaxRetrievalV2BlockBytes}})
	provider := sdk.AccAddress(bytes.Repeat([]byte{1}, 20)).String()
	d := types.Deal{Id: 7, ManifestRoot: bytes.Repeat([]byte{2}, 32), TotalMdus: 5, WitnessMdus: 1, StartBlock: 0, EndBlock: 1000, Providers: []string{provider}, CurrentGen: 3}
	require.NoError(t, f.keeper.Deals.Set(ctx, d.Id, d))
	p := types.DefaultParams()
	p.RetrievalV2ActivationHeight = 1
	p.EpochLenBlocks = 10
	p.QuotaMinBlobs = 132
	p.QuotaMaxBlobs = 132
	require.NoError(t, f.keeper.Params.Set(ctx, p))
	require.NoError(t, f.keeper.BeginBlock(ctx))
	audits, err := f.keeper.StorageAuditsForEpoch(ctx, 1)
	require.NoError(t, err)
	require.Len(t, audits, 1)
	require.EqualValues(t, 132, audits[0].SampleCount)
	c, err := types.StorageAuditContext(audits[0], 10)
	require.NoError(t, err)
	expected, err := c.Challenges(bytes.Repeat([]byte{9}, 32))
	require.NoError(t, err)
	seen := map[uint64]bool{}
	for _, v := range expected {
		require.False(t, seen[v.PopulationIndex])
		seen[v.PopulationIndex] = true
	}
	d.ManifestRoot = bytes.Repeat([]byte{3}, 32)
	d.CurrentGen++
	require.NoError(t, f.keeper.Deals.Set(ctx, d.Id, d))
	p.QuotaMinBlobs = 1
	p.QuotaMaxBlobs = 1
	require.NoError(t, f.keeper.SetParams(ctx, p))
	got, err := f.keeper.StorageAuditsForEpoch(ctx, 1)
	require.NoError(t, err)
	require.Equal(t, audits, got)
	p.EpochLenBlocks = 11
	require.ErrorContains(t, f.keeper.SetParams(ctx, p), "epoch length")
}

func TestFrozenStorageAuditQuotaPopulationAndDisabled(t *testing.T) {
	for _, tc := range []struct {
		name         string
		users, quota uint64
		want         uint64
	}{{"empty", 0, 132, 0}, {"one", 1, 132, 1}, {"below", 131, 132, 131}, {"equal", 132, 132, 132}, {"above", 133, 132, 132}, {"disabled", 133, 0, 0}} {
		t.Run(tc.name, func(t *testing.T) {
			f := initFixture(t)
			ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(1).WithHeaderHash(bytes.Repeat([]byte{9}, 32)).WithConsensusParams(cmtproto.ConsensusParams{Block: &cmtproto.BlockParams{MaxGas: types.MaxRetrievalV2BlockGas, MaxBytes: types.MaxRetrievalV2BlockBytes}})
			provider := sdk.AccAddress(bytes.Repeat([]byte{1}, 20)).String()
			d := types.Deal{Id: 1, ManifestRoot: bytes.Repeat([]byte{2}, 32), TotalMdus: 2 + tc.users, WitnessMdus: 1, EndBlock: 1000, RedundancyMode: 2, Mode2Profile: &types.StripeReplicaProfile{K: 64, M: 1}, Mode2Slots: []*types.DealSlot{{Slot: 0, Provider: provider, Status: types.SlotStatus_SLOT_STATUS_ACTIVE}}}
			require.NoError(t, f.keeper.Deals.Set(ctx, d.Id, d))
			p := types.DefaultParams()
			p.RetrievalV2ActivationHeight = 1
			p.QuotaMinBlobs = tc.quota
			p.QuotaMaxBlobs = tc.quota
			require.NoError(t, f.keeper.Params.Set(ctx, p))
			require.NoError(t, f.keeper.BeginBlock(ctx))
			audits, err := f.keeper.StorageAuditsForEpoch(ctx, 1)
			require.NoError(t, err)
			if tc.want == 0 {
				require.Empty(t, audits)
				return
			}
			require.Len(t, audits, 1)
			require.Equal(t, tc.want, audits[0].SampleCount)
		})
	}
}

func TestFrozenStorageAuditMissingAnchorAndEmptyWindowHaveNoFailure(t *testing.T) {
	for _, end := range []uint64{2, 1000} {
		t.Run(fmt.Sprint(end), func(t *testing.T) {
			f := initFixture(t)
			ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(1).WithConsensusParams(cmtproto.ConsensusParams{Block: &cmtproto.BlockParams{MaxGas: types.MaxRetrievalV2BlockGas, MaxBytes: types.MaxRetrievalV2BlockBytes}})
			provider := sdk.AccAddress(bytes.Repeat([]byte{1}, 20)).String()
			d := types.Deal{Id: 1, ManifestRoot: bytes.Repeat([]byte{2}, 32), TotalMdus: 3, WitnessMdus: 1, EndBlock: end, Providers: []string{provider}}
			require.NoError(t, f.keeper.Deals.Set(ctx, 1, d))
			p := types.DefaultParams()
			p.RetrievalV2ActivationHeight = 1
			p.EpochLenBlocks = 10
			p.QuotaMinBlobs = 1
			p.QuotaMaxBlobs = 1
			require.NoError(t, f.keeper.Params.Set(ctx, p))
			require.NoError(t, f.keeper.BeginBlock(ctx))
			audits, err := f.keeper.StorageAuditsForEpoch(ctx, 1)
			require.NoError(t, err)
			if end == 2 {
				require.Empty(t, audits)
			} else {
				require.Len(t, audits, 1)
			}
			// A later block hash must never replace the unavailable predetermined seed.
			require.NoError(t, f.keeper.BeginBlock(ctx.WithBlockHeight(2).WithHeaderHash(bytes.Repeat([]byte{8}, 32))))
			require.NoError(t, f.keeper.CheckMissedProofs(ctx.WithBlockHeight(10)))
			_, err = f.keeper.Mode1MissedEpochs.Get(ctx, collections.Join(uint64(1), provider))
			require.ErrorIs(t, err, collections.ErrNotFound)
			_, err = f.keeper.ProviderStorageRewards.Get(ctx, provider)
			require.ErrorIs(t, err, collections.ErrNotFound)
		})
	}
}

func TestFrozenStorageAuditNativeProofAndDuplicate(t *testing.T) {
	f, _, server, owner, created, _ := setupRetrievalExpiryDeal(t)
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(2)
	_, proof := commitValidMode2ContentAndProof(t, f, ctx, server, owner, created.DealId)
	d, err := f.keeper.Deals.Get(ctx, created.DealId)
	require.NoError(t, err)
	// The shared helper reserves an extra empty MDU. This fixture's committed
	// allocation contains exactly its one populated user MDU.
	d.TotalMdus = 3
	require.NoError(t, f.keeper.Deals.Set(ctx, d.Id, d))
	p := f.keeper.GetParams(ctx)
	p.RetrievalV2ActivationHeight = 11
	p.EpochLenBlocks = 10
	p.QuotaMinBlobs = 1
	p.QuotaMaxBlobs = 1
	require.NoError(t, f.keeper.Params.Set(ctx, p))
	seed := bytes.Repeat([]byte{9}, 32)
	ctx = ctx.WithBlockHeight(11).WithHeaderHash(seed).WithConsensusParams(cmtproto.ConsensusParams{Block: &cmtproto.BlockParams{MaxGas: types.MaxRetrievalV2BlockGas, MaxBytes: types.MaxRetrievalV2BlockBytes}})
	require.NoError(t, f.keeper.BeginBlock(ctx))
	audits, err := f.keeper.StorageAuditsForEpoch(ctx, 2)
	require.NoError(t, err)
	var audit types.FrozenStorageAudit
	for _, a := range audits {
		if a.Assignment.Provider == created.AssignedProviders[0] {
			audit = a
			break
		}
	}
	c, err := types.StorageAuditContext(audit, 10)
	require.NoError(t, err)
	challenge, err := c.Challenges(seed)
	require.NoError(t, err)
	require.Len(t, challenge, 1)
	proof.BlobIndex = challenge[0].LeafIndex
	proof.ZValue = challenge[0].Z[:]
	proof.KzgOpeningProof, proof.YValue, err = crypto_ffi.ComputeBlobProof(make([]byte, types.BlobSizeBytes), proof.ZValue)
	require.NoError(t, err)
	msg := &types.MsgProveLiveness{Creator: created.AssignedProviders[0], DealId: d.Id, EpochId: 2, ProofType: &types.MsgProveLiveness_SystemProof{SystemProof: &proof}}
	_, err = server.ProveLiveness(ctx, msg)
	require.ErrorContains(t, err, "response window")
	ctx = ctx.WithBlockHeight(12)
	bad := proof
	bad.ZValue = bytes.Repeat([]byte{1}, 32)
	badmsg := *msg
	badmsg.ProofType = &types.MsgProveLiveness_SystemProof{SystemProof: &bad}
	_, err = server.ProveLiveness(ctx, &badmsg)
	require.ErrorContains(t, err, "exact frozen")
	// The frozen root remains authoritative after a live-root update.
	d.ManifestRoot = bytes.Repeat([]byte{0x99}, 32)
	d.CurrentGen++
	require.NoError(t, f.keeper.Deals.Set(ctx, d.Id, d))
	response, err := server.ProveLiveness(ctx, msg)
	require.NoError(t, err)
	require.True(t, response.Success)
	audits, err = f.keeper.StorageAuditsForEpoch(ctx, 2)
	require.NoError(t, err)
	accepted := uint64(0)
	for _, a := range audits {
		accepted += a.AcceptedCount
	}
	require.EqualValues(t, 1, accepted)
	rewards, err := f.keeper.ProviderStorageRewards.Get(ctx, msg.Creator)
	require.NoError(t, err)
	_, err = server.ProveLiveness(ctx, msg)
	require.ErrorContains(t, err, "duplicate")
	after, err := f.keeper.ProviderStorageRewards.Get(ctx, msg.Creator)
	require.NoError(t, err)
	require.Equal(t, rewards, after)
	query := keeper.NewQueryServerImpl(f.keeper)
	views, err := query.ListStorageAuditsByProvider(ctx, &types.QueryListStorageAuditsByProviderRequest{Provider: msg.Creator})
	require.NoError(t, err)
	require.Len(t, views.Audits, 1)
	require.Equal(t, c.Root[:], views.Audits[0].Audit.Assignment.ManifestRoot)
	reply, err := query.GetStorageAuditChallenge(ctx, &types.QueryGetStorageAuditChallengeRequest{EpochId: 2, DealId: d.Id, Slot: c.Slot, Provider: msg.Creator})
	require.NoError(t, err)
	require.Len(t, reply.Challenges, 1)
	require.Equal(t, proof.ZValue, reply.Challenges[0].Z)
}

func TestFrozenStorageAuditRepairProofCompletesOnlyPendingReadiness(t *testing.T) {
	f, _, server, owner, created, _ := setupRetrievalExpiryDeal(t)
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(2)
	_, proof := commitValidMode2ContentAndProof(t, f, ctx, server, owner, created.DealId)
	d, err := f.keeper.Deals.Get(ctx, created.DealId)
	require.NoError(t, err)
	d.TotalMdus = 3
	pending := created.AssignedProviders[1]
	d.Mode2Slots[0].Status = types.SlotStatus_SLOT_STATUS_REPAIRING
	d.Mode2Slots[0].PendingProvider = pending
	d.Mode2Slots[0].RepairTargetGen = d.CurrentGen
	require.NoError(t, f.keeper.Deals.Set(ctx, d.Id, d))
	p := f.keeper.GetParams(ctx)
	p.RetrievalV2ActivationHeight = 11
	p.EpochLenBlocks = 10
	p.QuotaMinBlobs = 1
	p.QuotaMaxBlobs = 1
	require.NoError(t, f.keeper.Params.Set(ctx, p))
	seed := bytes.Repeat([]byte{9}, 32)
	ctx = ctx.WithBlockHeight(11).WithHeaderHash(seed).WithConsensusParams(cmtproto.ConsensusParams{Block: &cmtproto.BlockParams{MaxGas: types.MaxRetrievalV2BlockGas, MaxBytes: types.MaxRetrievalV2BlockBytes}})
	legacyKey := collections.Join(d.Id, uint32(0))
	require.NoError(t, f.keeper.Mode2RepairReadiness.Set(ctx, legacyKey, d.CurrentGen+1))
	require.NoError(t, f.keeper.Mode2RepairReadinessProofs.Set(ctx, legacyKey, 999))
	require.NoError(t, f.keeper.BeginBlock(ctx))
	_, err = f.keeper.Mode2RepairReadiness.Get(ctx, legacyKey)
	require.ErrorIs(t, err, collections.ErrNotFound)
	_, err = f.keeper.Mode2RepairReadinessProofs.Get(ctx, legacyKey)
	require.ErrorIs(t, err, collections.ErrNotFound)
	audits, err := f.keeper.StorageAuditsForEpoch(ctx, 2)
	require.NoError(t, err)
	var audit types.FrozenStorageAudit
	for _, a := range audits {
		if a.Assignment.Snapshot.Slot == 0 {
			audit = a
		}
	}
	require.EqualValues(t, 3, audit.Assignment.Kind)
	require.Equal(t, pending, audit.Assignment.Provider)
	c, err := types.StorageAuditContext(audit, 10)
	require.NoError(t, err)
	challenge, err := c.Challenges(seed)
	require.NoError(t, err)
	proof.BlobIndex = challenge[0].LeafIndex
	proof.ZValue = challenge[0].Z[:]
	proof.KzgOpeningProof, proof.YValue, err = crypto_ffi.ComputeBlobProof(make([]byte, types.BlobSizeBytes), proof.ZValue)
	require.NoError(t, err)
	ctx = ctx.WithBlockHeight(12)
	msg := &types.MsgProveLiveness{Creator: pending, DealId: d.Id, EpochId: 2, ProofType: &types.MsgProveLiveness_SystemProof{SystemProof: &proof}}
	_, err = server.CompleteSlotRepair(ctx, &types.MsgCompleteSlotRepair{Creator: owner, DealId: d.Id, Slot: 0})
	require.ErrorContains(t, err, "not ready")
	beforeHealth, beforeHealthErr := f.keeper.ProviderHealthStates.Get(ctx, pending)
	response, err := server.ProveLiveness(ctx, msg)
	require.NoError(t, err)
	afterHealth, afterHealthErr := f.keeper.ProviderHealthStates.Get(ctx, pending)
	require.Equal(t, beforeHealthErr, afterHealthErr)
	require.Equal(t, beforeHealth, afterHealth)
	require.Equal(t, "0", response.RewardAmount)
	_, err = f.keeper.ProviderStorageRewards.Get(ctx, pending)
	require.ErrorIs(t, err, collections.ErrNotFound)
	after, err := f.keeper.StorageAuditsForEpoch(ctx, 2)
	require.NoError(t, err)
	for _, a := range after {
		if a.Assignment.Kind == 2 {
			require.Zero(t, a.AcceptedCount)
		}
	}
	marker, err := f.keeper.Mode2RepairReadiness.Get(ctx, collections.Join(d.Id, uint32(0)))
	require.NoError(t, err)
	require.Equal(t, d.CurrentGen+1, marker)
	_, err = server.CompleteSlotRepair(ctx, &types.MsgCompleteSlotRepair{Creator: owner, DealId: d.Id, Slot: 0})
	require.NoError(t, err)
	current, err := f.keeper.Deals.Get(ctx, d.Id)
	require.NoError(t, err)
	require.Equal(t, pending, current.Mode2Slots[0].Provider)
	require.Equal(t, types.SlotStatus_SLOT_STATUS_ACTIVE, current.Mode2Slots[0].Status)
	_, err = f.keeper.Mode2RepairReadiness.Get(ctx, collections.Join(d.Id, uint32(0)))
	require.ErrorIs(t, err, collections.ErrNotFound)
	retained, err := f.keeper.StorageAuditsForEpoch(ctx, 2)
	require.NoError(t, err)
	require.Equal(t, after, retained)
}

func TestFrozenStorageAuditOldProviderFailureDoesNotPunishPendingReplacement(t *testing.T) {
	f, _, server, owner, created, _ := setupRetrievalExpiryDeal(t)
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(2)
	_, _ = commitValidMode2ContentAndProof(t, f, ctx, server, owner, created.DealId)
	p := f.keeper.GetParams(ctx)
	p.RetrievalV2ActivationHeight = 11
	p.EpochLenBlocks = 10
	p.QuotaMinBlobs = 1
	p.QuotaMaxBlobs = 1
	p.EvictAfterMissedEpochs = 99
	require.NoError(t, f.keeper.Params.Set(ctx, p))
	ctx = ctx.WithBlockHeight(11).WithHeaderHash(bytes.Repeat([]byte{9}, 32)).WithConsensusParams(cmtproto.ConsensusParams{Block: &cmtproto.BlockParams{MaxGas: types.MaxRetrievalV2BlockGas, MaxBytes: types.MaxRetrievalV2BlockBytes}})
	require.NoError(t, f.keeper.BeginBlock(ctx))
	pending := ""
	require.NoError(t, f.keeper.Providers.Walk(ctx, nil, func(addr string, _ types.Provider) (bool, error) {
		for _, p := range created.AssignedProviders {
			if p == addr {
				return false, nil
			}
		}
		pending = addr
		return true, nil
	}))
	require.NotEmpty(t, pending)
	_, err := server.StartSlotRepair(ctx.WithBlockHeight(12), &types.MsgStartSlotRepair{Creator: owner, DealId: created.DealId, Slot: 0, PendingProvider: pending})
	require.NoError(t, err)
	prior, priorErr := f.keeper.ProviderHealthStates.Get(ctx, pending)
	require.ErrorIs(t, priorErr, collections.ErrNotFound)
	require.NoError(t, f.keeper.CheckMissedProofs(ctx.WithBlockHeight(20)))
	after, afterErr := f.keeper.ProviderHealthStates.Get(ctx, pending)
	require.ErrorIs(t, afterErr, collections.ErrNotFound)
	require.Equal(t, prior, after)
	d, err := f.keeper.Deals.Get(ctx, created.DealId)
	require.NoError(t, err)
	require.Equal(t, pending, d.Mode2Slots[0].PendingProvider)
	state, err := f.keeper.SlotHealthStates.Get(ctx, collections.Join(created.DealId, uint32(0)))
	require.NoError(t, err)
	require.Equal(t, types.SlotHealthStatus_SLOT_HEALTH_STATUS_REPAIRING, state.Status)
	old, err := f.keeper.ProviderHealthStates.Get(ctx, created.AssignedProviders[0])
	require.NoError(t, err)
	require.Positive(t, old.SoftFaultCount)
	// EndBlock retries cannot count the same frozen shortfall twice.
	require.NoError(t, f.keeper.CheckMissedProofs(ctx.WithBlockHeight(20)))
	same, err := f.keeper.ProviderHealthStates.Get(ctx, created.AssignedProviders[0])
	require.NoError(t, err)
	require.Equal(t, old, same)
}

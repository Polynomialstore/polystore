package keeper

import (
	"bytes"
	"fmt"
	"testing"

	"cosmossdk.io/collections"
	"cosmossdk.io/log"
	"cosmossdk.io/store"
	"cosmossdk.io/store/metrics"
	storetypes "cosmossdk.io/store/types"
	cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"
	dbm "github.com/cosmos/cosmos-db"
	"github.com/cosmos/cosmos-sdk/codec"
	addresscodec "github.com/cosmos/cosmos-sdk/codec/address"
	codectypes "github.com/cosmos/cosmos-sdk/codec/types"
	"github.com/cosmos/cosmos-sdk/runtime"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"
	"polystorechain/pkg/retrievalchallenge"
	"polystorechain/x/polystorechain/types"
)

func storageStateFixture(t testing.TB) (Keeper, sdk.Context, storetypes.CommitMultiStore, dbm.DB, *storetypes.KVStoreKey) {
	t.Helper()
	db := dbm.NewMemDB()
	key := storetypes.NewKVStoreKey(types.StoreKey)
	cms := store.NewCommitMultiStore(db, log.NewNopLogger(), metrics.NewNoOpMetrics())
	cms.MountStoreWithDB(key, storetypes.StoreTypeIAVL, db)
	require.NoError(t, cms.LoadLatestVersion())
	ctx := sdk.NewContext(cms, cmtproto.Header{ChainID: "storage-audit-state", Height: 1}, false, log.NewNopLogger()).WithHeaderHash(bytes.Repeat([]byte{7}, 32)).WithConsensusParams(cmtproto.ConsensusParams{Block: &cmtproto.BlockParams{MaxGas: types.MaxRetrievalV2BlockGas, MaxBytes: types.MaxRetrievalV2BlockBytes}})
	k := newStorageStateKeeper(key)
	p := types.DefaultParams()
	p.RetrievalV2ActivationHeight = 1
	p.EpochLenBlocks = 2
	p.QuotaMinBlobs = 132
	p.QuotaMaxBlobs = 132
	require.NoError(t, k.Params.Set(ctx, p))
	return k, ctx, cms, db, key
}
func newStorageStateKeeper(key *storetypes.KVStoreKey) Keeper {
	return NewKeeper(runtime.NewKVStoreService(key), codec.NewProtoCodec(codectypes.NewInterfaceRegistry()), addresscodec.NewBech32Codec(sdk.GetConfig().GetBech32AccountAddrPrefix()), bytes.Repeat([]byte{9}, 20), nil, nil)
}
func storageStateDeal(id uint64) types.Deal {
	return types.Deal{Id: id, Providers: []string{sdk.AccAddress(bytes.Repeat([]byte{byte(id + 1)}, 20)).String()}, ManifestRoot: bytes.Repeat([]byte{4}, 32), TotalMdus: 5, WitnessMdus: 1, EndBlock: 10000, CurrentGen: 1}
}

func TestStorageAuditBoundedMigrationAndAssignmentMutation(t *testing.T) {
	t.Run("legacy records count even when expired", func(t *testing.T) {
		k, ctx, _, _, _ := storageStateFixture(t)
		for i := uint64(0); i < 65; i++ {
			d := storageStateDeal(i)
			d.EndBlock = 1
			require.NoError(t, k.Deals.Set(ctx, i, d))
		}
		require.ErrorContains(t, k.processRetrievalChallengeState(ctx), "at most 64 legacy deals")
		_, err := k.RetrievalV2ActivatedHeight.Get(ctx)
		require.ErrorIs(t, err, collections.ErrNotFound)
		inventory, err := k.storageAssignmentInventory(ctx)
		require.NoError(t, err)
		require.Empty(t, inventory)
	})
	k, ctx, _, _, _ := storageStateFixture(t)
	for i := uint64(0); i < 64; i++ {
		require.NoError(t, k.Deals.Set(ctx, i, storageStateDeal(i)))
	}
	require.NoError(t, k.processRetrievalChallengeState(ctx))
	require.ErrorContains(t, k.setDealWithAssignmentCollateralLocks(ctx, 64, storageStateDeal(64)), "exceeds 64")
	_, err := k.Deals.Get(ctx, 64)
	require.ErrorIs(t, err, collections.ErrNotFound)
	original, err := k.StorageAuditsForEpoch(ctx, 1)
	require.NoError(t, err)
	require.Len(t, original, 64)
	d := storageStateDeal(0)
	d.CurrentGen++
	d.ManifestRoot = bytes.Repeat([]byte{5}, 32)
	d.Providers = []string{sdk.AccAddress(bytes.Repeat([]byte{99}, 20)).String()}
	require.NoError(t, k.setDealWithAssignmentCollateralLocks(ctx, 0, d))
	inventory, err := k.storageAssignmentInventory(ctx)
	require.NoError(t, err)
	require.Len(t, inventory, 64)
	still, err := k.StorageAuditsForEpoch(ctx, 1)
	require.NoError(t, err)
	require.Equal(t, original, still)
	require.NoError(t, k.processRetrievalChallengeState(ctx.WithBlockHeight(3)))
	next, err := k.StorageAuditsForEpoch(ctx, 2)
	require.NoError(t, err)
	require.EqualValues(t, 2, next[0].Assignment.Snapshot.Generation)
	require.Equal(t, d.ManifestRoot, next[0].Assignment.ManifestRoot)
}

func TestStorageAuditActivationClearsOnlyBoundedLegacySlots(t *testing.T) {
	for _, expired := range []bool{false, true} {
		t.Run(fmt.Sprintf("expired=%v", expired), func(t *testing.T) {
			k, ctx, _, _, _ := storageStateFixture(t)
			for i := uint64(0); i < 64; i++ {
				d := storageStateDeal(i)
				d.RedundancyMode = 2
				d.TotalMdus = 134 // U=Q=132 for the bounded candidate profile.
				d.Mode2Profile = &types.StripeReplicaProfile{K: 64, M: 1}
				d.Mode2Slots = []*types.DealSlot{{Slot: 0, Provider: d.Providers[0], Status: types.SlotStatus_SLOT_STATUS_ACTIVE}}
				if expired {
					d.EndBlock = 1
				}
				require.NoError(t, k.Deals.Set(ctx, i, d))
				key := collections.Join(i, uint32(0))
				require.NoError(t, k.Mode2RepairReadiness.Set(ctx, key, 2))
				require.NoError(t, k.Mode2RepairReadinessProofs.Set(ctx, key, 999))
			}
			ctx = ctx.WithGasMeter(storetypes.NewGasMeter(uint64(types.MaxRetrievalV2BlockGas)))
			before := ctx.GasMeter().GasConsumed()
			require.NoError(t, k.processRetrievalChallengeState(ctx))
			used := ctx.GasMeter().GasConsumed() - before
			t.Logf("64 legacy slots activation gas: %d", used)
			require.Less(t, used, uint64(types.MaxRetrievalV2BlockGas))
			for i := uint64(0); i < 64; i++ {
				_, err := k.Mode2RepairReadiness.Get(ctx, collections.Join(i, uint32(0)))
				require.ErrorIs(t, err, collections.ErrNotFound)
				_, err = k.Mode2RepairReadinessProofs.Get(ctx, collections.Join(i, uint32(0)))
				require.ErrorIs(t, err, collections.ErrNotFound)
			}
		})
	}
	for _, slots := range []int{65, 257} {
		t.Run(fmt.Sprintf("reject-%d-slots", slots), func(t *testing.T) {
			k, ctx, _, _, _ := storageStateFixture(t)
			d := storageStateDeal(1)
			d.EndBlock = 1 // Closed history cannot bypass the activation work cap.
			d.Mode2Slots = make([]*types.DealSlot, slots)
			for i := range d.Mode2Slots {
				d.Mode2Slots[i] = &types.DealSlot{Slot: uint32(i)}
			}
			require.NoError(t, k.Deals.Set(ctx, d.Id, d))
			key := collections.Join(d.Id, uint32(0))
			require.NoError(t, k.Mode2RepairReadiness.Set(ctx, key, 2))
			require.Error(t, k.processRetrievalChallengeState(ctx))
			marker, err := k.Mode2RepairReadiness.Get(ctx, key)
			require.NoError(t, err)
			require.EqualValues(t, 2, marker)
			_, err = k.RetrievalV2ActivatedHeight.Get(ctx)
			require.ErrorIs(t, err, collections.ErrNotFound)
		})
	}
}

func TestStorageAuditQuotaChangesOnlyAtNextSnapshot(t *testing.T) {
	k, ctx, _, _, _ := storageStateFixture(t)
	require.NoError(t, k.Deals.Set(ctx, 0, storageStateDeal(0)))
	require.NoError(t, k.processRetrievalChallengeState(ctx))
	original, err := k.StorageAuditsForEpoch(ctx, 1)
	require.NoError(t, err)
	require.Len(t, original, 1)
	require.EqualValues(t, 132, original[0].SampleCount)
	p := k.GetParams(ctx)
	p.QuotaMinBlobs, p.QuotaMaxBlobs = 0, 0
	require.NoError(t, k.SetParams(ctx, p))
	frozen, err := k.StorageAuditsForEpoch(ctx, 1)
	require.NoError(t, err)
	require.Equal(t, original, frozen)
	require.NoError(t, k.processRetrievalChallengeState(ctx.WithBlockHeight(3)))
	empty, err := k.StorageAuditsForEpoch(ctx, 2)
	require.NoError(t, err)
	require.Empty(t, empty)
	p.QuotaMinBlobs, p.QuotaMaxBlobs = 132, 132
	require.NoError(t, k.SetParams(ctx.WithBlockHeight(4), p))
	empty, err = k.StorageAuditsForEpoch(ctx, 2)
	require.NoError(t, err)
	require.Empty(t, empty)
	require.NoError(t, k.processRetrievalChallengeState(ctx.WithBlockHeight(5)))
	next, err := k.StorageAuditsForEpoch(ctx, 3)
	require.NoError(t, err)
	require.Len(t, next, 1)
	require.EqualValues(t, 132, next[0].SampleCount)
}

func TestStorageAuditCommitRestartAndRetentionUnion(t *testing.T) {
	k, ctx, cms, db, key := storageStateFixture(t)
	for i := uint64(0); i < 64; i++ {
		require.NoError(t, k.Deals.Set(ctx, i, storageStateDeal(i)))
	}
	require.NoError(t, k.processRetrievalChallengeState(ctx))
	original, err := k.StorageAuditsForEpoch(ctx, 1)
	require.NoError(t, err)
	// Commit an actual IAVL store and construct an independent multistore/keeper.
	cms.Commit()
	reopened := store.NewCommitMultiStore(db, log.NewNopLogger(), metrics.NewNoOpMetrics())
	reopened.MountStoreWithDB(key, storetypes.StoreTypeIAVL, db)
	require.NoError(t, reopened.LoadLatestVersion())
	ctx = ctx.WithMultiStore(reopened)
	k = newStorageStateKeeper(key)
	restored, err := k.StorageAuditsForEpoch(ctx, 1)
	require.NoError(t, err)
	require.Equal(t, original, restored)
	c, err := types.StorageAuditContext(restored[0], 2)
	require.NoError(t, err)
	anchor, err := k.ChallengeAnchors.Get(ctx, 1)
	require.NoError(t, err)
	expected, err := c.Challenges(anchor.Seed)
	require.NoError(t, err)
	require.Len(t, expected, 132)
	anchor.SessionReferences = 1
	require.NoError(t, k.ChallengeAnchors.Set(ctx, 1, anchor))
	for epoch := uint64(2); epoch <= 4; epoch++ {
		height := int64(2*epoch - 1)
		for i := uint64(0); i < 64; i++ {
			d := storageStateDeal(i)
			d.CurrentGen = epoch
			require.NoError(t, k.setDealWithAssignmentCollateralLocks(ctx.WithBlockHeight(height-1), i, d))
		}
		require.NoError(t, k.processRetrievalChallengeState(ctx.WithBlockHeight(height)))
		refs := 0
		require.NoError(t, k.StorageAuditGenerationRefs.Walk(ctx, nil, func(_ collections.Pair[uint64, uint64], n uint64) (bool, error) {
			refs++
			require.EqualValues(t, 1, n)
			return false, nil
		}))
		require.Equal(t, 128, refs)
	}
	_, err = k.StorageAuditEpochs.Get(ctx, 1)
	require.ErrorIs(t, err, collections.ErrNotFound)
	kept, err := k.ChallengeAnchors.Get(ctx, 1)
	require.NoError(t, err)
	require.EqualValues(t, 0, kept.AuditReferences)
	require.EqualValues(t, 1, kept.SessionReferences)
	require.Equal(t, anchor.Seed, kept.Seed)
	_, err = k.ChallengeAnchors.Get(ctx, 3)
	require.ErrorIs(t, err, collections.ErrNotFound)
}

func TestStorageAuditOrganicCreditAndPendingSeparation(t *testing.T) {
	k, ctx, _, _, _ := storageStateFixture(t)
	d := storageStateDeal(0)
	d.RedundancyMode = 2
	d.Mode2Profile = &types.StripeReplicaProfile{K: 2, M: 1}
	pending := sdk.AccAddress(bytes.Repeat([]byte{5}, 20)).String()
	d.Mode2Slots = []*types.DealSlot{{Slot: 0, Provider: d.Providers[0], PendingProvider: pending, Status: types.SlotStatus_SLOT_STATUS_REPAIRING, RepairTargetGen: 1}}
	require.NoError(t, k.Deals.Set(ctx, 0, d))
	require.NoError(t, k.processRetrievalChallengeState(ctx))
	audits, err := k.StorageAuditsForEpoch(ctx, 1)
	require.NoError(t, err)
	require.Len(t, audits, 1)
	require.EqualValues(t, retrievalchallenge.Repair, audits[0].Assignment.Kind)
	stripe, err := stripeParamsForDeal(d)
	require.NoError(t, err)
	for _, provider := range []string{d.Providers[0], pending, sdk.AccAddress(bytes.Repeat([]byte{6}, 20)).String()} {
		require.NoError(t, k.recordCreditForProof(ctx, 1, d, stripe, provider, 2, 0))
	}
	after, err := k.StorageAuditsForEpoch(ctx, 1)
	require.NoError(t, err)
	require.Equal(t, audits, after)
	for _, collection := range []collections.Map[collections.Pair[collections.Pair[uint64, uint32], uint64], uint64]{k.Mode2EpochCredits, k.Mode2EpochSynthetic, k.Mode2EpochDeputyServed, k.Mode2EpochSlotServed} {
		require.NoError(t, collection.Walk(ctx, nil, func(_ collections.Pair[collections.Pair[uint64, uint32], uint64], _ uint64) (bool, error) {
			t.Fatal("organic credit created")
			return true, nil
		}))
	}
	_, err = k.Mode2RepairReadiness.Get(ctx, collections.Join(uint64(0), uint32(0)))
	require.ErrorIs(t, err, collections.ErrNotFound)
	require.NoError(t, k.Mode2RepairReadiness.Set(ctx, collections.Join(uint64(0), uint32(0)), 2))
	d.ManifestRoot = bytes.Repeat([]byte{8}, 32)
	require.NoError(t, k.setDealWithAssignmentCollateralLocks(ctx, 0, d))
	_, err = k.Mode2RepairReadiness.Get(ctx, collections.Join(uint64(0), uint32(0)))
	require.ErrorIs(t, err, collections.ErrNotFound)
}

func TestStorageAuditReadinessInvalidatesOnLayoutAndStatusMutation(t *testing.T) {
	for _, mutation := range []string{"layout", "status", "population", "identity"} {
		t.Run(mutation, func(t *testing.T) {
			k, ctx, _, _, _ := storageStateFixture(t)
			d := storageStateDeal(0)
			d.RedundancyMode = 2
			d.Mode2Profile = &types.StripeReplicaProfile{K: 2, M: 1}
			d.Mode2Slots = []*types.DealSlot{{Slot: 0, Provider: d.Providers[0], PendingProvider: sdk.AccAddress(bytes.Repeat([]byte{9}, 20)).String(), Status: types.SlotStatus_SLOT_STATUS_REPAIRING, RepairTargetGen: d.CurrentGen}}
			require.NoError(t, k.Deals.Set(ctx, d.Id, d))
			require.NoError(t, k.processRetrievalChallengeState(ctx))
			key := collections.Join(d.Id, uint32(0))
			require.NoError(t, k.Mode2RepairReadiness.Set(ctx, key, d.CurrentGen+1))
			switch mutation {
			case "layout":
				d.Mode2Profile.K = 4
			case "status":
				d.Mode2Slots[0].Status = types.SlotStatus_SLOT_STATUS_ACTIVE
				d.Mode2Slots[0].PendingProvider = ""
			case "population":
				d.TotalMdus++
			case "identity":
				d.Mode2Slots[0].PendingProvider = sdk.AccAddress(bytes.Repeat([]byte{8}, 20)).String()
			}
			require.NoError(t, k.setDealWithAssignmentCollateralLocks(ctx, d.Id, d))
			_, err := k.Mode2RepairReadiness.Get(ctx, key)
			require.ErrorIs(t, err, collections.ErrNotFound)
			// Completing an old frozen list cannot recreate readiness for the
			// changed layout or identity, even if root and generation match.
			frozen, err := k.StorageAuditsForEpoch(ctx, 1)
			require.NoError(t, err)
			epoch, err := k.StorageAuditEpochs.Get(ctx, 1)
			require.NoError(t, err)
			frozen[0].AcceptedCount = frozen[0].SampleCount
			require.NoError(t, k.completeFrozenRepairReadiness(ctx, frozen[0], epoch))
			_, err = k.Mode2RepairReadiness.Get(ctx, key)
			require.ErrorIs(t, err, collections.ErrNotFound)
		})
	}
}

func BenchmarkStorageAuditMaximumEpoch(b *testing.B) {
	k, ctx, _, _, _ := storageStateFixture(b)
	for i := uint64(0); i < 64; i++ {
		d := storageStateDeal(i)
		d.EndBlock = 1 << 62
		require.NoError(b, k.Deals.Set(ctx, i, d))
	}
	require.NoError(b, k.processRetrievalChallengeState(ctx))
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		height := int64(2*i + 3)
		if err := k.processRetrievalChallengeState(ctx.WithBlockHeight(height)); err != nil {
			b.Fatal(fmt.Errorf("epoch %d: %w", i, err))
		}
	}
}

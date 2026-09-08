package keeper

import (
	"bytes"
	"encoding/binary"
	"math"
	"testing"

	"cosmossdk.io/collections"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"
	"polystorechain/x/polystorechain/types"
)

func retainedSessionFixture(t *testing.T, k Keeper, ctx sdk.Context, id byte, d types.Deal) types.RetrievalSession {
	t.Helper()
	audits, err := k.StorageAuditsForEpoch(ctx, 1)
	require.NoError(t, err)
	var snapshot *types.RetrievalChallengeSnapshot
	for _, a := range audits {
		if a.Assignment.DealId == d.Id {
			snapshot = a.Assignment.Snapshot
			break
		}
	}
	require.NotNil(t, snapshot)
	copySnapshot := *snapshot
	copySnapshot.Generation = d.CurrentGen
	snapshot = &copySnapshot
	s := types.RetrievalSession{SessionId: bytes.Repeat([]byte{id}, 32), DealId: d.Id, Provider: d.Providers[0], AuthorizedProofProvider: sdk.AccAddress(bytes.Repeat([]byte{98}, 20)).String(), ManifestRoot: d.ManifestRoot, ChallengeVersion: 2, ChallengeSnapshot: snapshot, OpenedHeight: 1, ExpiresAt: 3, StartMduIndex: 2, StartBlobIndex: 0, BlobCount: 1, TotalBytes: types.BlobSizeBytes, Status: types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_COMPLETED}
	require.NoError(t, k.RetrievalSessions.Set(ctx, s.SessionId, s))
	require.NoError(t, k.retainSessionChallenge(ctx, s))
	return s
}

func TestRetainedGenerationsUnionAndActualReferenceLifetime(t *testing.T) {
	k, ctx, _, _, _ := storageStateFixture(t)
	d := storageStateDeal(9)
	require.NoError(t, k.Deals.Set(ctx, d.Id, d))
	require.NoError(t, k.processRetrievalChallengeState(ctx))
	s := retainedSessionFixture(t, k, ctx, 1, d)
	query := NewQueryServerImpl(k)
	got, err := query.RetainedGenerations(ctx, &types.QueryRetainedGenerationsRequest{})
	require.NoError(t, err)
	require.EqualValues(t, 1, got.CommittedHeight)
	require.Equal(t, []types.RetainedGeneration{{DealId: d.Id, Generation: 1, ManifestRoot: d.ManifestRoot}}, got.Generations)
	// Terminal histories are outside the active expiry-reference inventory.
	for i := 0; i < 1000; i++ {
		require.NoError(t, k.RetrievalSessions.Set(ctx, []byte{99, byte(i >> 8), byte(i)}, types.RetrievalSession{Status: types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_COMPLETED}))
	}
	again, err := query.RetainedGenerations(ctx, &types.QueryRetainedGenerationsRequest{})
	require.NoError(t, err)
	require.Equal(t, got, again)
	// Releasing the audit alone must retain a completed session's generation.
	require.NoError(t, k.pruneStorageAuditEpoch(ctx, 1))
	again, err = query.RetainedGenerations(ctx, &types.QueryRetainedGenerationsRequest{})
	require.NoError(t, err)
	require.Equal(t, got, again)
	require.NoError(t, k.processRetrievalChallengeState(ctx.WithBlockHeight(2)))
	require.NoError(t, k.processRetrievalChallengeState(ctx.WithBlockHeight(4)))
	got, err = query.RetainedGenerations(ctx.WithBlockHeight(4), &types.QueryRetainedGenerationsRequest{})
	require.NoError(t, err)
	require.Empty(t, got.Generations)
	terminal, err := k.RetrievalSessions.Get(ctx, s.SessionId)
	require.NoError(t, err)
	require.Equal(t, types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_COMPLETED, terminal.Status)
}

func TestRetainedGenerationsMalformedFailsWithoutPartialResponse(t *testing.T) {
	for _, name := range []string{"session id", "expiry", "false ref", "session count", "session overflow", "generation count", "audit count", "audit ref", "root conflict", "anchor", "epoch overflow"} {
		t.Run(name, func(t *testing.T) {
			k, ctx, _, _, _ := storageStateFixture(t)
			d := storageStateDeal(1)
			require.NoError(t, k.Deals.Set(ctx, d.Id, d))
			require.NoError(t, k.processRetrievalChallengeState(ctx))
			s := retainedSessionFixture(t, k, ctx, 1, d)
			switch name {
			case "session id":
				s.SessionId = bytes.Repeat([]byte{2}, 32)
				require.NoError(t, k.RetrievalSessions.Set(ctx, bytes.Repeat([]byte{1}, 32), s))
			case "expiry":
				s.ExpiresAt = 4
				require.NoError(t, k.RetrievalSessions.Set(ctx, s.SessionId, s))
			case "false ref":
				require.NoError(t, k.RetrievalSessionExpiryRefs.Set(ctx, collections.Join(s.ExpiresAt, s.SessionId), false))
			case "session count":
				require.NoError(t, k.RetrievalSessionLiveCount.Set(ctx, 2))
			case "session overflow":
				require.NoError(t, k.RetrievalSessionLiveCount.Set(ctx, math.MaxUint64))
			case "generation count":
				require.NoError(t, k.RetrievalSessionGenerationRefs.Set(ctx, collections.Join(d.Id, uint64(1)), 2))
			case "audit count":
				e, err := k.StorageAuditEpochs.Get(ctx, 1)
				require.NoError(t, err)
				e.ObligationCount++
				require.NoError(t, k.StorageAuditEpochs.Set(ctx, 1, e))
			case "audit ref":
				require.NoError(t, k.StorageAuditGenerationRefs.Set(ctx, collections.Join(d.Id, uint64(1)), 2))
			case "root conflict":
				s.ManifestRoot = bytes.Repeat([]byte{7}, 32)
				require.NoError(t, k.RetrievalSessions.Set(ctx, s.SessionId, s))
			case "anchor":
				require.NoError(t, k.ChallengeAnchors.Remove(ctx, 2))
			case "epoch overflow":
				require.NoError(t, k.StorageAuditEpochLength.Set(ctx, math.MaxUint64))
			}
			got, err := NewQueryServerImpl(k).RetainedGenerations(ctx, &types.QueryRetainedGenerationsRequest{})
			require.Error(t, err)
			require.Nil(t, got)
		})
	}
}

func TestRetainedGenerationsSortedAcrossDealsAndGenerations(t *testing.T) {
	k, ctx, _, _, _ := storageStateFixture(t)
	for _, id := range []uint64{9, 2} {
		require.NoError(t, k.Deals.Set(ctx, id, storageStateDeal(id)))
	}
	require.NoError(t, k.processRetrievalChallengeState(ctx))
	d := storageStateDeal(2)
	d.CurrentGen = 2
	d.ManifestRoot = bytes.Repeat([]byte{5}, 32)
	retainedSessionFixture(t, k, ctx, 1, d)
	got, err := NewQueryServerImpl(k).RetainedGenerations(ctx, &types.QueryRetainedGenerationsRequest{})
	require.NoError(t, err)
	require.Equal(t, []types.RetainedGeneration{
		{DealId: 2, Generation: 1, ManifestRoot: storageStateDeal(2).ManifestRoot},
		{DealId: 2, Generation: 2, ManifestRoot: d.ManifestRoot},
		{DealId: 9, Generation: 1, ManifestRoot: storageStateDeal(9).ManifestRoot},
	}, got.Generations)
}

// Build the legal reference ceilings through the owning retain/prune helpers.
// Historic sessions need not correspond to the deal's current generation.
func maximumRetentionFixture(t testing.TB) (Keeper, sdk.Context) {
	t.Helper()
	k, ctx, _, _, _ := storageStateFixture(t)
	for id := uint64(0); id < 64; id++ {
		d := storageStateDeal(id)
		d.CurrentGen = 9
		require.NoError(t, k.Deals.Set(ctx, id, d))
	}
	for height := int64(1); height <= 65; height++ {
		ctx = ctx.WithBlockHeight(height)
		require.NoError(t, k.processRetrievalChallengeState(ctx))
		if height == 64 {
			for id := uint64(0); id < 64; id++ {
				d := storageStateDeal(id)
				d.CurrentGen = 10
				require.NoError(t, k.setDealWithAssignmentCollateralLocks(ctx, id, d))
			}
		}
	}
	audits, err := k.StorageAuditsForEpoch(ctx, 33)
	require.NoError(t, err)
	for i := uint64(0); i < types.MaxLiveRetrievalSessionContexts; i++ {
		id := make([]byte, 32)
		binary.BigEndian.PutUint64(id, i+1)
		snapshot := *audits[0].Assignment.Snapshot
		snapshot.Generation = (i/8)%8 + 1
		s := types.RetrievalSession{
			SessionId: id, DealId: i / 64, Provider: audits[0].Assignment.Provider,
			AuthorizedProofProvider: audits[0].Assignment.Provider, ManifestRoot: bytes.Repeat([]byte{byte(snapshot.Generation)}, 32),
			ChallengeVersion: 2, ChallengeSnapshot: &snapshot, OpenedHeight: int64(1 + i/128), ExpiresAt: 128 + i/128,
			StartMduIndex: 2, BlobCount: 1, TotalBytes: types.BlobSizeBytes, Status: types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_COMPLETED,
		}
		require.NoError(t, k.retainSessionChallenge(ctx, s))
		require.NoError(t, k.RetrievalSessions.Set(ctx, s.SessionId, s))
	}
	return k, ctx
}

func TestRetainedGenerationsMaximumInventories(t *testing.T) {
	k, ctx := maximumRetentionFixture(t)
	got, err := NewQueryServerImpl(k).RetainedGenerations(ctx, &types.QueryRetainedGenerationsRequest{})
	require.NoError(t, err)
	require.Len(t, got.Generations, int(maxRetainedGenerationTuples))
	require.EqualValues(t, 65, got.CommittedHeight)
	// A further reference must fail even when the scalar count is forged legal.
	require.NoError(t, k.RetrievalSessionExpiryRefs.Set(ctx, collections.Join(uint64(999), bytes.Repeat([]byte{99}, 32)), true))
	got, err = NewQueryServerImpl(k).RetainedGenerations(ctx, &types.QueryRetainedGenerationsRequest{})
	require.Error(t, err)
	require.Nil(t, got)
}

func BenchmarkRetainedGenerationsMaximum(b *testing.B) {
	k, ctx := maximumRetentionFixture(b)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		got, err := k.retainedGenerations(ctx)
		if err != nil || len(got) != int(maxRetainedGenerationTuples) {
			b.Fatalf("retained generation query failed: %v", err)
		}
	}
}

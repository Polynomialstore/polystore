package keeper_test

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"os"
	"testing"

	"cosmossdk.io/collections"
	"cosmossdk.io/log"
	"cosmossdk.io/math"
	"cosmossdk.io/store"
	"cosmossdk.io/store/metrics"
	storetypes "cosmossdk.io/store/types"
	"github.com/cosmos/cosmos-sdk/runtime"
	sdk "github.com/cosmos/cosmos-sdk/types"
	moduletestutil "github.com/cosmos/cosmos-sdk/types/module/testutil"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	"github.com/stretchr/testify/require"

	"polystorechain/pkg/retrievalchallenge"
	"polystorechain/x/polystorechain/keeper"
	module "polystorechain/x/polystorechain/module"
	"polystorechain/x/polystorechain/types"
)

func TestRetrievalSessionV3CompletionPreservesSharedRefsAndRestart(t *testing.T) {
	f, ctx, sessions, samples := openCryptoSessionV3Batch(t, 2)
	k := f.g.fixture.keeper
	// One V2 session shares the same anchor and generation with two V3 sessions.
	_, err := f.g.server.OpenRetrievalSession(f.g.ctx, &types.MsgOpenRetrievalSession{
		Creator: f.g.owner, DealId: f.g.deal.Id, Provider: f.g.providers[0], ManifestRoot: f.g.deal.ManifestRoot,
		StartMduIndex: 2, BlobCount: 1, Nonce: 99, ExpiresAt: 20, ChallengeVersion: retrievalchallenge.Version,
	})
	require.NoError(t, err)
	anchor, err := k.ChallengeAnchors.Get(ctx, sessions[0].AnchorHeight)
	require.NoError(t, err)
	anchor.AuditReferences = 1
	require.NoError(t, k.ChallengeAnchors.Set(ctx, sessions[0].AnchorHeight, anchor))
	_, err = f.g.server.AcknowledgeRetrievalObligationV3(ctx, &types.MsgAcknowledgeRetrievalObligationV3{
		Creator: f.g.owner, SessionId: sessions[0].SessionId, Slot: 0, AckDigest: ackDigestV3(t, sessions[0], 0),
	})
	require.NoError(t, err)
	_, err = f.g.server.SubmitRetrievalSessionProofBatchV3(ctx, batchProofMessageV3(f.g.providers[0], sessions[:1], samples[:1]))
	require.NoError(t, err)
	live, err := k.RetrievalSessionLiveCount.Get(ctx)
	require.NoError(t, err)
	require.Equal(t, uint64(2), live)
	anchor, err = k.ChallengeAnchors.Get(ctx, sessions[0].AnchorHeight)
	require.NoError(t, err)
	require.Equal(t, uint64(2), anchor.SessionReferences)
	require.Equal(t, uint64(1), anchor.AuditReferences)
	refs, err := k.RetrievalSessionGenerationRefs.Get(ctx, collections.Join(f.g.deal.Id, f.g.deal.CurrentGen))
	require.NoError(t, err)
	require.Equal(t, uint64(2), refs)
	// Commit and reopen IAVL, not merely a new keeper over the same cache.
	f.g.fixture.cms.Commit()
	reopened := store.NewCommitMultiStore(f.g.fixture.db, log.NewNopLogger(), metrics.NewNoOpMetrics())
	reopened.MountStoreWithDB(f.g.fixture.storeKey, storetypes.StoreTypeIAVL, f.g.fixture.db)
	require.NoError(t, reopened.LoadLatestVersion())
	ctx = ctx.WithMultiStore(reopened)
	svc := runtime.NewKVStoreService(f.g.fixture.storeKey)
	enc := moduletestutil.MakeTestEncodingConfig(module.AppModule{})
	k = keeper.NewKeeper(svc, enc.Codec, f.g.fixture.addressCodec, authtypes.NewModuleAddress(types.GovModuleName), f.g.bank, MockAccountKeeper{})
	query, err := keeper.NewQueryServerImpl(k).GetRetrievalSessionV3(ctx, &types.QueryGetRetrievalSessionV3Request{SessionId: sessions[0].SessionId})
	require.NoError(t, err)
	require.Equal(t, anchor.Seed, query.AnchorSeed)
	before := sessionStoreSnapshot(t, ctx, svc)
	replayed, err := keeper.NewMsgServerImpl(k).SubmitRetrievalSessionProofBatchV3(ctx, batchProofMessageV3(f.g.providers[0], sessions[:1], samples[:1]))
	require.NoError(t, err)
	require.True(t, replayed.Results[0].Settled)
	require.Zero(t, replayed.Results[0].NewlyAccepted)
	require.Equal(t, before, sessionStoreSnapshot(t, ctx, svc))
	ctx = ctx.WithBlockHeight(21).WithHeaderHash(bytes.Repeat([]byte{0x77}, 32))
	require.NoError(t, k.BeginBlock(ctx))
	live, err = k.RetrievalSessionLiveCount.Get(ctx)
	require.NoError(t, err)
	require.Zero(t, live)
	anchor, err = k.ChallengeAnchors.Get(ctx, sessions[0].AnchorHeight)
	require.NoError(t, err)
	require.Zero(t, anchor.SessionReferences)
	require.Equal(t, uint64(1), anchor.AuditReferences)
	query, err = keeper.NewQueryServerImpl(k).GetRetrievalSessionV3(ctx, &types.QueryGetRetrievalSessionV3Request{SessionId: sessions[0].SessionId})
	require.NoError(t, err)
	require.False(t, query.Session.Expired)
	require.Equal(t, uint32(1), query.Session.SettledSlotsMask)
	require.Equal(t, anchor.Seed, query.AnchorSeed)
	_, err = keeper.NewMsgServerImpl(k).SubmitRetrievalSessionProofBatchV3(ctx, batchProofMessageV3(f.g.providers[0], sessions[:1], samples[:1]))
	require.ErrorContains(t, err, "outside v3 session response window")
	_, err = keeper.NewMsgServerImpl(k).AcknowledgeRetrievalObligationV3(ctx, &types.MsgAcknowledgeRetrievalObligationV3{
		Creator: f.g.owner, SessionId: sessions[0].SessionId, Slot: 0, AckDigest: ackDigestV3(t, sessions[0], 0),
	})
	require.ErrorContains(t, err, "outside v3 session response window")
	before = sessionStoreSnapshot(t, ctx, svc)
	s := sessions[0]
	retried, err := keeper.NewMsgServerImpl(k).OpenRetrievalSessionV3(ctx, &types.MsgOpenRetrievalSessionV3{
		Creator: f.g.owner, DealId: s.DealId, Generation: s.Generation, Nonce: s.Nonce, DeadlineHeight: s.DeadlineHeight,
		Range: types.RetrievalRangeV3{FileRecordIndex: s.FileRecordIndex, FileStartOffset: s.FileStartOffset,
			FileLength: s.FileLength, RangeStart: s.RangeStart, RangeLength: s.RangeLength},
	})
	require.NoError(t, err)
	require.Equal(t, s.SessionId, retried.SessionId)
	byNonce, err := keeper.NewQueryServerImpl(k).GetRetrievalSessionV3ByNonce(ctx, &types.QueryGetRetrievalSessionV3ByNonceRequest{
		Owner: f.g.owner, DealId: s.DealId, Nonce: s.Nonce,
	})
	require.NoError(t, err)
	require.Equal(t, s.SessionId, byNonce.SessionId)
	highWater, err := keeper.NewQueryServerImpl(k).GetRetrievalSessionV3Nonce(ctx, &types.QueryGetRetrievalSessionV3NonceRequest{Owner: f.g.owner, DealId: s.DealId})
	require.NoError(t, err)
	require.Equal(t, uint64(2), highWater.Nonce)
	require.Equal(t, before, sessionStoreSnapshot(t, ctx, svc))
}

func TestRetrievalSessionV3CompletionStorageFailureRollsBack(t *testing.T) {
	for _, operation := range []string{"set", "delete"} {
		t.Run(operation, func(t *testing.T) {
			f, ctx, sessions, samples := openCryptoSessionV3Batch(t, 1)
			_, err := f.g.server.AcknowledgeRetrievalObligationV3(ctx, &types.MsgAcknowledgeRetrievalObligationV3{
				Creator: f.g.owner, SessionId: sessions[0].SessionId, Slot: 0, AckDigest: ackDigestV3(t, sessions[0], 0),
			})
			require.NoError(t, err)
			bank := newSessionCacheBank(t, f.g.fixture.storeService)
			require.NoError(t, bank.balances.Set(ctx, "module/"+types.ModuleName, "100"))
			prefix := types.RetrievalSessionV3TerminalAnchorsKey.Bytes()
			if operation == "delete" {
				prefix = types.RetrievalSessionExpiryRefsKey.Bytes()
			}
			fault := &sessionFaultService{KVStoreService: f.g.fixture.storeService, operation: operation, prefix: prefix}
			enc := moduletestutil.MakeTestEncodingConfig(module.AppModule{})
			k := keeper.NewKeeper(fault, enc.Codec, f.g.fixture.addressCodec, authtypes.NewModuleAddress(types.GovModuleName), bank, MockAccountKeeper{})
			before := sessionStoreSnapshot(t, ctx, f.g.fixture.storeService)
			tx, _ := ctx.CacheContext()
			_, err = keeper.NewMsgServerImpl(k).SubmitRetrievalSessionProofBatchV3(tx, batchProofMessageV3(f.g.providers[0], sessions, samples))
			require.ErrorContains(t, err, "injected session store")
			require.Equal(t, before, sessionStoreSnapshot(t, ctx, f.g.fixture.storeService))
		})
	}
}

func TestRetrievalSessionV3TerminalAnchorStorageBytes(t *testing.T) {
	keySize := len(types.RetrievalSessionV3TerminalAnchorsKey.Bytes()) + collections.BytesKey.Size(make([]byte, 32))
	encoded, err := collections.BytesValue.Encode(make([]byte, 32))
	require.NoError(t, err)
	require.Equal(t, 104, keySize+len(encoded))
}

// This is bounded keeper admission correctness, not a service-capacity run.
// All accepted samples are fresh real proofs; byte delivery is not simulated.
func TestRetrievalSessionV3CompletionChurnBeyondLiveCapacity(t *testing.T) {
	if os.Getenv("POLYSTORE_RUN_V3_COMPLETION_CHURN") != "1" {
		t.Skip("opt-in fresh-proof 8193-session admission qualification")
	}
	f := openCryptoSessionV3(t, 1024)
	k := f.g.fixture.keeper
	deal, err := k.Deals.Get(f.g.ctx, f.g.deal.Id)
	require.NoError(t, err)
	deal.EndBlock = 10000
	deal.EscrowBalance = math.NewInt(1_000_000)
	require.NoError(t, k.Deals.Set(f.g.ctx, deal.Id, deal))
	f.g.bank.moduleBalances[types.ModuleName] = sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 1_000_000))
	// An unfinished V2 obligation must remain charged across all V3 churn.
	_, err = f.g.server.OpenRetrievalSession(f.g.ctx, &types.MsgOpenRetrievalSession{
		Creator: f.g.owner, DealId: deal.Id, Provider: f.g.providers[0], ManifestRoot: deal.ManifestRoot,
		StartMduIndex: 2, BlobCount: 1, Nonce: 99, ExpiresAt: 4098, ChallengeVersion: retrievalchallenge.Version,
	})
	require.NoError(t, err)
	const target = types.MaxLiveRetrievalSessionContexts + 1
	var completed, nonce uint64 = 0, 1
	for wave := int64(0); completed < target; wave++ {
		ctx := f.g.ctx.WithBlockHeight(2 + wave*2)
		sessions := make([]types.RetrievalSessionV3, 0, 64)
		if wave == 0 {
			sessions = append(sessions, f.session)
		}
		for len(sessions) < 64 && completed+uint64(len(sessions)) < target {
			nonce++
			opened, err := f.g.server.OpenRetrievalSessionV3(ctx, &types.MsgOpenRetrievalSessionV3{
				Creator: f.g.owner, DealId: deal.Id, Generation: deal.CurrentGen,
				Range: types.RetrievalRangeV3{FileRecordIndex: 1, FileLength: 1024, RangeLength: 1024},
				Nonce: nonce, DeadlineHeight: uint64(ctx.BlockHeight()) + types.MaxRetrievalSessionTTL,
			})
			require.NoError(t, err)
			session, err := k.RetrievalSessionsV3.Get(ctx, opened.SessionId)
			require.NoError(t, err)
			sessions = append(sessions, session)
		}
		anchorHash := sha256.Sum256([]byte(fmt.Sprintf("v3-completion-churn-%d", wave)))
		ctx = ctx.WithBlockHeight(ctx.BlockHeight() + 1).WithHeaderHash(anchorHash[:])
		require.NoError(t, k.BeginBlock(ctx))
		ctx = ctx.WithBlockHeight(ctx.BlockHeight() + 1)
		require.NoError(t, k.BeginBlock(ctx))
		samples := make([]types.RetrievalSampleProofV3, len(sessions))
		for i, session := range sessions {
			require.Less(t, uint64(ctx.BlockHeight()), session.DeadlineHeight)
			c := challengeContextV3(t, session)
			seed, err := c.Seed(anchorHash[:])
			require.NoError(t, err)
			challenges, err := c.Challenges(seed[:])
			require.NoError(t, err)
			require.Len(t, challenges, 1)
			samples[i] = f.proof(t, challenges[0])
			ack, err := f.g.server.AcknowledgeRetrievalObligationV3(ctx, &types.MsgAcknowledgeRetrievalObligationV3{
				Creator: f.g.owner, SessionId: session.SessionId, Slot: 0, AckDigest: ackDigestV3(t, session, 0),
			})
			require.NoError(t, err)
			require.False(t, ack.Settled)
		}
		result, err := f.g.server.SubmitRetrievalSessionProofBatchV3(ctx, batchProofMessageV3(f.g.providers[0], sessions, samples))
		require.NoError(t, err)
		for _, result := range result.Results {
			require.Equal(t, uint32(1), result.NewlyAccepted)
			require.True(t, result.Settled)
		}
		completed += uint64(len(sessions))
		if completed%1024 == 0 {
			t.Logf("completed %d fresh real-proof sessions", completed)
		}
		live, err := k.RetrievalSessionLiveCount.Get(ctx)
		require.NoError(t, err)
		require.Equal(t, uint64(1), live, "only the unfinished V2 obligation remains live")
		_, err = keeper.NewQueryServerImpl(k).RetainedGenerations(ctx, &types.QueryRetainedGenerationsRequest{})
		require.NoError(t, err)
	}
	require.Equal(t, uint64(target), completed)
	t.Logf("completed %d fresh real-proof V3 sessions before their original deadlines; unfinished V2 remains charged", completed)
}

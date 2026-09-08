package keeper_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"testing"
	"time"

	"cosmossdk.io/collections"
	"cosmossdk.io/math"
	storetypes "cosmossdk.io/store/types"
	cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"
	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/types"
)

func TestRetrievalV2BatchFirstMiddleLastFailure(t *testing.T) {
	t.Setenv("POLYSTORE_BENCH_FIXTURE_NONCONSTANT", "1")
	e := setupBenchRetrievalEnv(t)
	ctx, msg, _ := e.challengedBenchSession(t, activateSessionFixture(t, e.f), 8, 1)
	original, err := e.f.keeper.RetrievalSessions.Get(ctx, msg.SessionId)
	require.NoError(t, err)
	var rejectedGas uint64
	for _, index := range []int{0, 4, 7} {
		bad := *msg
		bad.Proofs = append([]types.ChainedProof(nil), msg.Proofs...)
		bad.Proofs[index].YValue = bytes.Clone(bad.Proofs[index].YValue)
		bad.Proofs[index].YValue[31] ^= 1
		attempt := ctx.WithGasMeter(storetypes.NewGasMeter(uint64(types.MaxRetrievalV2BlockGas)))
		_, err := e.msgServer.SubmitRetrievalSessionProof(attempt, &bad)
		require.ErrorContains(t, err, "invalid retrieval proof")
		if rejectedGas == 0 {
			rejectedGas = attempt.GasMeter().GasConsumed()
		}
		require.Equal(t, rejectedGas, attempt.GasMeter().GasConsumed(), "invalid opening position does not discount whole-list gas")
		after, err := e.f.keeper.RetrievalSessions.Get(ctx, msg.SessionId)
		require.NoError(t, err)
		require.Equal(t, original, after)
		_, err = e.f.keeper.RetrievalSessionProofProvider.Get(ctx, msg.SessionId)
		require.ErrorIs(t, err, collections.ErrNotFound)
	}
	// Even a late crypto failure cannot enter native code without all eight charges.
	require.Panics(t, func() {
		_, _ = e.msgServer.SubmitRetrievalSessionProof(ctx.WithGasMeter(storetypes.NewGasMeter(8*500000-1)), msg)
	})
	_, err = e.msgServer.SubmitRetrievalSessionProof(ctx, msg)
	require.NoError(t, err)
	accepted, err := e.f.keeper.RetrievalSessions.Get(ctx, msg.SessionId)
	require.NoError(t, err)
	require.Equal(t, types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_PROOF_SUBMITTED, accepted.Status)
	_, err = e.msgServer.SubmitRetrievalSessionProof(ctx.WithGasMeter(storetypes.NewGasMeter(499999)), msg)
	require.NoError(t, err)
}

// This fixture can also run unchanged against the pre-batch keeper. Each
// iteration opens a distinct session in an isolated cache, captures its future
// anchor and generates fresh off-domain openings. Only first proof acceptance
// is timed. Discarding the cache prevents benchmark duration from changing the
// number of live sessions or hitting protocol admission caps.
func BenchmarkSubmitRetrievalSessionProofV2(b *testing.B) {
	b.Setenv("POLYSTORE_BENCH_FIXTURE_NONCONSTANT", "1")
	e := setupBenchRetrievalEnv(b)
	ctx := sdk.UnwrapSDKContext(e.f.ctx).WithBlockHeight(1).WithChainID("retrieval-v2-bench").WithConsensusParams(cmtproto.ConsensusParams{Block: &cmtproto.BlockParams{MaxGas: types.MaxRetrievalV2BlockGas, MaxBytes: types.MaxRetrievalV2BlockBytes}})
	params, err := e.f.keeper.Params.Get(ctx)
	require.NoError(b, err)
	params.RetrievalV2ActivationHeight = 1
	require.NoError(b, e.f.keeper.Params.Set(ctx, params))
	require.NoError(b, e.f.keeper.BeginBlock(ctx))
	ctx = ctx.WithBlockHeight(2)
	for _, count := range []uint64{1, 2, 8, 32} {
		if count > e.rows {
			continue
		}
		b.Run(fmt.Sprintf("K%d/proofs%d", e.k, count), func(b *testing.B) {
			b.ReportAllocs()
			b.StopTimer()
			var gas uint64
			var generation time.Duration
			for iteration := 0; iteration < b.N; iteration++ {
				branch, msg, elapsed := e.challengedBenchSession(b, ctx, count, uint64(iteration)+1)
				generation += elapsed
				b.StartTimer()
				_, err = e.msgServer.SubmitRetrievalSessionProof(branch, msg)
				b.StopTimer()
				require.NoError(b, err)
				gas += branch.GasMeter().GasConsumed()
				accepted, err := e.f.keeper.RetrievalSessions.Get(branch, msg.SessionId)
				require.NoError(b, err)
				require.Equal(b, types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_PROOF_SUBMITTED, accepted.Status)
			}
			b.ReportMetric(float64(gas)/float64(b.N), "gas/op")
			b.ReportMetric(float64(generation.Nanoseconds())/float64(b.N), "generation-ns/op")
		})
	}
}

func (e *benchRetrievalEnv) challengedBenchSession(tb testing.TB, ctx sdk.Context, count, nonce uint64) (sdk.Context, *types.MsgSubmitRetrievalSessionProof, time.Duration) {
	tb.Helper()
	branch, _ := ctx.CacheContext()
	opened, err := e.msgServer.OpenRetrievalSession(branch, &types.MsgOpenRetrievalSession{Creator: e.owner, DealId: e.dealID, Provider: e.provider, ManifestRoot: e.deal.ManifestRoot, StartMduIndex: benchTargetMduIndex, BlobCount: count, Nonce: nonce, ExpiresAt: 10, ChallengeVersion: 2})
	require.NoError(tb, err)
	var seedInput [16]byte
	binary.BigEndian.PutUint64(seedInput[:8], count)
	binary.BigEndian.PutUint64(seedInput[8:], nonce)
	seed := sha256.Sum256(seedInput[:])
	branch = branch.WithBlockHeight(3).WithHeaderHash(seed[:])
	require.NoError(tb, e.f.keeper.BeginBlock(branch))
	branch = branch.WithBlockHeight(4)
	session, err := e.f.keeper.RetrievalSessions.Get(branch, opened.SessionId)
	require.NoError(tb, err)
	msg, generation := e.freshBenchSessionProof(tb, session, seed[:])
	branch = branch.WithGasMeter(storetypes.NewGasMeter(uint64(types.MaxRetrievalV2BlockGas)))
	return branch, msg, generation
}

func (e *benchRetrievalEnv) freshBenchSessionProof(tb testing.TB, session types.RetrievalSession, seed []byte) (*types.MsgSubmitRetrievalSessionProof, time.Duration) {
	tb.Helper()
	challenge, err := types.RetrievalChallengeContext(session)
	require.NoError(tb, err)
	points, err := challenge.Challenges(seed)
	require.NoError(tb, err)
	proofs := make([]types.ChainedProof, session.BlobCount)
	started := time.Now()
	for i, point := range points {
		leaf := uint64(point.LeafIndex)
		blob := benchBlobBytesForLeaf(tb, e.mduData, e.shards, e.k, leaf/e.rows, leaf%e.rows)
		proof, y, err := crypto_ffi.ComputeBlobProof(blob, point.Z[:])
		require.NoError(tb, err)
		proofs[i] = types.ChainedProof{MduIndex: point.MDUIndex, BlobIndex: point.LeafIndex, MduRootFr: e.mduRoot, ManifestOpening: e.rootTableOpening, RootTableDuCommitment: e.rootTableDuCommitment, RootTableDuMerklePath: e.rootTableDuMerklePath, BlobCommitment: e.witnessFlat[leaf*48 : (leaf+1)*48], MerklePath: benchMerklePathFromWitnessFlat(tb, e.witnessFlat, leaf), ZValue: point.Z[:], YValue: y, KzgOpeningProof: proof}
	}
	generation := time.Since(started)
	msg := &types.MsgSubmitRetrievalSessionProof{Creator: session.AuthorizedProofProvider, SessionId: session.SessionId, Proofs: proofs}
	return msg, generation
}

const mixedRetrievalSessions = 6
const mixedRetrievalProofs = 52

type mixedRetrievalCase struct {
	env         *benchRetrievalEnv
	slot, count uint64
}

// Two geometry templates reuse the maintained nonconstant fixture, but both
// measured deals and all six sessions live in the first template's keeper.
func setupMixedRetrievalV2(tb testing.TB) (sdk.Context, []mixedRetrievalCase) {
	tb.Helper()
	tb.Setenv("POLYSTORE_BENCH_FIXTURE_NONCONSTANT", "1")
	tb.Setenv("POLYSTORE_BENCH_FIXTURE_SERVICE_HINT", "General:rs=8+4")
	k8 := setupBenchRetrievalEnv(tb)
	tb.Setenv("POLYSTORE_BENCH_FIXTURE_SERVICE_HINT", "General:rs=2+1")
	k2 := setupBenchRetrievalEnv(tb)
	require.Equal(tb, uint64(8), k8.k)
	require.Equal(tb, uint64(2), k2.k)

	owner, err := k8.f.addressCodec.BytesToString([]byte("mixed_owner_2_______"))
	require.NoError(tb, err)
	created, err := k8.msgServer.CreateDeal(k8.f.ctx, &types.MsgCreateDeal{
		Creator: owner, DurationBlocks: 100, ServiceHint: "General:rs=2+1",
		InitialEscrowAmount: math.NewInt(100000000), MaxMonthlySpend: math.NewInt(10000000),
	})
	require.NoError(tb, err)
	_, err = k8.msgServer.UpdateDealContent(k8.f.ctx, &types.MsgUpdateDealContent{
		Creator: owner, DealId: created.DealId, Cid: "0x" + hex.EncodeToString(k2.deal.ManifestRoot),
		Size_: 8 * 1024 * 1024, TotalMdus: 4, WitnessMdus: benchWitnessMdus,
	})
	require.NoError(tb, err)
	k2.f, k2.msgServer, k2.owner, k2.dealID = k8.f, k8.msgServer, owner, created.DealId
	k2.deal, err = k8.f.keeper.Deals.Get(k8.f.ctx, created.DealId)
	require.NoError(tb, err)
	require.NotEqual(tb, k8.owner, k2.owner)
	require.NotEqual(tb, k8.dealID, k2.dealID)
	require.Equal(tb, uint32(k2.k), k2.deal.Mode2Profile.K)
	require.Equal(tb, uint32(k2.m), k2.deal.Mode2Profile.M)

	ctx := sdk.UnwrapSDKContext(k8.f.ctx).WithBlockHeight(1).WithChainID("retrieval-v2-mixed-bench").WithConsensusParams(cmtproto.ConsensusParams{Block: &cmtproto.BlockParams{MaxGas: types.MaxRetrievalV2BlockGas, MaxBytes: types.MaxRetrievalV2BlockBytes}})
	params, err := k8.f.keeper.Params.Get(ctx)
	require.NoError(tb, err)
	params.RetrievalV2ActivationHeight = 1
	require.NoError(tb, k8.f.keeper.Params.Set(ctx, params))
	require.NoError(tb, k8.f.keeper.BeginBlock(ctx))
	// Interleave profiles and exercise data and parity slots, without a Cartesian matrix.
	cases := []mixedRetrievalCase{{k8, 0, 1}, {k2, 0, 1}, {k8, 8, 2}, {k2, 1, 8}, {k8, 11, 8}, {k2, 2, 32}}
	return ctx.WithBlockHeight(2), cases
}

func (c mixedRetrievalCase) provider(tb testing.TB) string {
	tb.Helper()
	for _, slot := range c.env.deal.Mode2Slots {
		if uint64(slot.Slot) == c.slot {
			return slot.Provider
		}
	}
	tb.Fatalf("missing assigned provider for slot %d", c.slot)
	return ""
}

func prepareMixedRetrievalV2(tb testing.TB, ctx sdk.Context, cases []mixedRetrievalCase, nonce uint64) (sdk.Context, []*types.MsgSubmitRetrievalSessionProof, time.Duration) {
	tb.Helper()
	require.Len(tb, cases, mixedRetrievalSessions)
	branch, _ := ctx.CacheContext()
	ids := make([][]byte, len(cases))
	for i, c := range cases {
		require.LessOrEqual(tb, c.count, c.env.rows)
		opened, err := c.env.msgServer.OpenRetrievalSession(branch, &types.MsgOpenRetrievalSession{
			Creator: c.env.owner, DealId: c.env.dealID, Provider: c.provider(tb),
			ManifestRoot: c.env.deal.ManifestRoot, StartMduIndex: benchTargetMduIndex,
			StartBlobIndex: uint32(c.slot * c.env.rows), BlobCount: c.count,
			Nonce: nonce, ExpiresAt: 10, ChallengeVersion: 2,
		})
		require.NoError(tb, err)
		ids[i] = opened.SessionId
	}
	var seedInput [8]byte
	binary.BigEndian.PutUint64(seedInput[:], nonce)
	seed := sha256.Sum256(append([]byte("retrieval-v2-mixed-bench/anchor/"), seedInput[:]...))
	branch = branch.WithBlockHeight(3).WithHeaderHash(seed[:])
	require.NoError(tb, cases[0].env.f.keeper.BeginBlock(branch))
	branch = branch.WithBlockHeight(4)
	msgs := make([]*types.MsgSubmitRetrievalSessionProof, len(cases))
	var generation time.Duration
	var proofCount int
	providers := make(map[string]bool)
	for i, c := range cases {
		session, err := c.env.f.keeper.RetrievalSessions.Get(branch, ids[i])
		require.NoError(tb, err)
		require.Equal(tb, c.env.owner, session.Owner)
		require.Equal(tb, c.env.dealID, session.DealId)
		require.Equal(tb, c.provider(tb), session.Provider)
		require.Equal(tb, session.Provider, session.AuthorizedProofProvider)
		require.Equal(tb, uint32(c.env.k), session.ChallengeSnapshot.K)
		require.Equal(tb, uint32(c.env.m), session.ChallengeSnapshot.M)
		require.Equal(tb, uint32(c.slot), session.ChallengeSnapshot.Slot)
		require.Equal(tb, types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_OPEN, session.Status)
		var elapsed time.Duration
		msgs[i], elapsed = c.env.freshBenchSessionProof(tb, session, seed[:])
		generation += elapsed
		proofCount += len(msgs[i].Proofs)
		providers[session.Provider] = true
		// Constant/identity fixtures can accidentally measure a crypto fast path.
		infinity := make([]byte, 48)
		infinity[0] = 0xc0
		for _, proof := range msgs[i].Proofs {
			require.NotEqual(tb, infinity, proof.BlobCommitment)
			require.NotEqual(tb, infinity, proof.KzgOpeningProof)
			require.Equal(tb, c.slot, uint64(proof.BlobIndex)/c.env.rows)
		}
	}
	require.GreaterOrEqual(tb, len(providers), 3)
	require.Equal(tb, mixedRetrievalProofs, proofCount)
	return branch.WithGasMeter(storetypes.NewGasMeter(uint64(types.MaxRetrievalV2BlockGas))), msgs, generation
}

func assertMixedRetrievalAccepted(tb testing.TB, ctx sdk.Context, cases []mixedRetrievalCase, msgs []*types.MsgSubmitRetrievalSessionProof) {
	tb.Helper()
	for i, msg := range msgs {
		accepted, err := cases[i].env.f.keeper.RetrievalSessions.Get(ctx, msg.SessionId)
		require.NoError(tb, err)
		require.Equal(tb, types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_PROOF_SUBMITTED, accepted.Status)
		provider, err := cases[i].env.f.keeper.RetrievalSessionProofProvider.Get(ctx, msg.SessionId)
		require.NoError(tb, err)
		require.Equal(tb, msg.Creator, provider)
	}
}

func TestRetrievalV2MixedBenchmarkFixture(t *testing.T) {
	ctx, cases := setupMixedRetrievalV2(t)
	branch, msgs, _ := prepareMixedRetrievalV2(t, ctx, cases, 1)
	wrong := *msgs[0]
	wrong.Creator = cases[0].env.owner
	_, err := cases[0].env.msgServer.SubmitRetrievalSessionProof(branch, &wrong)
	require.Error(t, err, "owner is not the assigned proof provider")
	for i, msg := range msgs {
		_, err := cases[i].env.msgServer.SubmitRetrievalSessionProof(branch, msg)
		require.NoError(t, err)
		_, err = cases[i].env.f.keeper.RetrievalSessions.Get(ctx, msg.SessionId)
		require.ErrorIs(t, err, collections.ErrNotFound, "iteration cache must not accumulate sessions in its parent")
	}
	require.GreaterOrEqual(t, branch.GasMeter().GasConsumed(), uint64(mixedRetrievalProofs*500000))
	assertMixedRetrievalAccepted(t, branch, cases, msgs)
}

// One op = six first proof-acceptance keeper calls / 52 proofs, in order:
// K8/slot0/1, K2/slot0/1, K8/slot8/2, K2/slot1/8, K8/slot11/8, K2/slot2/32.
// Both owners/deals share one cached keeper, with a mock bank and no signatures,
// ante, ACK, settlement, FinalizeBlock, Commit, RPC or fsync. Setup, session opens,
// anchor capture, fresh proof generation and assertions are outside the timer.
// Each iteration discards its cache; native setup remains warm in the process.
// One complete, untimed acceptance cycle warms verification before measurement.
// Go B/op excludes native allocations; process RSS includes untimed preparation.
// Overlay this exact file onto both 34e7c2db and candidate; build their own native
// libraries and test binaries. After correctness validation, use five independent
// warmed processes per revision, interleaved, -test.benchtime=3x -test.count=1
// -test.run=^$ -test.bench=^BenchmarkSubmitRetrievalSessionProofV2Mixed$.
func BenchmarkSubmitRetrievalSessionProofV2Mixed(b *testing.B) {
	ctx, cases := setupMixedRetrievalV2(b)
	b.ReportAllocs()
	b.StopTimer()
	warm, warmMsgs, _ := prepareMixedRetrievalV2(b, ctx, cases, 1)
	for i, msg := range warmMsgs {
		_, err := cases[i].env.msgServer.SubmitRetrievalSessionProof(warm, msg)
		require.NoError(b, err)
	}
	assertMixedRetrievalAccepted(b, warm, cases, warmMsgs)
	b.ResetTimer()
	var gas uint64
	var generation time.Duration
	for iteration := 0; iteration < b.N; iteration++ {
		branch, msgs, elapsed := prepareMixedRetrievalV2(b, ctx, cases, uint64(iteration)+2)
		generation += elapsed
		var errors [mixedRetrievalSessions]error
		b.StartTimer()
		for i, msg := range msgs {
			_, errors[i] = cases[i].env.msgServer.SubmitRetrievalSessionProof(branch, msg)
		}
		b.StopTimer()
		gas += branch.GasMeter().GasConsumed()
		for _, err := range errors {
			require.NoError(b, err)
		}
		assertMixedRetrievalAccepted(b, branch, cases, msgs)
	}
	b.ReportMetric(mixedRetrievalSessions, "sessions/op")
	b.ReportMetric(mixedRetrievalProofs, "proofs/op")
	b.ReportMetric(float64(gas)/float64(b.N), "gas/op")
	b.ReportMetric(float64(gas)/float64(b.N*mixedRetrievalProofs), "gas/proof")
	b.ReportMetric(float64(generation.Nanoseconds())/float64(b.N), "generation-ns/op")
}

package keeper_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"testing"
	"time"

	"cosmossdk.io/collections"
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
	challenge, err := types.RetrievalChallengeContext(session)
	require.NoError(tb, err)
	points, err := challenge.Challenges(seed[:])
	require.NoError(tb, err)
	proofs := make([]types.ChainedProof, count)
	started := time.Now()
	for i, point := range points {
		leaf := uint64(point.LeafIndex)
		blob := benchBlobBytesForLeaf(tb, e.mduData, e.shards, e.k, leaf/e.rows, leaf%e.rows)
		proof, y, err := crypto_ffi.ComputeBlobProof(blob, point.Z[:])
		require.NoError(tb, err)
		proofs[i] = types.ChainedProof{MduIndex: point.MDUIndex, BlobIndex: point.LeafIndex, MduRootFr: e.mduRoot, ManifestOpening: e.rootTableOpening, RootTableDuCommitment: e.rootTableDuCommitment, RootTableDuMerklePath: e.rootTableDuMerklePath, BlobCommitment: e.witnessFlat[leaf*48 : (leaf+1)*48], MerklePath: benchMerklePathFromWitnessFlat(tb, e.witnessFlat, leaf), ZValue: point.Z[:], YValue: y, KzgOpeningProof: proof}
	}
	generation := time.Since(started)
	branch = branch.WithGasMeter(storetypes.NewGasMeter(uint64(types.MaxRetrievalV2BlockGas)))
	msg := &types.MsgSubmitRetrievalSessionProof{Creator: e.provider, SessionId: opened.SessionId, Proofs: proofs}
	return branch, msg, generation
}

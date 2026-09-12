package keeper_test

import (
	"fmt"
	"testing"

	"github.com/stretchr/testify/require"

	"polystorechain/x/polystorechain/keeper"
	"polystorechain/x/polystorechain/types"
)

func batchVerifierFixtureV3(tb testing.TB, count int) ([]byte, []*types.ChainedProof) {
	tb.Helper()
	tb.Setenv("POLYSTORE_BENCH_FIXTURE_NONCONSTANT", "1")
	env := setupBenchRetrievalEnv(tb)
	proofValues := make([]types.ChainedProof, count)
	proofs := make([]*types.ChainedProof, count)
	infinity := make([]byte, 48)
	infinity[0] = 0xc0
	for i := range proofValues {
		proofValues[i] = env.benchBuildChainedProof(tb, uint64(i%int(env.leafCount)), uint64(i)+100)
		require.NotEqual(tb, infinity, proofValues[i].ManifestOpening)
		require.NotEqual(tb, infinity, proofValues[i].RootTableDuCommitment)
		require.NotEqual(tb, infinity, proofValues[i].BlobCommitment)
		require.NotEqual(tb, infinity, proofValues[i].KzgOpeningProof)
		proofs[i] = &proofValues[i]
	}
	require.NotEqual(tb, infinity, env.deal.ManifestRoot)
	return append([]byte(nil), env.deal.ManifestRoot...), proofs
}

func TestRetrievalV3ProofBatchVerifierWorkerStress(t *testing.T) {
	root, proofs := batchVerifierFixtureV3(t, 64)
	bad := *proofs[17]
	bad.YValue = append([]byte(nil), bad.YValue...)
	bad.YValue[31] ^= 1
	proofs[17] = &bad
	for _, workers := range []int{1, 2, 4, 8, 16} {
		t.Run(fmt.Sprintf("workers=%d", workers), func(t *testing.T) {
			for range 20 {
				errs := keeper.VerifyRetrievalProofsV3ForTest(root, proofs, workers)
				require.Len(t, errs, len(proofs))
				for i, err := range errs {
					if i == 17 {
						require.Error(t, err)
					} else {
						require.NoError(t, err)
					}
				}
			}
		})
	}
}

func BenchmarkRetrievalV3ProofBatchVerify(b *testing.B) {
	root, allProofs := batchVerifierFixtureV3(b, 64)
	for _, count := range []int{8, 32, 64} {
		for _, workers := range []int{1, 2, 4, 8} {
			b.Run(fmt.Sprintf("proofs=%d/workers=%d", count, workers), func(b *testing.B) {
				proofs := allProofs[:count]
				b.ReportAllocs()
				b.ReportMetric(float64(count), "proofs/op")
				for i := 0; i < b.N; i++ {
					for _, err := range keeper.VerifyRetrievalProofsV3ForTest(root, proofs, workers) {
						if err != nil {
							b.Fatal(err)
						}
					}
				}
			})
		}
	}
}

func BenchmarkRetrievalV3CrossSessionBatchFirstAcceptance(b *testing.B) {
	for _, count := range []int{1, 8, 32, 64} {
		b.Run(fmt.Sprintf("sessions=%d", count), func(b *testing.B) {
			f, ctx, sessions, samples := openCryptoSessionV3Batch(b, count)
			creator := sessions[0].Obligations[0].AssignedProvider
			msg := batchProofMessageV3(creator, sessions, samples)
			b.ReportAllocs()
			b.ReportMetric(float64(count), "sessions/op")
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				run, _ := ctx.CacheContext()
				if _, err := f.g.server.SubmitRetrievalSessionProofBatchV3(run, msg); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

func BenchmarkRetrievalV3SingleProofFirstAcceptance(b *testing.B) {
	f, ctx, sessions, samples := openCryptoSessionV3Batch(b, 1)
	creator := sessions[0].Obligations[0].AssignedProvider
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		run, _ := ctx.CacheContext()
		_, err := f.g.server.SubmitRetrievalSessionProofV3(run, &types.MsgSubmitRetrievalSessionProofV3{
			Creator: creator, SessionId: sessions[0].SessionId, Slot: 0,
			Proofs: []types.RetrievalSampleProofV3{samples[0]},
		})
		if err != nil {
			b.Fatal(err)
		}
	}
}

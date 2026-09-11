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
	env := setupBenchRetrievalEnv(tb)
	proofValues := make([]types.ChainedProof, count)
	proofs := make([]*types.ChainedProof, count)
	for i := range proofValues {
		proofValues[i] = env.benchBuildChainedProof(tb, uint64(i%int(env.leafCount)), uint64(i)+100)
		proofs[i] = &proofValues[i]
	}
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

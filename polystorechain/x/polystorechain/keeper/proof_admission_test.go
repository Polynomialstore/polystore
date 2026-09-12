package keeper

import (
	"math"
	"testing"

	storetypes "cosmossdk.io/store/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"
	"polystorechain/x/polystorechain/types"
)

func admissionProof() types.ChainedProof {
	path := func(n int) [][]byte {
		p := make([][]byte, n)
		for i := range p {
			p[i] = make([]byte, 32)
		}
		return p
	}
	return types.ChainedProof{MduIndex: 2, MduRootFr: make([]byte, 32), ManifestOpening: make([]byte, 48), RootTableDuCommitment: make([]byte, 48), RootTableDuMerklePath: path(6), BlobCommitment: make([]byte, 48), MerklePath: path(6), ZValue: make([]byte, 32), YValue: make([]byte, 32), KzgOpeningProof: make([]byte, 48)}
}

func TestProofAdmissionBounds(t *testing.T) {
	// Independent small-tree oracle: build node ranges bottom-up and count whether
	// each original leaf's subtree is paired. Covers every odd-tree promotion.
	for leaves := 1; leaves <= 130; leaves++ {
		counts := make([]int, leaves)
		nodes := make([][]int, leaves)
		for i := range nodes {
			nodes[i] = []int{i}
		}
		for len(nodes) > 1 {
			next := [][]int{}
			for i := 0; i < len(nodes); i += 2 {
				if i+1 == len(nodes) {
					next = append(next, nodes[i])
					continue
				}
				joined := append(append([]int{}, nodes[i]...), nodes[i+1]...)
				for _, leaf := range joined {
					counts[leaf]++
				}
				next = append(next, joined)
			}
			nodes = next
		}
		for index, want := range counts {
			got, err := MerkleSiblingCount(uint64(leaves), uint64(index))
			require.NoError(t, err)
			require.Equal(t, want, got)
		}
	}
	p := admissionProof()
	root := make([]byte, 32)
	require.NoError(t, ValidateChainedProofShape(root, &p, 64))
	p.MerklePath = append(p.MerklePath, make([]byte, 32))
	require.Error(t, ValidateChainedProofShape(root, &p, 64))
	p = admissionProof()
	p.RootTableDuMerklePath = append(p.RootTableDuMerklePath, make([]byte, 32))
	require.Error(t, ValidateChainedProofShape(root, &p, 64))
	p = admissionProof()
	p.KzgOpeningProof = make([]byte, 49)
	require.Error(t, ValidateChainedProofShape(root, &p, 64))
	p = admissionProof()
	p.MduIndex = 65537
	require.Error(t, ValidateChainedProofShape(root, &p, 64))
	p = admissionProof()
	p.BlobIndex = 95 // 96-leaf tree last third is promoted at one level.
	require.NoError(t, ValidateChainedProofShape(root, &p, 96))
	p.MerklePath = append(p.MerklePath, make([]byte, 32))
	require.Error(t, ValidateChainedProofShape(root, &p, 96))
	require.Error(t, ValidateProofCount(0))
	require.NoError(t, ValidateProofCount(64))
	require.Error(t, ValidateProofCount(65))
	require.Error(t, ValidateProofCount(math.MaxUint64))
}

func TestLegacyProofRangeAndPricing(t *testing.T) {
	p := admissionProof()
	deal := types.Deal{WitnessMdus: 1, TotalMdus: 3, Size_: 1 << 30}
	for _, tc := range []struct {
		start, length uint64
		ok            bool
	}{{0, 0, false}, {0, 1, true}, {0, 1023, true}, {0, 1024, true}, {0, 1025, true}, {0, LegacyProofPayloadBytes, true}, {0, LegacyProofPayloadBytes + 1, false}, {0, 1 << 30, false}, {math.MaxUint64, 1, false}, {1 << 30, 1, false}, {(1 << 30) - 1, 1, true}, {0, math.MaxUint64, false}} {
		err := ValidateLegacyProofRange(deal, &p, tc.start, tc.length)
		require.Equal(t, tc.ok, err == nil, "start=%d len=%d: %v", tc.start, tc.length, err)
	}
	for _, mdu := range []uint64{0, 1, 3, math.MaxUint64} {
		p.MduIndex = mdu
		require.Error(t, ValidateProofTarget(deal, &p))
	}
	p.MduIndex = 2
	deal.TotalMdus = 0
	require.ErrorContains(t, ValidateProofTarget(deal, &p), "legacy deal")
	for _, tc := range []struct{ bytes, units uint64 }{{0, 0}, {1, 1}, {1023, 1}, {1024, 1}, {1025, 2}, {math.MaxUint64, 1 << 54}} {
		require.Equal(t, tc.units, LegacyReceiptUnits(tc.bytes))
	}
}

func TestProofCryptoPrepayment(t *testing.T) {
	for _, count := range []uint64{1, 2, 8, 32, 64} {
		meter := storetypes.NewGasMeter(count * ProofCryptoGas)
		ctx := sdk.Context{}.WithGasMeter(meter)
		require.NoError(t, PrepayProofCrypto(ctx, count))
		require.Equal(t, count*ProofCryptoGas, meter.GasConsumed())
		ctx = ctx.WithGasMeter(storetypes.NewGasMeter(count*ProofCryptoGas - 1))
		require.Panics(t, func() { _ = PrepayProofCrypto(ctx, count) })
	}
	ctx := sdk.Context{}.WithGasMeter(storetypes.NewGasMeter(1))
	require.Error(t, PrepayProofCrypto(ctx, math.MaxUint64))
	require.Zero(t, ctx.GasMeter().GasConsumed())
}

func TestAggregateProofCryptoPrepayment(t *testing.T) {
	for _, tc := range []struct{ count, gas uint64 }{
		{1, 1_000_000}, {2, 1_100_000}, {8, 1_700_000}, {32, 4_100_000}, {64, 7_300_000},
	} {
		gas, err := AggregateProofCryptoGas(tc.count)
		require.NoError(t, err)
		require.Equal(t, tc.gas, gas)
		ctx := sdk.Context{}.WithGasMeter(storetypes.NewGasMeter(gas))
		require.NoError(t, PrepayAggregateProofCrypto(ctx, tc.count))
		require.Equal(t, gas, ctx.GasMeter().GasConsumed())
		require.Panics(t, func() {
			_ = PrepayAggregateProofCrypto(ctx.WithGasMeter(storetypes.NewGasMeter(gas-1)), tc.count)
		})
	}
	for _, count := range []uint64{0, 65, math.MaxUint64} {
		_, err := AggregateProofCryptoGas(count)
		require.Error(t, err)
	}
}

func TestWholeLivenessListAdmittedBeforeCrypto(t *testing.T) {
	p := admissionProof()
	deal := types.Deal{WitnessMdus: 1, TotalMdus: 3, Size_: 1 << 20, ManifestRoot: make([]byte, 32)}
	receipt := types.RetrievalReceipt{DealId: 7, EpochId: 1, Provider: "provider", FilePath: "f", RangeLen: 1024, BytesServed: 1024, ProofDetails: p}
	receipts := []types.RetrievalReceipt{receipt, receipt, receipt}
	msg := &types.MsgProveLiveness{Creator: "provider", DealId: 7, EpochId: 1, ProofType: &types.MsgProveLiveness_UserReceiptBatch{UserReceiptBatch: &types.RetrievalReceiptBatch{Receipts: receipts}}}
	for i := range receipts {
		receipts[i].ProofDetails.MerklePath = append(p.MerklePath, make([]byte, 32))
		_, err := validateLivenessProofAdmission(deal, 64, msg)
		require.Error(t, err)
		receipts[i].ProofDetails = p
	}
	count, err := validateLivenessProofAdmission(deal, 64, msg)
	require.NoError(t, err)
	require.Equal(t, uint64(3), count)
}

func TestRetrievalRangeFitsAtomicProofSubmission(t *testing.T) {
	deal := types.Deal{WitnessMdus: 1, TotalMdus: 4}
	stripe := stripeParams{mode: 1, leafCount: 64}
	for _, count := range []uint64{1, 64} {
		_, _, err := validatePolyFSRetrievalRange(deal, stripe, 2, 0, count)
		require.NoError(t, err)
	}
	_, _, err := validatePolyFSRetrievalRange(deal, stripe, 2, 0, 65)
	require.ErrorContains(t, err, "proof count must be 1..64")
}

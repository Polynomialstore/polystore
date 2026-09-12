package keeper_test

import (
	"crypto/sha256"
	"fmt"
	"maps"
	"testing"

	"cosmossdk.io/math"
	storetypes "cosmossdk.io/store/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"

	"polystorechain/pkg/retrievalchallenge"
	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/types"
)

// A matched production-valid single obligation, not N one-proof sessions. The
// largest fixture has 128 global samples and 16 samples for each of eight slots.
// 32/64 same-slot proofs are envelope limits, not typical V3 sample partitions.
// Fixture construction, proof generation and the already-committed owner ACK
// are outside the measured verification/settlement operation.
func sameObligationFixtureV3(tb testing.TB, count int) (cryptoSessionV3Fixture, sdk.Context, *types.MsgSubmitRetrievalSessionProofV3, *types.MsgSubmitRetrievalSessionProofBatchV3) {
	tb.Helper()
	require.Contains(tb, []int{1, 2, 8, 16}, count)
	f := openCryptoSessionV3(tb, 1024)
	users := uint64((count + 7) / 8)
	roots := make(map[uint64][]byte, users)
	for user := uint64(0); user < users; user++ {
		roots[2+user] = f.mduRoot
	}
	_, mdu0 := benchBuildPolyFSMdu0(tb, roots)
	root, err := crypto_ffi.ComputeMduMerkleRoot(mdu0)
	require.NoError(tb, err)
	deal, err := f.g.fixture.keeper.Deals.Get(f.g.ctx, f.g.deal.Id)
	require.NoError(tb, err)
	deal.ManifestRoot = root
	deal.Size_ = users * 64 * retrievalchallenge.DataBlobPayloadBytes
	deal.TotalMdus = 2 + users
	deal.EscrowBalance = math.NewInt(1_000_000)
	require.NoError(tb, f.g.fixture.keeper.Deals.Set(f.g.ctx, deal.Id, deal))
	f.g.bank.moduleBalances[types.ModuleName] = sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 1_000_000))
	admitted, err := f.g.fixture.keeper.AdmittedDealGenerationsV3.Get(f.g.ctx, deal.Id)
	require.NoError(tb, err)
	admitted.PolyfsRoot, admitted.Size_, admitted.TotalMdus = root, deal.Size_, deal.TotalMdus
	admitted.UserMdus = users
	admitted.IntegrityLeafCount = users * retrievalchallenge.IntegrityLeavesPerUserMDU
	require.NoError(tb, f.g.fixture.keeper.AdmittedDealGenerationsV3.Set(f.g.ctx, deal.Id, admitted))
	length := uint64(count*8) * retrievalchallenge.DataBlobPayloadBytes
	if count == 1 {
		length = 1024
	}
	opened, err := f.g.server.OpenRetrievalSessionV3(f.g.ctx, &types.MsgOpenRetrievalSessionV3{
		Creator: f.g.owner, DealId: deal.Id, Generation: deal.CurrentGen,
		Range: types.RetrievalRangeV3{FileRecordIndex: 1, FileLength: length, RangeLength: length},
		Nonce: 2, DeadlineHeight: 20,
	})
	require.NoError(tb, err)
	anchorHash := sha256.Sum256([]byte("v3-same-obligation-comparator"))
	anchor := f.g.ctx.WithBlockHeight(3).WithHeaderHash(anchorHash[:])
	require.NoError(tb, f.g.fixture.keeper.BeginBlock(anchor))
	ctx := anchor.WithBlockHeight(4)
	f.session, err = f.g.fixture.keeper.RetrievalSessionsV3.Get(ctx, opened.SessionId)
	require.NoError(tb, err)
	storedAnchor, err := f.g.fixture.keeper.ChallengeAnchors.Get(ctx, f.session.AnchorHeight)
	require.NoError(tb, err)
	seed, err := challengeContextV3(tb, f.session).Seed(storedAnchor.Seed)
	require.NoError(tb, err)
	challenges, err := challengeContextV3(tb, f.session).Challenges(seed[:])
	require.NoError(tb, err)
	proofs := make([]types.RetrievalSampleProofV3, 0, count)
	for _, challenge := range challenges {
		if challenge.Slot != 0 {
			continue
		}
		f.rootDU, f.rootDUPath, f.rootOpening = benchMdu0RootTableProof(tb, mdu0, challenge.MDUIndex, f.mduRoot)
		proofs = append(proofs, f.proof(tb, challenge))
	}
	require.Len(tb, proofs, count)
	// Model the committed ACK identically for both routes. ACK authorization and
	// transaction ordering are covered by the lifecycle tests, not this timer.
	f.session.AckedSlotsMask = 1
	require.NoError(tb, f.g.fixture.keeper.RetrievalSessionsV3.Set(ctx, f.session.SessionId, f.session))
	single := &types.MsgSubmitRetrievalSessionProofV3{Creator: f.session.Obligations[0].AssignedProvider, SessionId: f.session.SessionId, Slot: 0, Proofs: proofs}
	batch := &types.MsgSubmitRetrievalSessionProofBatchV3{Creator: single.Creator, Sessions: []types.RetrievalSessionProofBatchEntryV3{{SessionId: single.SessionId, Slot: single.Slot, Proofs: single.Proofs}}}
	return f, ctx, single, batch
}

func cloneObligationBankV3(bank *trackingBankKeeper) trackingBankKeeper {
	return trackingBankKeeper{accountBalances: maps.Clone(bank.accountBalances), moduleBalances: maps.Clone(bank.moduleBalances)}
}

func TestRetrievalV3SameObligationAggregateMatchesIndependent(t *testing.T) {
	for _, count := range []int{1, 2, 8, 16} {
		t.Run(fmt.Sprintf("proofs=%d", count), func(t *testing.T) {
			f, independent, single, _ := sameObligationFixtureV3(t, count)
			other, aggregate, otherSingle, batch := sameObligationFixtureV3(t, count)
			require.Equal(t, single, otherSingle)
			independent = independent.WithGasMeter(storetypes.NewInfiniteGasMeter())
			want, err := f.g.server.SubmitRetrievalSessionProofV3(independent, single)
			require.NoError(t, err)
			require.True(t, want.Settled)
			aggregate = aggregate.WithGasMeter(storetypes.NewInfiniteGasMeter())
			got, err := other.g.server.SubmitRetrievalSessionProofBatchV3(aggregate, batch)
			require.NoError(t, err)
			require.Equal(t, []types.MsgSubmitRetrievalSessionProofV3Response{*want}, got.Results)
			require.Equal(t, sessionStoreSnapshot(t, independent, f.g.fixture.storeService), sessionStoreSnapshot(t, aggregate, other.g.fixture.storeService))
			require.Equal(t, *f.g.bank, *other.g.bank)
			require.Equal(t, independent.EventManager().Events(), aggregate.EventManager().Events())
			require.Less(t, aggregate.GasMeter().GasConsumed(), independent.GasMeter().GasConsumed())
			t.Logf("proofs=%d independent_keeper_gas=%d aggregate_keeper_gas=%d independent_message_bytes=%d aggregate_message_bytes=%d", count, independent.GasMeter().GasConsumed(), aggregate.GasMeter().GasConsumed(), single.Size(), batch.Size())
		})
	}
}

func BenchmarkRetrievalV3SameObligationSettlement(b *testing.B) {
	for _, count := range []int{1, 2, 8, 16} {
		b.Run(fmt.Sprintf("proofs=%d", count), func(b *testing.B) {
			f, ctx, single, batch := sameObligationFixtureV3(b, count)
			bank := cloneObligationBankV3(f.g.bank)
			for _, aggregate := range []bool{false, true} {
				name := "independent"
				messageBytes := single.Size()
				if aggregate {
					name, messageBytes = "aggregate", batch.Size()
				}
				b.Run(name, func(b *testing.B) {
					b.ReportAllocs()
					b.ResetTimer()
					b.StopTimer()
					var gas uint64
					for i := 0; i < b.N; i++ {
						*f.g.bank = cloneObligationBankV3(&bank)
						run, _ := ctx.CacheContext()
						run = run.WithGasMeter(storetypes.NewInfiniteGasMeter())
						b.StartTimer()
						var result *types.MsgSubmitRetrievalSessionProofV3Response
						var err error
						if aggregate {
							var results *types.MsgSubmitRetrievalSessionProofBatchV3Response
							results, err = f.g.server.SubmitRetrievalSessionProofBatchV3(run, batch)
							if err == nil {
								result = &results.Results[0]
							}
						} else {
							result, err = f.g.server.SubmitRetrievalSessionProofV3(run, single)
						}
						b.StopTimer()
						require.NoError(b, err)
						require.True(b, result.Settled)
						require.EqualValues(b, count, result.NewlyAccepted)
						gas = run.GasMeter().GasConsumed()
					}
					b.ReportMetric(float64(gas), "keeper_gas/op")
					b.ReportMetric(float64(messageBytes), "message_B")
					b.ReportMetric(float64(count), "proofs/op")
					b.ReportMetric(float64(b.N)/b.Elapsed().Seconds(), "obligations/s")
				})
			}
		})
	}
}

package keeper_test

import (
	"fmt"
	"runtime"
	"testing"

	"cosmossdk.io/collections"
	storetypes "cosmossdk.io/store/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	moduletestutil "github.com/cosmos/cosmos-sdk/types/module/testutil"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	"github.com/stretchr/testify/require"

	"polystorechain/x/polystorechain/keeper"
	module "polystorechain/x/polystorechain/module"
	"polystorechain/x/polystorechain/types"
)

// BenchmarkRetrievalV3Completion uses an identical fixture on base and candidate.
// Real nonconstant proof generation is setup-only. Every timed iteration starts
// from the same parent state and discards its SDK cache, including bank effects.
// This is keeper transition cost, not transport, disk commit or service capacity.
// Cache creation, request literal allocation and the gas-meter read are timed;
// fixture generation, assertions and reference/state observations are not.
func BenchmarkRetrievalV3Completion(b *testing.B) {
	for _, phase := range []string{"ack_after_proof", "singleton_after_ack", "batch_after_ack", "expiry_after_completion"} {
		for _, count := range []int{1, 8} {
			if phase == "singleton_after_ack" && count != 1 {
				continue
			}
			b.Run(fmt.Sprintf("%s/sessions=%d", phase, count), func(b *testing.B) {
				f, ctx, sessions, samples := openCryptoSessionV3Batch(b, count)
				bank := newSessionCacheBank(b, f.g.fixture.storeService)
				require.NoError(b, bank.balances.Set(ctx, "module/"+types.ModuleName, "1000000"))
				enc := moduletestutil.MakeTestEncodingConfig(module.AppModule{})
				k := keeper.NewKeeper(f.g.fixture.storeService, enc.Codec, f.g.fixture.addressCodec, authtypes.NewModuleAddress(types.GovModuleName), bank, MockAccountKeeper{})
				server := keeper.NewMsgServerImpl(k)
				batch := batchProofMessageV3(f.g.providers[0], sessions, samples)
				acks := make([]*types.MsgAcknowledgeRetrievalObligationV3, count)
				for i, s := range sessions {
					acks[i] = &types.MsgAcknowledgeRetrievalObligationV3{Creator: f.g.owner, SessionId: s.SessionId, Slot: 0, AckDigest: ackDigestV3(b, s, 0)}
				}
				if phase == "ack_after_proof" || phase == "expiry_after_completion" {
					_, err := server.SubmitRetrievalSessionProofBatchV3(ctx, batch)
					require.NoError(b, err)
				}
				if phase != "ack_after_proof" {
					for _, ack := range acks {
						_, err := server.AcknowledgeRetrievalObligationV3(ctx, ack)
						require.NoError(b, err)
					}
				}
				if phase == "expiry_after_completion" {
					ctx = ctx.WithBlockHeight(21)
				}
				for _, s := range sessions {
					before, err := k.RetrievalSessionsV3.Get(ctx, s.SessionId)
					require.NoError(b, err)
					if phase == "ack_after_proof" {
						require.Zero(b, before.AckedSlotsMask)
					} else if phase != "expiry_after_completion" {
						require.Zero(b, before.AcceptedSampleBitmap[0]&1)
					}
				}
				var gas uint64
				var last sdk.Context
				var proofResult *types.MsgSubmitRetrievalSessionProofV3Response
				var batchResult *types.MsgSubmitRetrievalSessionProofBatchV3Response
				b.ReportAllocs()
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					run, _ := ctx.CacheContext()
					run = run.WithGasMeter(storetypes.NewInfiniteGasMeter())
					switch phase {
					case "ack_after_proof":
						for _, ack := range acks {
							if _, err := server.AcknowledgeRetrievalObligationV3(run, ack); err != nil {
								b.Fatal(err)
							}
						}
					case "singleton_after_ack":
						var err error
						proofResult, err = server.SubmitRetrievalSessionProofV3(run, &types.MsgSubmitRetrievalSessionProofV3{
							Creator: f.g.providers[0], SessionId: sessions[0].SessionId, Slot: 0, Proofs: []types.RetrievalSampleProofV3{samples[0]},
						})
						if err != nil {
							b.Fatal(err)
						}
					case "batch_after_ack":
						var err error
						batchResult, err = server.SubmitRetrievalSessionProofBatchV3(run, batch)
						if err != nil {
							b.Fatal(err)
						}
					case "expiry_after_completion":
						if err := k.BeginBlock(run); err != nil {
							b.Fatal(err)
						}
					}
					gas = run.GasMeter().GasConsumed()
					last = run
				}
				b.StopTimer()
				if proofResult != nil {
					require.True(b, proofResult.Settled)
					require.Equal(b, uint32(1), proofResult.NewlyAccepted)
				}
				if batchResult != nil {
					require.Len(b, batchResult.Results, count)
					for _, result := range batchResult.Results {
						require.True(b, result.Settled)
						require.Equal(b, uint32(1), result.NewlyAccepted)
					}
				}
				terminalRows := 0
				for _, s := range sessions {
					stored, err := k.RetrievalSessionsV3.Get(last, s.SessionId)
					require.NoError(b, err)
					require.Equal(b, uint32(1), stored.SettledSlotsMask)
					require.Equal(b, uint32(1), stored.AckedSlotsMask)
					require.Equal(b, byte(1), stored.AcceptedSampleBitmap[0]&1)
					// Raw additive key allows the identical harness to run on the base
					// without introducing any candidate production collection there.
					marker, err := f.g.fixture.storeService.OpenKVStore(last).Get(append([]byte("RetrievalSessionV3TerminalAnchors/value/"), s.SessionId...))
					require.NoError(b, err)
					if len(marker) != 0 {
						require.Len(b, marker, 32)
						terminalRows++
					}
				}
				require.True(b, terminalRows == 0 || terminalRows == count)
				expectedLive := uint64(count - terminalRows)
				if phase == "expiry_after_completion" {
					expectedLive = 0
				}
				live, err := k.RetrievalSessionLiveCount.Get(last)
				require.NoError(b, err)
				require.Equal(b, expectedLive, live)
				refs, err := k.RetrievalSessionGenerationRefs.Get(last, collections.Join(sessions[0].DealId, sessions[0].Generation))
				if expectedLive == 0 {
					require.ErrorIs(b, err, collections.ErrNotFound)
				} else {
					require.NoError(b, err)
					require.Equal(b, expectedLive, refs)
				}
				b.ReportMetric(float64(terminalRows), "terminal_rows/op")
				runtime.GC()
				var memory runtime.MemStats
				runtime.ReadMemStats(&memory)
				runtime.KeepAlive(f)
				runtime.KeepAlive(last)
				// Whole-process Go heap with the fixture and last cache alive;
				// excludes native allocations and is not per-transition B/op.
				b.ReportMetric(float64(memory.HeapAlloc), "process_live_heap_bytes")
				b.ReportMetric(float64(memory.HeapSys), "process_reserved_heap_bytes")
				b.ReportMetric(float64(gas), "gas/op")
				b.ReportMetric(float64(count), "sessions/op")
			})
		}
	}
}

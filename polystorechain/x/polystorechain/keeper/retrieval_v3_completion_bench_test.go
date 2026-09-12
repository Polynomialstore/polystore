package keeper_test

import (
	"fmt"
	"testing"

	storetypes "cosmossdk.io/store/types"
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
				var gas uint64
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
						_, err := server.SubmitRetrievalSessionProofV3(run, &types.MsgSubmitRetrievalSessionProofV3{
							Creator: f.g.providers[0], SessionId: sessions[0].SessionId, Slot: 0, Proofs: []types.RetrievalSampleProofV3{samples[0]},
						})
						if err != nil {
							b.Fatal(err)
						}
					case "batch_after_ack":
						if _, err := server.SubmitRetrievalSessionProofBatchV3(run, batch); err != nil {
							b.Fatal(err)
						}
					case "expiry_after_completion":
						if err := k.BeginBlock(run); err != nil {
							b.Fatal(err)
						}
					}
					gas = run.GasMeter().GasConsumed()
				}
				b.StopTimer()
				b.ReportMetric(float64(gas), "gas/op")
				b.ReportMetric(float64(count), "sessions/op")
			})
		}
	}
}

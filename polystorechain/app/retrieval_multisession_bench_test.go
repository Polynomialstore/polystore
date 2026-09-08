package app

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"sync"
	"testing"
	"time"

	sdktx "github.com/cosmos/cosmos-sdk/types/tx"
	"github.com/stretchr/testify/require"

	"polystorechain/x/polystorechain/keeper"
)

// Use separate, quiet processes for each N (and RSS measurement):
//
//	POLYSTORE_RETRIEVAL_BENCH_SESSIONS=8 GOMAXPROCS=2 ./scripts/chain_go.sh test -p 2 ./app \
//	  -run '^$' -bench '^BenchmarkRetrievalNativeTransactions/N8/(separate|batched)$' \
//	  -benchtime=3x -count=1 -benchmem
//
// N is 1, 8, 32 or 64 distinct-owner/deal, one-proof sessions. The maintained K8
// witness, trusted setup, fresh C2 proof generation, signed owner opens/ACKs and
// committed database snapshot are prepared outside timing. Every iteration
// reloads a private copy of that same IAVL database at height 3. Cosmos DB uses
// MemDB here: this measures real IAVL commits, without filesystem fsync. The
// native setup remains warm in the process throughout the comparison. Timing covers
// actual SDK signing/encoding plus production FinalizeBlock and Commit at H4;
// both modes put all transactions in one block. Network and block-wait latency,
// provider bbolt storage, setup/load time and native proof generation are excluded.
//
// pending-json-B is the serialized proof working set, not heap/RSS. Measure
// process high-water RSS separately using the compiled test binary (e.g.
// /usr/bin/time -l on macOS); that peak includes untimed fixture preparation.
// Do not interpret Go B/op as native-library or process peak memory.
var retrievalNativeBenchmark struct {
	sync.Once
	fixture *retrievalNativeFixture
	count   int
}

func BenchmarkRetrievalNativeTransactions(b *testing.B) {
	count := 1
	if value := os.Getenv("POLYSTORE_RETRIEVAL_BENCH_SESSIONS"); value != "" {
		parsed, err := strconv.Atoi(value)
		require.NoError(b, err)
		count = parsed
	}
	require.Contains(b, []int{1, 8, 32, 64}, count)
	retrievalNativeBenchmark.Do(func() {
		retrievalNativeBenchmark.fixture = newRetrievalNativeFixture(b, count)
		retrievalNativeBenchmark.count = count
	})
	require.Equal(b, retrievalNativeBenchmark.count, count, "select N in a fresh process")
	f := retrievalNativeBenchmark.fixture
	pending, err := json.Marshal(map[string]any{"sessions": f.proofs})
	require.NoError(b, err)
	var messageBytes int
	for _, msg := range f.proofs {
		messageBytes += msg.Size()
	}
	for _, mode := range []string{"separate", "batched"} {
		b.Run(fmt.Sprintf("N%d/%s", count, mode), func(b *testing.B) {
			b.ReportAllocs()
			b.StopTimer()
			var gas, transactionBytes, signatureBytes, transactionCount uint64
			var calls int64
			var elapsed, signEncode time.Duration
			for i := 0; i < b.N; i++ {
				a := f.restore(b)
				b.StartTimer()
				result := f.submit(b, a, count, mode == "batched")
				b.StopTimer()
				gas += f.assertCompleted(b, a, count, result)
				calls += result.ffiCalls
				elapsed += result.elapsed
				signEncode += result.signEncode
				transactionCount += uint64(len(result.txs))
				for _, encoded := range result.txs {
					transactionBytes += uint64(len(encoded))
					var raw sdktx.TxRaw
					require.NoError(b, raw.Unmarshal(encoded))
					for _, signature := range raw.Signatures {
						signatureBytes += uint64(len(signature))
					}
				}
				require.NoError(b, a.Close())
			}
			operations := float64(b.N)
			sessions := operations * float64(count)
			b.ReportMetric(float64(gas)/sessions, "gas/session")
			b.ReportMetric(float64(gas)/sessions-float64(keeper.ProofCryptoGas), "other-gas/session")
			b.ReportMetric(float64(transactionCount)/operations, "txs/op")
			b.ReportMetric(float64(transactionBytes)/operations, "tx-bytes/op")
			b.ReportMetric(float64(transactionBytes)/operations-float64(messageBytes), "envelope-B/op")
			b.ReportMetric(float64(signatureBytes)/operations, "signature-B/op")
			b.ReportMetric(float64(calls)/operations, "ffi-calls/op")
			b.ReportMetric(float64(signEncode.Nanoseconds())/sessions, "sign-encode-ns/session")
			b.ReportMetric(float64(elapsed.Nanoseconds())/sessions, "ns/session")
			b.ReportMetric(sessions/elapsed.Seconds(), "sessions/s")
			b.ReportMetric(float64(len(pending)), "pending-json-B")
			b.ReportMetric(0, "failures/op") // any nonzero transaction code fails the benchmark.
		})
	}
}

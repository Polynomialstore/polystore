package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/gorilla/mux"
)

type discardRetrievalResponseV3 struct {
	header http.Header
	status int
	bytes  int
}

func (w *discardRetrievalResponseV3) Header() http.Header    { return w.header }
func (w *discardRetrievalResponseV3) WriteHeader(status int) { w.status = status }
func (w *discardRetrievalResponseV3) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	w.bytes += len(p)
	return len(p), nil
}

// Full public provider handler, not prepareRetrievalDataV3 alone. The LCD uses
// loopback HTTP; key CLI dispatch is stubbed and response writes are discarded.
// This diagnoses route phases/allocations, NOT paid-download throughput.
func BenchmarkRetrievalV3PublicRouteAttribution(b *testing.B) {
	for _, size := range []uint64{1024, 2 * RawMduCapacity} {
		b.Run(fmt.Sprintf("logical_%d", size), func(b *testing.B) {
			frozen, key, dir, request := diagnosticDataRouteFixtureV3(b, size)
			b.Setenv("POLYSTORE_RETRIEVAL_DIAGNOSTICS", "1")
			b.Setenv("POLYSTORE_PROVIDER_ADDRESS", "")
			previousLog := log.Writer()
			log.SetOutput(io.Discard)
			b.Cleanup(func() { log.SetOutput(previousLog) })
			for _, state := range []string{"cold_metadata_index", "warm"} {
				b.Run(state, func(b *testing.B) {
					b.ReportAllocs()
					var totals [retrievalPhaseCountV3]retrievalPhaseMeasurementV3
					var chunks, responseBytes uint64
					run := func(count bool) {
						for mdu := key.Metadata; mdu < key.Metadata+key.Users; mdu++ {
							for _, obligation := range frozen.Session.Obligations {
								if _, err := frozenRetrievalDataChunkV3(frozen, ManifestRoot{Bytes: key.Root}, mdu, key.Deal, frozen.Session.Owner, obligation.Slot); err != nil {
									continue
								}
								signer := obligation.Payee
								mockCombinedOutput = func(context.Context, string, ...string) ([]byte, error) { return []byte(signer), nil }
								d := &retrievalDiagnosticsV3{now: time.Now}
								r := request(context.WithValue(context.Background(), retrievalDiagnosticsKeyV3{}, d))
								index := strconv.FormatUint(mdu, 10)
								vars := mux.Vars(r)
								vars["index"] = index
								r.URL.Path = "/sp/retrieval/mdu/" + vars["cid"] + "/" + index
								r.Header.Set("X-PolyStore-Slot", strconv.FormatUint(uint64(obligation.Slot), 10))
								w := &discardRetrievalResponseV3{header: make(http.Header)}
								GatewayMdu(w, r)
								if w.status != http.StatusOK {
									b.Fatalf("route failed: status=%d", w.status)
								}
								if count {
									chunks++
									responseBytes += uint64(w.bytes)
									for i, phase := range d.phases {
										totals[i].Calls += phase.Calls
										totals[i].Time += phase.Time
									}
								}
							}
						}
					}
					if state == "warm" {
						run(false)
					}
					b.ResetTimer()
					for i := 0; i < b.N; i++ {
						if state == "cold_metadata_index" {
							b.StopTimer()
							retrievalMetadataCache.Lock()
							delete(retrievalMetadataCache.entries, key)
							// Each iteration removes only this benchmark fixture's
							// rebuildable index; OS page caches are NOT dropped.
							retrievalMetadataCache.Unlock()
							if err := os.Remove(filepath.Join(dir, integrityIndexV3File)); err != nil && !os.IsNotExist(err) {
								b.Fatal(err)
							}
							b.StartTimer()
						}
						run(true)
					}
					b.StopTimer()
					b.ReportMetric(float64(chunks)/float64(b.N), "chunks/op")
					b.ReportMetric(float64(responseBytes)/float64(b.N), "wire-B/op")
					for i, phase := range totals {
						if phase.Calls != 0 {
							b.ReportMetric(float64(phase.Calls)/float64(b.N), retrievalPhaseNamesV3[i]+"-calls/op")
							b.ReportMetric(float64(phase.Time.Nanoseconds())/float64(b.N), retrievalPhaseNamesV3[i]+"-ns/op")
						}
					}
				})
			}
		})
	}
}

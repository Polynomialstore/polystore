package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestSubmitTxRequiresMatchingCommittedResponse(t *testing.T) {
	hash := strings.Repeat("A", 64)
	for _, body := range []string{
		`{}`, `null`, `{"tx_response":null}`, `{"tx_response":{}}`,
		fmt.Sprintf(`{"tx_response":{"txhash":"%s","height":"0","code":0}}`, hash),
		fmt.Sprintf(`{"tx_response":{"txhash":"%s","height":"1"}}`, hash),
		fmt.Sprintf(`{"tx_response":{"txhash":"%s","height":"1","code":null}}`, hash),
		fmt.Sprintf(`{"tx_response":{"txhash":"%s","height":"1","code":"0"}}`, hash),
		fmt.Sprintf(`{"tx_response":{"txhash":"%s","height":"1","code":0.0}}`, hash),
		fmt.Sprintf(`{"tx_response":{"txhash":"%s","height":"1","code":0,"code":0}}`, hash),
		fmt.Sprintf(`{"tx_response":{"txhash":"%s","height":"1","code":0}}`, strings.Repeat("B", 64)),
		fmt.Sprintf(`{"tx_response":{"txhash":"%s","height":"1","code":9,"Code":0}}`, hash),
		fmt.Sprintf(`{"tx_response":{"txhash":"%s","height":"1","code":0},"txResponse":{}}`, hash),
		`{"tx_response":`,
	} {
		t.Run(body, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, body) }))
			defer srv.Close()
			old := lcdBase
			lcdBase = srv.URL
			defer func() { lcdBase = old }()
			setupMockCombinedOutput(t, func(context.Context, string, ...string) ([]byte, error) {
				return []byte(fmt.Sprintf(`{"txhash":"%s","code":0}`, strings.ToLower(hash))), nil
			})
			persisted := ""
			got, err := submitTxAndRecord(context.Background(), func(h string) error { persisted = h; return nil })
			if got != hash || persisted != hash || !errors.Is(err, errTxPending) {
				t.Fatalf("unsafe outcome hash=%q persisted=%q error=%v", got, persisted, err)
			}
		})
	}
}

func TestTxObservationDelayedFailureAndCancellation(t *testing.T) {
	hash := strings.Repeat("A", 64)
	for _, code := range []int{0, 9} {
		t.Run(fmt.Sprint(code), func(t *testing.T) {
			var calls atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if calls.Add(1) == 1 {
					w.WriteHeader(404)
					return
				}
				fmt.Fprintf(w, `{"tx_response":{"txhash":"%s","height":"9007199254740993","code":%d}}`, strings.ToLower(hash), code)
			}))
			defer srv.Close()
			old := lcdBase
			lcdBase = srv.URL
			defer func() { lcdBase = old }()
			got, err := waitForCommittedTx(context.Background(), hash)
			if got != hash || (code == 0 && err != nil) || (code != 0 && !errors.Is(err, errTxFailed)) {
				t.Fatal(got, err)
			}
		})
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	got, err := waitForCommittedTx(ctx, hash)
	if got != hash || !errors.Is(err, context.Canceled) || !errors.Is(err, errTxPending) || time.Since(start) > time.Second {
		t.Fatal("cancellation lost hash or blocked", got, err)
	}
}

func TestTxBroadcastPreservesHashOnCommandAndPersistenceFailure(t *testing.T) {
	hash := strings.Repeat("A", 64)
	for _, tc := range []struct {
		name                   string
		code                   int
		commandErr, errorStore bool
	}{
		{"command", 0, true, false}, {"persistence", 0, false, true}, {"rejected", 32, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			setupMockCombinedOutput(t, func(context.Context, string, ...string) ([]byte, error) {
				out := []byte(fmt.Sprintf(`{"txhash":"%s","code":%d}`, hash, tc.code))
				if tc.commandErr {
					return out, context.Canceled
				}
				return out, nil
			})
			called := false
			got, err := submitTxAndRecord(context.Background(), func(string) error {
				called = true
				if tc.errorStore {
					return fmt.Errorf("DB closed")
				}
				return nil
			})
			want := errTxPending
			if tc.code != 0 {
				want = errTxRejected
			}
			if got != hash || !errors.Is(err, want) || called != (tc.code == 0) {
				t.Fatal(got, err, called)
			}
		})
	}
}

func TestTxObservationBoundsAndDeadline(t *testing.T) {
	hash := strings.Repeat("A", 64)
	for _, mode := range []string{"oversized", "truncated", "deadline"} {
		t.Run(mode, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch mode {
				case "oversized":
					fmt.Fprint(w, strings.Repeat(" ", maxCommittedTxResponseBytes+1))
				case "truncated":
					w.Header().Set("Content-Length", "1000")
					fmt.Fprint(w, `{"tx_response":`)
				case "deadline":
					w.WriteHeader(404)
				}
			}))
			defer server.Close()
			old := lcdBase
			lcdBase = server.URL
			defer func() { lcdBase = old }()
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancel()
			got, err := waitForCommittedTx(ctx, hash)
			if got != hash || !errors.Is(err, errTxPending) {
				t.Fatal("unsafe bounded observation", got, err)
			}
			if mode == "deadline" && !errors.Is(err, context.DeadlineExceeded) {
				t.Fatal(err)
			}
		})
	}
}

func TestTxRetryRequiresExplicitSequenceRejection(t *testing.T) {
	hash := strings.Repeat("A", 64)
	for _, body := range []string{
		fmt.Sprintf(`{"txhash":%q,"code":0,"raw_log":"account sequence mismatch"}`, hash),
		`account sequence mismatch`,
		fmt.Sprintf(`{"txhash":%q,"code":32,"codespace":"another-module"}`, hash),
		fmt.Sprintf(`{"txhash":%q,"code":0,"Code":32,"codespace":"sdk"}`, hash),
	} {
		calls := 0
		setupMockCombinedOutput(t, func(context.Context, string, ...string) ([]byte, error) { calls++; return []byte(body), nil })
		_, _ = runTxWithRetry(context.Background())
		if calls != 1 {
			t.Fatal("ambiguous/accepted broadcast replayed", body, calls)
		}
	}
	calls := 0
	setupMockCombinedOutput(t, func(context.Context, string, ...string) ([]byte, error) {
		calls++
		code := 32
		if calls == 2 {
			code = 0
		}
		return []byte(fmt.Sprintf(`{"txhash":%q,"code":%d,"codespace":"sdk"}`, hash, code)), nil
	})
	_, err := runTxWithRetry(context.Background())
	if err != nil || calls != 2 {
		t.Fatal("explicit rejected sequence did not retry", calls, err)
	}
}

package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestCurrentEpochID_UsesLCDHeightAndParams(t *testing.T) {
	// Uses process-global lcdBase/cache state; keep this test serial to avoid
	// cross-test interference from other parallel tests that also tweak globals.

	var height atomic.Uint64
	height.Store(1)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/nilchain/nilchain/v1/params"):
			_, _ = w.Write([]byte(`{"params":{"epoch_len_blocks":"100"}}`))
		case strings.HasSuffix(r.URL.Path, "/cosmos/base/tendermint/v1beta1/blocks/latest"):
			_, _ = w.Write([]byte(`{"block":{"header":{"height":"` + itoa(height.Load()) + `"}}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	oldLCD := lcdBase
	lcdBase = srv.URL
	t.Cleanup(func() { lcdBase = oldLCD })

	resetEpochTestCache()

	got := currentEpochID(context.Background())
	if got != 1 {
		t.Fatalf("expected epoch 1, got %d", got)
	}

	height.Store(101)
	resetEpochTestCacheHeightOnly()
	got = currentEpochID(context.Background())
	if got != 2 {
		t.Fatalf("expected epoch 2, got %d", got)
	}
}

func resetEpochTestCache() {
	epochCacheMu.Lock()
	defer epochCacheMu.Unlock()
	epochCacheLCDBase = ""
	epochLenBlocksCached = 0
	epochLenBlocksFetched = time.Time{}
	latestHeightCached = 0
	latestHeightFetched = time.Time{}
}

func resetEpochTestCacheHeightOnly() {
	epochCacheMu.Lock()
	defer epochCacheMu.Unlock()
	latestHeightCached = 0
	latestHeightFetched = time.Time{}
}

func itoa(v uint64) string {
	// Avoid importing strconv just for tests (main already imports it heavily).
	const digits = "0123456789"
	if v == 0 {
		return "0"
	}
	var buf [32]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = digits[v%10]
		v /= 10
	}
	return string(buf[i:])
}

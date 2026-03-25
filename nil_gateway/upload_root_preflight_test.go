package main

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestValidateNilfsUploadPreviousManifestRoot_CachesSequentialHits(t *testing.T) {
	resetNilfsUploadRootPreflightCacheForTest()
	clearDealMetaCache()
	t.Cleanup(resetNilfsUploadRootPreflightCacheForTest)
	t.Cleanup(clearDealMetaCache)

	origTTL := nilfsUploadRootPreflightCacheTTL
	nilfsUploadRootPreflightCacheTTL = time.Minute
	t.Cleanup(func() { nilfsUploadRootPreflightCacheTTL = origTTL })

	currentRoot := mustTestManifestRoot(t, "upload-root-preflight-cache-current")
	nextRoot := mustTestManifestRoot(t, "upload-root-preflight-cache-next")

	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"deal":{"owner":"nil1owner","manifest_root":"` + currentRoot.Canonical + `"}}`))
	}))
	defer srv.Close()

	oldLCD := lcdBase
	lcdBase = srv.URL
	t.Cleanup(func() { lcdBase = oldLCD })

	for i := 0; i < 2; i += 1 {
		if err := validateNilfsUploadPreviousManifestRoot(t.Context(), 7, nextRoot.Canonical, currentRoot.Canonical); err != nil {
			t.Fatalf("validate call %d failed: %v", i, err)
		}
	}

	if got := hits.Load(); got != 1 {
		t.Fatalf("expected 1 LCD fetch after cache hit, got %d", got)
	}
}

func TestValidateNilfsUploadPreviousManifestRoot_SingleflightConcurrentHits(t *testing.T) {
	resetNilfsUploadRootPreflightCacheForTest()
	clearDealMetaCache()
	t.Cleanup(resetNilfsUploadRootPreflightCacheForTest)
	t.Cleanup(clearDealMetaCache)

	origTTL := nilfsUploadRootPreflightCacheTTL
	nilfsUploadRootPreflightCacheTTL = time.Minute
	t.Cleanup(func() { nilfsUploadRootPreflightCacheTTL = origTTL })

	currentRoot := mustTestManifestRoot(t, "upload-root-preflight-sf-current")
	nextRoot := mustTestManifestRoot(t, "upload-root-preflight-sf-next")

	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		time.Sleep(25 * time.Millisecond)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"deal":{"owner":"nil1owner","manifest_root":"` + currentRoot.Canonical + `"}}`))
	}))
	defer srv.Close()

	oldLCD := lcdBase
	lcdBase = srv.URL
	t.Cleanup(func() { lcdBase = oldLCD })

	const workers = 8
	errs := make(chan error, workers)
	var wg sync.WaitGroup
	wg.Add(workers)
	for i := 0; i < workers; i += 1 {
		go func() {
			defer wg.Done()
			errs <- validateNilfsUploadPreviousManifestRoot(t.Context(), 9, nextRoot.Canonical, currentRoot.Canonical)
		}()
	}
	wg.Wait()
	close(errs)

	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent validate failed: %v", err)
		}
	}

	if got := hits.Load(); got != 1 {
		t.Fatalf("expected singleflight to collapse to 1 LCD fetch, got %d", got)
	}
}

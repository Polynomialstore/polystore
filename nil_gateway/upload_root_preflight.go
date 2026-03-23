package main

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

const nilUploadPreviousManifestRootHeader = "X-Nil-Previous-Manifest-Root"

type nilfsUploadRootPreflightCacheKey struct {
	dealID               uint64
	manifestRoot         string
	previousManifestRoot string
}

type nilfsUploadRootPreflightCacheEntry struct {
	expiresAt time.Time
}

var (
	nilfsUploadRootPreflightCache    sync.Map
	nilfsUploadRootPreflightCacheTTL = time.Duration(envInt("NIL_UPLOAD_ROOT_PREFLIGHT_CACHE_TTL_MS", 15000)) * time.Millisecond
)

func resetNilfsUploadRootPreflightCacheForTest() {
	nilfsUploadRootPreflightCache = sync.Map{}
}

func validateNilfsUploadPreviousManifestRoot(
	ctx context.Context,
	dealID uint64,
	manifestRoot string,
	rawPreviousManifestRoot string,
) error {
	previousManifestRoot, err := parseManifestRootOrEmpty(rawPreviousManifestRoot)
	if err != nil {
		return fmt.Errorf("invalid %s: %w", nilUploadPreviousManifestRootHeader, err)
	}
	key := nilfsUploadRootPreflightCacheKey{
		dealID:               dealID,
		manifestRoot:         normalizeManifestRootOrEmpty(manifestRoot),
		previousManifestRoot: previousManifestRoot,
	}
	if nilfsUploadRootPreflightCacheTTL > 0 {
		now := time.Now()
		if cachedAny, ok := nilfsUploadRootPreflightCache.Load(key); ok {
			if cached, ok := cachedAny.(nilfsUploadRootPreflightCacheEntry); ok && now.Before(cached.expiresAt) {
				return nil
			}
		}
	}

	meta, err := fetchDealMetaFresh(dealID)
	if err != nil {
		return err
	}
	expectedPrevious := normalizeManifestRootOrEmpty(meta.ManifestRoot)
	if expectedPrevious != previousManifestRoot {
		recordNilfsCASPreflightConflict(nilfsCASPreflightConflictUpload)
		return fmt.Errorf("stale previous_manifest_root: expected %s", expectedPrevious)
	}

	if nilfsUploadRootPreflightCacheTTL > 0 {
		nilfsUploadRootPreflightCache.Store(key, nilfsUploadRootPreflightCacheEntry{
			expiresAt: time.Now().Add(nilfsUploadRootPreflightCacheTTL),
		})
	}
	return nil
}

func uploadPreviousManifestRootHeader(r *http.Request) string {
	if r == nil {
		return ""
	}
	return strings.TrimSpace(r.Header.Get(nilUploadPreviousManifestRootHeader))
}

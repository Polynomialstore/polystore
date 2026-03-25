package main

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
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
	nilfsUploadRootPreflightGroup    singleflight.Group
)

func resetNilfsUploadRootPreflightCacheForTest() {
	nilfsUploadRootPreflightCache = sync.Map{}
	nilfsUploadRootPreflightGroup = singleflight.Group{}
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

	resultKey := fmt.Sprintf("%d|%s|%s", key.dealID, key.manifestRoot, key.previousManifestRoot)
	ch := nilfsUploadRootPreflightGroup.DoChan(resultKey, func() (any, error) {
		meta, err := fetchDealMetaFresh(dealID)
		if err != nil {
			return nil, err
		}
		expectedPrevious := normalizeManifestRootOrEmpty(meta.ManifestRoot)
		if expectedPrevious != previousManifestRoot {
			recordNilfsCASPreflightConflict(nilfsCASPreflightConflictUpload)
			return nil, fmt.Errorf("stale previous_manifest_root: expected %s", expectedPrevious)
		}

		if nilfsUploadRootPreflightCacheTTL > 0 {
			nilfsUploadRootPreflightCache.Store(key, nilfsUploadRootPreflightCacheEntry{
				expiresAt: time.Now().Add(nilfsUploadRootPreflightCacheTTL),
			})
		}
		return nil, nil
	})

	select {
	case <-ctx.Done():
		return ctx.Err()
	case res := <-ch:
		return res.Err
	}
}

func uploadPreviousManifestRootHeader(r *http.Request) string {
	if r == nil {
		return ""
	}
	return strings.TrimSpace(r.Header.Get(nilUploadPreviousManifestRootHeader))
}

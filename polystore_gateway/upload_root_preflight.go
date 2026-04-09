package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
)

const polystoreUploadPreviousManifestRootHeader = "X-PolyStore-Previous-Manifest-Root"

var errInvalidUploadPreviousManifestRoot = errors.New("invalid upload previous manifest root")

type staleUploadPreviousManifestRootError struct {
	expected string
}

func (e *staleUploadPreviousManifestRootError) Error() string {
	if e == nil {
		return "stale previous_manifest_root"
	}
	return fmt.Sprintf("stale previous_manifest_root: expected %s", e.expected)
}

type polyfsUploadRootPreflightCacheKey struct {
	dealID               uint64
	previousManifestRoot string
}

type polyfsUploadRootPreflightCacheEntry struct {
	expiresAt time.Time
}

var (
	polyfsUploadRootPreflightCache    sync.Map
	polyfsUploadRootPreflightCacheTTL = time.Duration(envInt("POLYSTORE_UPLOAD_ROOT_PREFLIGHT_CACHE_TTL_MS", 15000)) * time.Millisecond
	polyfsUploadRootPreflightGroup    singleflight.Group
)

func resetPolyfsUploadRootPreflightCacheForTest() {
	polyfsUploadRootPreflightCache = sync.Map{}
	polyfsUploadRootPreflightGroup = singleflight.Group{}
}

func validatePolyfsUploadPreviousManifestRoot(
	ctx context.Context,
	dealID uint64,
	manifestRoot string,
	rawPreviousManifestRoot string,
) error {
	_ = manifestRoot
	previousManifestRoot, err := parseManifestRootOrEmpty(rawPreviousManifestRoot)
	if err != nil {
		return fmt.Errorf("%w: %s: %v", errInvalidUploadPreviousManifestRoot, polystoreUploadPreviousManifestRootHeader, err)
	}
	key := polyfsUploadRootPreflightCacheKey{
		dealID:               dealID,
		previousManifestRoot: previousManifestRoot,
	}
	if polyfsUploadRootPreflightCacheTTL > 0 {
		now := time.Now()
		if cachedAny, ok := polyfsUploadRootPreflightCache.Load(key); ok {
			if cached, ok := cachedAny.(polyfsUploadRootPreflightCacheEntry); ok && now.Before(cached.expiresAt) {
				return nil
			}
		}
	}

	resultKey := fmt.Sprintf("%d|%s", key.dealID, key.previousManifestRoot)
	ch := polyfsUploadRootPreflightGroup.DoChan(resultKey, func() (any, error) {
		meta, err := fetchDealMetaFresh(dealID)
		if err != nil {
			return nil, err
		}
		expectedPrevious := normalizeManifestRootOrEmpty(meta.ManifestRoot)
		if expectedPrevious != previousManifestRoot {
			recordPolyfsCASPreflightConflict(polyfsCASPreflightConflictUpload)
			return nil, &staleUploadPreviousManifestRootError{expected: expectedPrevious}
		}

		if polyfsUploadRootPreflightCacheTTL > 0 {
			polyfsUploadRootPreflightCache.Store(key, polyfsUploadRootPreflightCacheEntry{
				expiresAt: time.Now().Add(polyfsUploadRootPreflightCacheTTL),
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
	return strings.TrimSpace(r.Header.Get(polystoreUploadPreviousManifestRootHeader))
}

func classifyPolyfsUploadPreviousManifestRootError(err error) int {
	switch {
	case err == nil:
		return http.StatusOK
	case errors.Is(err, errInvalidUploadPreviousManifestRoot):
		return http.StatusBadRequest
	case errors.Is(err, ErrDealNotFound):
		return http.StatusNotFound
	default:
		var staleErr *staleUploadPreviousManifestRootError
		if errors.As(err, &staleErr) {
			return http.StatusConflict
		}
		return http.StatusInternalServerError
	}
}

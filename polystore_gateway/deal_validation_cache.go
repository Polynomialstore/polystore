package main

import (
	"context"
	"errors"
	"strconv"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
)

type dealValidationCacheEntry struct {
	expiresAt time.Time
	err       error
}

type dealValidationKey struct {
	lcdBase string
	dealID  uint64
}

var dealValidationCache sync.Map // map[dealValidationKey]*dealValidationCacheEntry
var dealValidationGroup singleflight.Group

func ensureDealExistsCached(ctx context.Context, dealID uint64) error {
	if ctx == nil {
		ctx = context.Background()
	}

	key := dealValidationKey{lcdBase: lcdBase, dealID: dealID}
	if cachedAny, ok := dealValidationCache.Load(key); ok {
		cached := cachedAny.(*dealValidationCacheEntry)
		if time.Now().Before(cached.expiresAt) {
			return cached.err
		}
	}

	groupKey := key.lcdBase + "|" + strconv.FormatUint(dealID, 10)
	ch := dealValidationGroup.DoChan(groupKey, func() (any, error) {
		_, _, err := fetchDealOwnerAndCID(dealID)
		return nil, err
	})

	select {
	case <-ctx.Done():
		return ctx.Err()
	case res := <-ch:
		err := res.Err

		var ttl time.Duration
		switch {
		case err == nil:
			ttl = 2 * time.Minute
		case errors.Is(err, ErrDealNotFound):
			ttl = 5 * time.Second
		default:
			ttl = 1 * time.Second
		}

		dealValidationCache.Store(key, &dealValidationCacheEntry{
			expiresAt: time.Now().Add(ttl),
			err:       err,
		})
		return err
	}
}

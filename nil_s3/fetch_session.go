package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync"
	"time"
)

type fetchSession struct {
	DealID      uint64
	EpochID     uint64
	Owner       string
	Provider    string
	FilePath    string
	RangeStart  uint64
	RangeLen    uint64
	BytesServed uint64
	ProofHash   string
	ReqNonce    uint64
	ReqExpires  uint64
	ExpiresAt   time.Time
}

var fetchSessionCache sync.Map // map[string]fetchSession

func newFetchSessionID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

func storeFetchSession(s fetchSession) (string, error) {
	if s.ExpiresAt.IsZero() {
		return "", fmt.Errorf("session expiresAt is required")
	}
	id, err := newFetchSessionID()
	if err != nil {
		return "", err
	}
	fetchSessionCache.Store(id, s)
	return id, nil
}

// peekFetchSession loads a session without consuming it.
func peekFetchSession(id string) (fetchSession, bool) {
	if id == "" {
		return fetchSession{}, false
	}
	any, ok := fetchSessionCache.Load(id)
	if !ok {
		return fetchSession{}, false
	}
	s := any.(fetchSession)
	if !s.ExpiresAt.IsZero() && time.Now().After(s.ExpiresAt) {
		fetchSessionCache.Delete(id)
		return fetchSession{}, false
	}
	return s, true
}

// takeFetchSession atomically consumes a session so it can only be used once.
func takeFetchSession(id string) (fetchSession, bool) {
	if id == "" {
		return fetchSession{}, false
	}
	any, ok := fetchSessionCache.LoadAndDelete(id)
	if !ok {
		return fetchSession{}, false
	}
	s := any.(fetchSession)
	if !s.ExpiresAt.IsZero() && time.Now().After(s.ExpiresAt) {
		return fetchSession{}, false
	}
	return s, true
}

type requestReplayKey struct {
	DealID uint64
	Owner  string
	Nonce  uint64
}

var requestReplayCache sync.Map // map[requestReplayKey]time.Time (expiresAt)

func checkAndStoreRequestReplay(dealID uint64, owner string, nonce uint64, expiresAt uint64) error {
	if nonce == 0 {
		return fmt.Errorf("nonce is required")
	}
	if owner == "" {
		return fmt.Errorf("owner is required")
	}
	if expiresAt == 0 {
		return fmt.Errorf("expiresAt is required")
	}
	exp := time.Unix(int64(expiresAt), 0)
	key := requestReplayKey{DealID: dealID, Owner: owner, Nonce: nonce}

	if existingAny, ok := requestReplayCache.Load(key); ok {
		if existing, ok2 := existingAny.(time.Time); ok2 && time.Now().Before(existing) {
			return fmt.Errorf("replay detected")
		}
	}

	requestReplayCache.Store(key, exp)
	return nil
}

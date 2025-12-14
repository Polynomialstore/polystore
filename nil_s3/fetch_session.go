package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	bolt "go.etcd.io/bbolt"
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

var sessionDB *bolt.DB

var (
	fetchSessionsBucket    = []byte("fetch_sessions")
	requestReplaysBucket   = []byte("request_replays")
	downloadSessionsBucket = []byte("download_sessions")
)

func initSessionDB(path string) error {
	if strings.TrimSpace(path) == "" {
		return nil
	}

	db, err := bolt.Open(path, 0o600, &bolt.Options{Timeout: 1 * time.Second})
	if err != nil {
		return err
	}

	if err := db.Update(func(tx *bolt.Tx) error {
		if _, err := tx.CreateBucketIfNotExists(fetchSessionsBucket); err != nil {
			return err
		}
		if _, err := tx.CreateBucketIfNotExists(requestReplaysBucket); err != nil {
			return err
		}
		if _, err := tx.CreateBucketIfNotExists(downloadSessionsBucket); err != nil {
			return err
		}
		return nil
	}); err != nil {
		_ = db.Close()
		return err
	}

	sessionDB = db
	return nil
}

func closeSessionDB() error {
	if sessionDB == nil {
		return nil
	}
	err := sessionDB.Close()
	sessionDB = nil
	return err
}

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

	if sessionDB != nil {
		bz, err := json.Marshal(s)
		if err != nil {
			return "", err
		}
		if err := sessionDB.Update(func(tx *bolt.Tx) error {
			b := tx.Bucket(fetchSessionsBucket)
			if b == nil {
				return fmt.Errorf("fetch_sessions bucket missing")
			}
			return b.Put([]byte(id), bz)
		}); err != nil {
			fetchSessionCache.Delete(id)
			return "", err
		}
	}
	return id, nil
}

// peekFetchSession loads a session without consuming it.
func peekFetchSession(id string) (fetchSession, bool) {
	if id == "" {
		return fetchSession{}, false
	}

	any, ok := fetchSessionCache.Load(id)
	if !ok {
		if sessionDB == nil {
			return fetchSession{}, false
		}
		var s fetchSession
		var found bool
		_ = sessionDB.View(func(tx *bolt.Tx) error {
			b := tx.Bucket(fetchSessionsBucket)
			if b == nil {
				return nil
			}
			v := b.Get([]byte(id))
			if v == nil {
				return nil
			}
			if err := json.Unmarshal(v, &s); err != nil {
				return nil
			}
			found = true
			return nil
		})
		if !found {
			return fetchSession{}, false
		}
		// Populate in-memory cache.
		fetchSessionCache.Store(id, s)
		any = s
	}
	s := any.(fetchSession)
	if !s.ExpiresAt.IsZero() && time.Now().After(s.ExpiresAt) {
		fetchSessionCache.Delete(id)
		if sessionDB != nil {
			_ = sessionDB.Update(func(tx *bolt.Tx) error {
				b := tx.Bucket(fetchSessionsBucket)
				if b == nil {
					return nil
				}
				return b.Delete([]byte(id))
			})
		}
		return fetchSession{}, false
	}
	return s, true
}

// takeFetchSession atomically consumes a session so it can only be used once.
func takeFetchSession(id string) (fetchSession, bool) {
	if id == "" {
		return fetchSession{}, false
	}

	if sessionDB != nil {
		var s fetchSession
		var ok bool
		_ = sessionDB.Update(func(tx *bolt.Tx) error {
			b := tx.Bucket(fetchSessionsBucket)
			if b == nil {
				return nil
			}
			v := b.Get([]byte(id))
			if v == nil {
				return nil
			}
			if err := json.Unmarshal(v, &s); err != nil {
				_ = b.Delete([]byte(id))
				return nil
			}
			_ = b.Delete([]byte(id))
			ok = true
			return nil
		})
		// Ensure the in-memory cache can't be reused.
		fetchSessionCache.Delete(id)

		if !ok {
			return fetchSession{}, false
		}
		if !s.ExpiresAt.IsZero() && time.Now().After(s.ExpiresAt) {
			return fetchSession{}, false
		}
		return s, true
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

	if sessionDB != nil {
		keyStr := fmt.Sprintf("%d|%s|%d", dealID, owner, nonce)
		now := time.Now()
		return sessionDB.Update(func(tx *bolt.Tx) error {
			b := tx.Bucket(requestReplaysBucket)
			if b == nil {
				return fmt.Errorf("request_replays bucket missing")
			}
			v := b.Get([]byte(keyStr))
			if v != nil {
				var existing time.Time
				if err := json.Unmarshal(v, &existing); err == nil && now.Before(existing) {
					return fmt.Errorf("replay detected")
				}
			}
			bz, err := json.Marshal(exp)
			if err != nil {
				return err
			}
			return b.Put([]byte(keyStr), bz)
		})
	}

	if existingAny, ok := requestReplayCache.Load(key); ok {
		if existing, ok2 := existingAny.(time.Time); ok2 && time.Now().Before(existing) {
			return fmt.Errorf("replay detected")
		}
	}

	requestReplayCache.Store(key, exp)
	return nil
}

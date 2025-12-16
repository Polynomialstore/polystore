package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	bolt "go.etcd.io/bbolt"

	"nilchain/x/nilchain/types"
)

var (
	errDownloadSessionNotFound = errors.New("download session not found")
	errDownloadSessionExpired  = errors.New("download session expired")
)

type downloadChunk struct {
	RangeStart   uint64             `json:"range_start"`
	RangeLen     uint64             `json:"range_len"`
	ProofDetails types.ChainedProof `json:"proof_details"`
}

type downloadSession struct {
	DealID     uint64          `json:"deal_id"`
	EpochID    uint64          `json:"epoch_id"`
	Owner      string          `json:"owner"`
	Provider   string          `json:"provider"`
	FilePath   string          `json:"file_path"`
	RangeStart uint64          `json:"range_start"`
	RangeLen   uint64          `json:"range_len"` // 0 means until EOF.
	CreatedAt  time.Time       `json:"created_at"`
	ExpiresAt  time.Time       `json:"expires_at"`
	Chunks     []downloadChunk `json:"chunks"`
}

var downloadSessionCache sync.Map // map[string]downloadSession

func storeDownloadSession(s downloadSession) (string, error) {
	if s.DealID == 0 {
		return "", fmt.Errorf("deal_id is required")
	}
	if strings.TrimSpace(s.Owner) == "" {
		return "", fmt.Errorf("owner is required")
	}
	if strings.TrimSpace(s.Provider) == "" {
		return "", fmt.Errorf("provider is required")
	}
	if strings.TrimSpace(s.FilePath) == "" {
		return "", fmt.Errorf("file_path is required")
	}
	if s.ExpiresAt.IsZero() {
		return "", fmt.Errorf("expires_at is required")
	}
	if s.CreatedAt.IsZero() {
		s.CreatedAt = time.Now()
	}

	id, err := newFetchSessionID()
	if err != nil {
		return "", err
	}

	downloadSessionCache.Store(id, s)
	if sessionDB != nil {
		bz, err := json.Marshal(s)
		if err != nil {
			return "", err
		}
		if err := sessionDB.Update(func(tx *bolt.Tx) error {
			b := tx.Bucket(downloadSessionsBucket)
			if b == nil {
				return fmt.Errorf("download_sessions bucket missing")
			}
			return b.Put([]byte(id), bz)
		}); err != nil {
			downloadSessionCache.Delete(id)
			return "", err
		}
	}

	return id, nil
}

func storeDownloadSessionWithID(id string, s downloadSession) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return fmt.Errorf("download_session id is required")
	}
	if s.DealID == 0 {
		return fmt.Errorf("deal_id is required")
	}
	if strings.TrimSpace(s.Owner) == "" {
		return fmt.Errorf("owner is required")
	}
	if strings.TrimSpace(s.Provider) == "" {
		return fmt.Errorf("provider is required")
	}
	if strings.TrimSpace(s.FilePath) == "" {
		return fmt.Errorf("file_path is required")
	}
	if s.CreatedAt.IsZero() {
		s.CreatedAt = time.Now()
	}
	if s.ExpiresAt.IsZero() {
		s.ExpiresAt = time.Now().Add(30 * time.Minute)
	}

	downloadSessionCache.Store(id, s)
	if sessionDB == nil {
		return nil
	}

	bz, err := json.Marshal(s)
	if err != nil {
		downloadSessionCache.Delete(id)
		return err
	}
	if err := sessionDB.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(downloadSessionsBucket)
		if b == nil {
			return fmt.Errorf("download_sessions bucket missing")
		}
		return b.Put([]byte(id), bz)
	}); err != nil {
		downloadSessionCache.Delete(id)
		return err
	}
	return nil
}

func appendDownloadChunkToSessionOrCreate(id string, initial downloadSession, chunk downloadChunk) error {
	if _, err := loadDownloadSession(id); err != nil {
		if errors.Is(err, errDownloadSessionNotFound) {
			if err := storeDownloadSessionWithID(id, initial); err != nil {
				return err
			}
		} else {
			return err
		}
	}
	return appendDownloadChunkToSession(id, chunk)
}

func loadDownloadSession(id string) (downloadSession, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return downloadSession{}, errDownloadSessionNotFound
	}

	if any, ok := downloadSessionCache.Load(id); ok {
		s := any.(downloadSession)
		if !s.ExpiresAt.IsZero() && time.Now().After(s.ExpiresAt) {
			downloadSessionCache.Delete(id)
			if sessionDB != nil {
				_ = sessionDB.Update(func(tx *bolt.Tx) error {
					b := tx.Bucket(downloadSessionsBucket)
					if b == nil {
						return nil
					}
					return b.Delete([]byte(id))
				})
			}
			return downloadSession{}, errDownloadSessionExpired
		}
		return s, nil
	}

	if sessionDB == nil {
		return downloadSession{}, errDownloadSessionNotFound
	}

	var s downloadSession
	var found bool
	_ = sessionDB.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(downloadSessionsBucket)
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
		return downloadSession{}, errDownloadSessionNotFound
	}
	if !s.ExpiresAt.IsZero() && time.Now().After(s.ExpiresAt) {
		_ = sessionDB.Update(func(tx *bolt.Tx) error {
			b := tx.Bucket(downloadSessionsBucket)
			if b == nil {
				return nil
			}
			return b.Delete([]byte(id))
		})
		return downloadSession{}, errDownloadSessionExpired
	}

	downloadSessionCache.Store(id, s)
	return s, nil
}

func appendDownloadChunkToSession(id string, chunk downloadChunk) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return errDownloadSessionNotFound
	}
	if chunk.RangeLen == 0 {
		return fmt.Errorf("chunk range_len is required")
	}

	if sessionDB != nil {
		return sessionDB.Update(func(tx *bolt.Tx) error {
			b := tx.Bucket(downloadSessionsBucket)
			if b == nil {
				return fmt.Errorf("download_sessions bucket missing")
			}
			v := b.Get([]byte(id))
			if v == nil {
				return errDownloadSessionNotFound
			}
			var s downloadSession
			if err := json.Unmarshal(v, &s); err != nil {
				_ = b.Delete([]byte(id))
				return errDownloadSessionNotFound
			}
			if !s.ExpiresAt.IsZero() && time.Now().After(s.ExpiresAt) {
				_ = b.Delete([]byte(id))
				downloadSessionCache.Delete(id)
				return errDownloadSessionExpired
			}
			s.Chunks = append(s.Chunks, chunk)
			bz, err := json.Marshal(s)
			if err != nil {
				return err
			}
			if err := b.Put([]byte(id), bz); err != nil {
				return err
			}
			downloadSessionCache.Store(id, s)
			return nil
		})
	}

	// In-memory fallback.
	any, ok := downloadSessionCache.Load(id)
	if !ok {
		return errDownloadSessionNotFound
	}
	s := any.(downloadSession)
	if !s.ExpiresAt.IsZero() && time.Now().After(s.ExpiresAt) {
		downloadSessionCache.Delete(id)
		return errDownloadSessionExpired
	}
	s.Chunks = append(s.Chunks, chunk)
	downloadSessionCache.Store(id, s)
	return nil
}

func takeDownloadSession(id string) (downloadSession, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return downloadSession{}, errDownloadSessionNotFound
	}

	if sessionDB != nil {
		var s downloadSession
		var ok bool
		_ = sessionDB.Update(func(tx *bolt.Tx) error {
			b := tx.Bucket(downloadSessionsBucket)
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
		downloadSessionCache.Delete(id)
		if !ok {
			return downloadSession{}, errDownloadSessionNotFound
		}
		if !s.ExpiresAt.IsZero() && time.Now().After(s.ExpiresAt) {
			return downloadSession{}, errDownloadSessionExpired
		}
		return s, nil
	}

	any, ok := downloadSessionCache.LoadAndDelete(id)
	if !ok {
		return downloadSession{}, errDownloadSessionNotFound
	}
	s := any.(downloadSession)
	if !s.ExpiresAt.IsZero() && time.Now().After(s.ExpiresAt) {
		return downloadSession{}, errDownloadSessionExpired
	}
	return s, nil
}

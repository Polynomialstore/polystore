package main

import (
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestSessionDB_PersistsFetchSessionAndReplayKeys(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "sessions.db")

	// Open DB and store a session.
	if err := initSessionDB(dbPath); err != nil {
		t.Fatalf("initSessionDB failed: %v", err)
	}
	t.Cleanup(func() { _ = closeSessionDB() })

	expiresAt := time.Now().Add(1 * time.Minute)
	id, err := storeFetchSession(fetchSession{
		DealID:      1,
		EpochID:     1,
		Owner:       "nil1owner",
		Provider:    "nil1provider",
		FilePath:    "file.txt",
		RangeStart:  0,
		RangeLen:    123,
		BytesServed: 123,
		ProofHash:   "0x" + "11",
		ReqNonce:    1,
		ReqExpires:  uint64(time.Now().Unix()) + 60,
		ExpiresAt:   expiresAt,
	})
	if err != nil {
		t.Fatalf("storeFetchSession failed: %v", err)
	}

	// Simulate a restart: clear in-memory cache and reopen the DB.
	fetchSessionCache = sync.Map{}
	if err := closeSessionDB(); err != nil {
		t.Fatalf("closeSessionDB failed: %v", err)
	}
	if err := initSessionDB(dbPath); err != nil {
		t.Fatalf("initSessionDB(reopen) failed: %v", err)
	}

	loaded, ok := peekFetchSession(id)
	if !ok {
		t.Fatalf("expected peekFetchSession to succeed after restart")
	}
	if loaded.DealID != 1 || loaded.Owner != "nil1owner" || loaded.FilePath != "file.txt" || loaded.BytesServed != 123 {
		t.Fatalf("loaded session mismatch: %+v", loaded)
	}

	// Take consumes the session (persisted delete).
	_, ok = takeFetchSession(id)
	if !ok {
		t.Fatalf("expected takeFetchSession to succeed")
	}
	_, ok = peekFetchSession(id)
	if ok {
		t.Fatalf("expected session to be consumed after takeFetchSession")
	}

	// Replay protection should also persist.
	expUnix := uint64(time.Now().Add(1 * time.Minute).Unix())
	if err := checkAndStoreRequestReplay(1, "nil1owner", 42, expUnix); err != nil {
		t.Fatalf("checkAndStoreRequestReplay failed: %v", err)
	}
	if err := checkAndStoreRequestReplay(1, "nil1owner", 42, expUnix); err == nil {
		t.Fatalf("expected replay to be rejected")
	}
}

package main

import (
	"path/filepath"
	"testing"

	"nilchain/x/nilchain/types"
)

func TestOnChainSessionProofs_NormalizesSessionIDKey(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "sessions.db")
	if err := initSessionDB(dbPath); err != nil {
		t.Fatalf("initSessionDB: %v", err)
	}
	t.Cleanup(func() { _ = closeSessionDB() })

	// Same bytes, different hex case.
	mixed := "0xAaBbCcDdEeFf00112233445566778899AaBbCcDdEeFf00112233445566778899"
	lower := "0xaabbccddeeff00112233445566778899aabbccddeeff00112233445566778899"

	proof := types.ChainedProof{MduIndex: 1, BlobIndex: 2}
	if err := storeOnChainSessionProof(mixed, proof); err != nil {
		t.Fatalf("storeOnChainSessionProof: %v", err)
	}

	gotLower, err := loadOnChainSessionProofs(lower)
	if err != nil {
		t.Fatalf("loadOnChainSessionProofs(lower): %v", err)
	}
	if len(gotLower) != 1 {
		t.Fatalf("expected 1 proof via lower key, got %d", len(gotLower))
	}

	gotMixed, err := loadOnChainSessionProofs(mixed)
	if err != nil {
		t.Fatalf("loadOnChainSessionProofs(mixed): %v", err)
	}
	if len(gotMixed) != 1 {
		t.Fatalf("expected 1 proof via mixed key, got %d", len(gotMixed))
	}
}


package main

import (
	"bytes"
	"context"
	"fmt"

	bolt "go.etcd.io/bbolt"
	"polystorechain/x/polystorechain/types"
)

const maxFrozenProofsPerPass = 32

func cleanupFrozenSessionProofs(ctx context.Context, after []byte) ([]byte, error) {
	if sessionDB == nil {
		return nil, nil
	}
	// One cursor in the existing maintenance loop bounds work and lets later
	// records progress even when an early authority query remains unavailable.
	prefix := []byte("v2:")
	var keys [][]byte
	err := sessionDB.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(onChainSessionProofsBucket)
		if b == nil {
			return fmt.Errorf("proof bucket missing")
		}
		c := b.Cursor()
		start := after
		if len(start) == 0 {
			start = prefix
		}
		k, _ := c.Seek(start)
		if len(after) != 0 && bytes.Equal(k, after) {
			k, _ = c.Next()
		}
		for ; k != nil && bytes.HasPrefix(k, prefix) && len(keys) < maxFrozenProofsPerPass; k, _ = c.Next() {
			keys = append(keys, bytes.Clone(k))
		}
		return nil
	})
	if err != nil {
		return after, err
	}
	if len(keys) == 0 {
		return nil, nil
	}
	var firstErr error
	for _, key := range keys {
		if err := ctx.Err(); err != nil {
			return after, err
		}
		if err := cleanupFrozenSessionProof(ctx, key); err != nil && firstErr == nil {
			firstErr = err
		}
		after = key
	}
	return after, firstErr
}

func cleanupFrozenSessionProof(ctx context.Context, key []byte) error {
	id, _, err := parseSessionIDHex("0x" + string(key[3:]))
	if err != nil {
		return err
	}
	release, err := claimRetrievalOperations([]string{id}, "")
	if err != nil {
		// Serving/submission owns this session until a later pass.
		return nil
	}
	defer release()
	var record storedFrozenProof
	err = sessionDB.View(func(tx *bolt.Tx) error {
		return decodeStoredFrozenProof(tx.Bucket(onChainSessionProofsBucket).Get(key), &record)
	})
	if err != nil {
		return err
	}
	// Never discard broadcast evidence or release signer quarantine here. Even
	// terminal sessions need explicit reconciliation of their attempted tx.
	if record.Submitting || record.TxHash != "" {
		return nil
	}
	response, height, err := queryRetrievalSession(ctx, id)
	if err != nil {
		return err
	}
	f, err := frozenRetrievalIdentity(response, height)
	if err != nil {
		return err
	}
	if err := validateSessionFunding(f.Session); err != nil {
		return err
	}
	switch f.Session.Status {
	case types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_COMPLETED,
		types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_CANCELED,
		types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_EXPIRED:
	default:
		if height <= f.Context.Window.Deadline {
			return nil
		}
	}
	// This compares the durable canonical context/hash to the committed session;
	// it deliberately requires no seed, which terminal pruning may have removed.
	entry, err := loadFrozenSubmission(f)
	if err != nil {
		return err
	}
	if entry.record.Submitting || entry.record.TxHash != "" {
		return nil
	}
	return changeFrozenSubmissions([]*frozenSubmission{entry}, nil, true)
}

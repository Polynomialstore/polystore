package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"

	bolt "go.etcd.io/bbolt"
	"polystorechain/x/polystorechain/types"
)

var ErrSessionNotFound = errors.New("retrieval session not found")

// parseUint64 is retained for the legacy deal metadata reader. Never narrow a
// floating-point value which may already have lost integer precision.
func parseUint64(v interface{}) (uint64, error) {
	switch t := v.(type) {
	case string:
		return strconv.ParseUint(t, 10, 64)
	case json.Number:
		return strconv.ParseUint(string(t), 10, 64)
	case float64:
		if t >= 0 && t <= 1<<53-1 && math.Trunc(t) == t {
			return uint64(t), nil
		}
	case int:
		if t >= 0 {
			return uint64(t), nil
		}
	}
	return 0, fmt.Errorf("invalid lossless uint64: %T", v)
}

// fetchRetrievalSession preserves the legacy caller contract. Secured serving
// uses fetchFrozenRetrievalSession and requires committed challenge authority.
func fetchRetrievalSession(sessionIDHex string) (*types.RetrievalSession, error) {
	response, _, err := queryRetrievalSession(context.Background(), sessionIDHex)
	if err != nil {
		return nil, err
	}
	return &response.Session, nil
}

func storeOnChainSessionProof(sessionID string, proof types.ChainedProof) error {
	if sessionDB == nil {
		return fmt.Errorf("session db not initialized")
	}
	normalized, _, err := parseSessionIDHex(sessionID)
	if err != nil {
		return err
	}
	return sessionDB.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(onChainSessionProofsBucket)
		if b == nil {
			return fmt.Errorf("onchain_session_proofs bucket missing")
		}

		current := b.Get([]byte(normalized))
		var proofs []types.ChainedProof
		if current != nil {
			_ = json.Unmarshal(current, &proofs)
		}
		proofs = append(proofs, proof)

		bz, err := json.Marshal(proofs)
		if err != nil {
			return err
		}
		return b.Put([]byte(normalized), bz)
	})
}

func loadOnChainSessionProofs(sessionID string) ([]types.ChainedProof, error) {
	if sessionDB == nil {
		return nil, fmt.Errorf("session db not initialized")
	}
	normalized, _, err := parseSessionIDHex(sessionID)
	if err != nil {
		return nil, err
	}
	var proofs []types.ChainedProof
	err = sessionDB.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(onChainSessionProofsBucket)
		if b == nil {
			return nil
		}
		v := b.Get([]byte(normalized))
		if v == nil {
			return nil
		}
		return json.Unmarshal(v, &proofs)
	})
	return proofs, err
}

func deleteOnChainSessionProofs(sessionID string) error {
	if sessionDB == nil {
		return nil
	}
	normalized, _, err := parseSessionIDHex(sessionID)
	if err != nil {
		return err
	}
	return sessionDB.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(onChainSessionProofsBucket)
		if b == nil {
			return nil
		}
		return b.Delete([]byte(normalized))
	})
}

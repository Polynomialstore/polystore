package main

import (
	"bytes"
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
			if err := decodeLegacySessionProofs(current, &proofs); err != nil {
				return err
			}
		}
		for _, previous := range proofs {
			if previous.MduIndex == proof.MduIndex && previous.BlobIndex == proof.BlobIndex {
				return nil
			}
		}
		if len(proofs) >= 64 {
			return fmt.Errorf("legacy proof count exceeds limit")
		}
		proofs = append(proofs, proof)

		bz, err := json.Marshal(proofs)
		if err != nil {
			return err
		}
		if len(bz) > maxRetrievalMetadataBytes {
			return fmt.Errorf("legacy proof record exceeds limit")
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
			return fmt.Errorf("proof bucket missing")
		}
		v := b.Get([]byte(normalized))
		if v == nil {
			return nil
		}
		return decodeLegacySessionProofs(v, &proofs)
	})
	return proofs, err
}

// Called only after committed success. Both legacy stores are deleted in one
// transaction; cache eviction follows the durable commit rather than hiding it.
func deleteSubmittedLegacyProofs(sessionID, signer string) error {
	if sessionDB == nil {
		return fmt.Errorf("session DB unavailable")
	}
	normalized, _, err := parseSessionIDHex(sessionID)
	if err != nil {
		return err
	}
	err = sessionDB.Update(func(tx *bolt.Tx) error {
		for _, name := range [][]byte{onChainSessionProofsBucket, downloadSessionsBucket} {
			b := tx.Bucket(name)
			if b == nil {
				return fmt.Errorf("session bucket missing")
			}
			if err := b.Delete([]byte(normalized)); err != nil {
				return err
			}
		}
		return clearPendingSigner(tx, signer, "retrieval", []string{normalized})
	})
	if err == nil {
		downloadSessionCache.Delete(normalized)
	}
	return err
}

func decodeLegacySessionProofs(raw []byte, proofs *[]types.ChainedProof) error {
	if len(raw) == 0 || len(raw) > maxRetrievalMetadataBytes {
		return fmt.Errorf("legacy proof record size invalid")
	}
	wrapped := append([]byte(`{"proofs":`), raw...)
	wrapped = append(wrapped, '}')
	if err := validateJSONObject(wrapped); err != nil {
		return err
	}
	if err := json.Unmarshal(raw, proofs); err != nil {
		return err
	}
	if len(*proofs) == 0 || len(*proofs) > 64 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return fmt.Errorf("legacy proof count invalid")
	}
	return nil
}

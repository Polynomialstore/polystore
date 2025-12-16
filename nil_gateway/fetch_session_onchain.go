package main

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	bolt "go.etcd.io/bbolt"

	"nilchain/x/nilchain/types"
)

var ErrSessionNotFound = errors.New("retrieval session not found")

// fetchRetrievalSession queries the LCD for an on-chain retrieval session.
func fetchRetrievalSession(sessionIDHex string) (*types.RetrievalSession, error) {
	// sessionIDHex should be 32 bytes hex.
	sidBytes, err := hex.DecodeString(strings.TrimPrefix(sessionIDHex, "0x"))
	if err != nil {
		return nil, fmt.Errorf("invalid session id hex: %w", err)
	}
	sidB64 := base64.URLEncoding.EncodeToString(sidBytes)

	url := fmt.Sprintf("%s/nilchain/nilchain/v1/retrieval-sessions/%s", lcdBase, sidB64)
	resp, err := lcdHTTPClient.Get(url)
	if err != nil {
		return nil, fmt.Errorf("LCD request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		if resp.StatusCode == http.StatusNotFound {
			return nil, ErrSessionNotFound
		}
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("LCD returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var payload struct {
		Session types.RetrievalSession `json:"session"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("failed to decode LCD response: %w", err)
	}

	return &payload.Session, nil
}

func storeOnChainSessionProof(sessionID string, proof types.ChainedProof) error {
	if sessionDB == nil {
		return fmt.Errorf("session db not initialized")
	}
	return sessionDB.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(onChainSessionProofsBucket)
		if b == nil {
			return fmt.Errorf("onchain_session_proofs bucket missing")
		}
		
		current := b.Get([]byte(sessionID))
		var proofs []types.ChainedProof
		if current != nil {
			_ = json.Unmarshal(current, &proofs)
		}
		proofs = append(proofs, proof)
		
		bz, err := json.Marshal(proofs)
		if err != nil {
			return err
		}
		return b.Put([]byte(sessionID), bz)
	})
}

func loadOnChainSessionProofs(sessionID string) ([]types.ChainedProof, error) {
	if sessionDB == nil {
		return nil, fmt.Errorf("session db not initialized")
	}
	var proofs []types.ChainedProof
	err := sessionDB.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(onChainSessionProofsBucket)
		if b == nil {
			return nil
		}
		v := b.Get([]byte(sessionID))
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
	return sessionDB.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(onChainSessionProofsBucket)
		if b == nil {
			return nil
		}
		return b.Delete([]byte(sessionID))
	})
}

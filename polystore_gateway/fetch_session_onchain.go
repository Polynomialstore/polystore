package main

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	bolt "go.etcd.io/bbolt"

	"nilchain/x/nilchain/types"
)

var ErrSessionNotFound = errors.New("retrieval session not found")

// lcdRetrievalSession mirrors the LCD JSON structure where uint64s are strings.
type lcdRetrievalSession struct {
	SessionId      string      `json:"session_id"`
	DealId         interface{} `json:"deal_id"` // string or number
	Owner          string      `json:"owner"`
	Provider       string      `json:"provider"`
	ManifestRoot   string      `json:"manifest_root"`
	StartMduIndex  interface{} `json:"start_mdu_index"`
	StartBlobIndex interface{} `json:"start_blob_index"`
	BlobCount      interface{} `json:"blob_count"`
	TotalBytes     interface{} `json:"total_bytes"`
	Nonce          interface{} `json:"nonce"`
	ExpiresAt      interface{} `json:"expires_at"`
	OpenedHeight   interface{} `json:"opened_height"`
	UpdatedHeight  interface{} `json:"updated_height"`
	Status         interface{} `json:"status"`
}

func parseUint64(v interface{}) (uint64, error) {
	switch t := v.(type) {
	case string:
		return strconv.ParseUint(t, 10, 64)
	case float64:
		return uint64(t), nil
	case int:
		return uint64(t), nil
	default:
		return 0, fmt.Errorf("unexpected type for uint64: %T", v)
	}
}

func parseInt64(v interface{}) (int64, error) {
	switch t := v.(type) {
	case string:
		return strconv.ParseInt(t, 10, 64)
	case float64:
		return int64(t), nil
	case int:
		return int64(t), nil
	default:
		return 0, fmt.Errorf("unexpected type for int64: %T", v)
	}
}

func parseBytes(v string) ([]byte, error) {
	// Try base64 standard/url
	if b, err := base64.StdEncoding.DecodeString(v); err == nil {
		return b, nil
	}
	if b, err := base64.URLEncoding.DecodeString(v); err == nil {
		return b, nil
	}
	// Try hex (optional)
	if strings.HasPrefix(v, "0x") {
		return hex.DecodeString(v[2:])
	}
	return hex.DecodeString(v)
}

func parseStatus(v interface{}) (types.RetrievalSessionStatus, error) {
	switch t := v.(type) {
	case string:
		if val, ok := types.RetrievalSessionStatus_value[t]; ok {
			return types.RetrievalSessionStatus(val), nil
		}
		return types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_UNSPECIFIED, nil
	case float64:
		return types.RetrievalSessionStatus(int32(t)), nil
	default:
		return types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_UNSPECIFIED, nil
	}
}

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
		Session lcdRetrievalSession `json:"session"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("failed to decode LCD response: %w", err)
	}

	s := payload.Session
	res := &types.RetrievalSession{
		Owner:    s.Owner,
		Provider: s.Provider,
	}

	if res.SessionId, err = parseBytes(s.SessionId); err != nil {
		return nil, fmt.Errorf("failed to parse session_id: %w", err)
	}
	if res.DealId, err = parseUint64(s.DealId); err != nil {
		return nil, fmt.Errorf("failed to parse deal_id: %w", err)
	}
	if res.ManifestRoot, err = parseBytes(s.ManifestRoot); err != nil {
		return nil, fmt.Errorf("failed to parse manifest_root: %w", err)
	}
	if res.StartMduIndex, err = parseUint64(s.StartMduIndex); err != nil {
		return nil, fmt.Errorf("failed to parse start_mdu_index: %w", err)
	}
	if blobIdx, err := parseUint64(s.StartBlobIndex); err != nil {
		return nil, fmt.Errorf("failed to parse start_blob_index: %w", err)
	} else {
		res.StartBlobIndex = uint32(blobIdx)
	}
	if res.BlobCount, err = parseUint64(s.BlobCount); err != nil {
		return nil, fmt.Errorf("failed to parse blob_count: %w", err)
	}
	if res.TotalBytes, err = parseUint64(s.TotalBytes); err != nil {
		return nil, fmt.Errorf("failed to parse total_bytes: %w", err)
	}
	if res.Nonce, err = parseUint64(s.Nonce); err != nil {
		return nil, fmt.Errorf("failed to parse nonce: %w", err)
	}
	if res.ExpiresAt, err = parseUint64(s.ExpiresAt); err != nil {
		return nil, fmt.Errorf("failed to parse expires_at: %w", err)
	}
	if res.OpenedHeight, err = parseInt64(s.OpenedHeight); err != nil {
		return nil, fmt.Errorf("failed to parse opened_height: %w", err)
	}
	if res.UpdatedHeight, err = parseInt64(s.UpdatedHeight); err != nil {
		return nil, fmt.Errorf("failed to parse updated_height: %w", err)
	}
	if res.Status, err = parseStatus(s.Status); err != nil {
		return nil, fmt.Errorf("failed to parse status: %w", err)
	}

	return res, nil
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

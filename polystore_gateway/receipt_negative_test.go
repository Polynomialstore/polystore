package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestSpSubmitReceipt_NegativeCases(t *testing.T) {
	// Ensure a clean session cache for deterministic tests.
	fetchSessionCache = sync.Map{}

	auth := gatewayToProviderAuthToken()
	dummySig := base64.StdEncoding.EncodeToString([]byte{1, 2, 3, 4})

	t.Run("wrong provider", func(t *testing.T) {
		sessionID, err := storeFetchSession(fetchSession{
			DealID:      1,
			EpochID:     1,
			Owner:       "nil1owner",
			Provider:    "nil1provider",
			FilePath:    "file.txt",
			RangeStart:  0,
			RangeLen:    123,
			BytesServed: 123,
			ProofHash:   "0x11",
			ExpiresAt:   time.Now().Add(5 * time.Minute),
		})
		if err != nil {
			t.Fatalf("storeFetchSession failed: %v", err)
		}

		payload := map[string]any{
			"fetch_session": sessionID,
			"receipt": map[string]any{
				"deal_id":        1,
				"epoch_id":       1,
				"provider":       "nil1other",
				"file_path":      "file.txt",
				"range_start":    0,
				"range_len":      123,
				"bytes_served":   123,
				"proof_details":  map[string]any{},
				"user_signature": dummySig,
				"nonce":          1,
				"expires_at":     0,
			},
		}
		body, _ := json.Marshal(payload)
		req := httptest.NewRequest(http.MethodPost, "/sp/receipt", bytes.NewReader(body))
		req.Header.Set(gatewayAuthHeader, auth)
		w := httptest.NewRecorder()
		SpSubmitReceipt(w, req)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected 400, got %d (%s)", w.Code, w.Body.String())
		}
	})

	t.Run("proof hash mismatch consumes session", func(t *testing.T) {
		sessionID, err := storeFetchSession(fetchSession{
			DealID:      1,
			EpochID:     1,
			Owner:       "nil1owner",
			Provider:    "nil1provider",
			FilePath:    "file.txt",
			RangeStart:  0,
			RangeLen:    123,
			BytesServed: 123,
			ProofHash:   "0x11", // will intentionally mismatch
			ExpiresAt:   time.Now().Add(5 * time.Minute),
		})
		if err != nil {
			t.Fatalf("storeFetchSession failed: %v", err)
		}

		payload := map[string]any{
			"fetch_session": sessionID,
			"receipt": map[string]any{
				"deal_id":        1,
				"epoch_id":       1,
				"provider":       "nil1provider",
				"file_path":      "file.txt",
				"range_start":    0,
				"range_len":      123,
				"bytes_served":   123,
				"proof_details":  map[string]any{}, // hashes to 0x00..., mismatching session.ProofHash
				"user_signature": dummySig,
				"nonce":          1,
				"expires_at":     0,
			},
		}
		body, _ := json.Marshal(payload)
		req := httptest.NewRequest(http.MethodPost, "/sp/receipt", bytes.NewReader(body))
		req.Header.Set(gatewayAuthHeader, auth)
		w := httptest.NewRecorder()
		SpSubmitReceipt(w, req)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected 400, got %d (%s)", w.Code, w.Body.String())
		}

		// Second submit with the same session should fail (replay protection).
		req2 := httptest.NewRequest(http.MethodPost, "/sp/receipt", bytes.NewReader(body))
		req2.Header.Set(gatewayAuthHeader, auth)
		w2 := httptest.NewRecorder()
		SpSubmitReceipt(w2, req2)
		if w2.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 on replayed session, got %d (%s)", w2.Code, w2.Body.String())
		}
		if w2.Body.String() == "" {
			t.Fatalf("expected error body for replayed session")
		}
	})
}

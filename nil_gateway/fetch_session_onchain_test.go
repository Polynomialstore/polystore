package main

import (
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFetchRetrievalSession_StringID(t *testing.T) {
	// 1. Setup a mock LCD server that returns deal_id as a string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify the path
		// Expects /nilchain/nilchain/v1/retrieval-sessions/{base64_id}
		
		// Return JSON with deal_id as a string
		jsonResponse := `{
			"session": {
				"session_id": "c29tZXNlc3Npb25pZA==",
				"deal_id": "42",
				"owner": "nil1owner",
				"provider": "nil1provider",
				"manifest_root": "c29tZXJvb3Q=",
				"start_mdu_index": "100",
				"start_blob_index": 5,
				"blob_count": "10",
				"total_bytes": "1310720",
				"nonce": "1",
				"expires_at": "999999",
				"opened_height": "50",
				"updated_height": "55",
				"status": "RETRIEVAL_SESSION_STATUS_OPEN"
			}
		}`
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, jsonResponse)
	}))
	defer ts.Close()

	// 2. Override lcdBase
	oldLcdBase := lcdBase
	lcdBase = ts.URL
	defer func() { lcdBase = oldLcdBase }()

	// 3. Call fetchRetrievalSession
	// sessionIDHex needs to be valid hex 32 bytes
	sessionIDBytes := make([]byte, 32)
	copy(sessionIDBytes, []byte("somesessionid")) // padded with zeros
	sessionIDHex := "0x" + hex.EncodeToString(sessionIDBytes)

	session, err := fetchRetrievalSession(sessionIDHex)
	
	if err != nil {
		t.Fatalf("fetchRetrievalSession failed: %v", err)
	}

	if session.DealId != 42 {
		t.Errorf("Expected DealId 42, got %d", session.DealId)
	}
}

package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/gorilla/mux"
)

// helper to build a router with only the GatewayFetch endpoint wired.
func testRouter() *mux.Router {
	r := mux.NewRouter()
	r.HandleFunc("/gateway/fetch/{cid}", GatewayFetch).Methods("GET", "OPTIONS")
	return r
}

func TestGatewayFetch_MissingParams(t *testing.T) {
	r := testRouter()

	req := httptest.NewRequest("GET", "/gateway/fetch/testcid", nil)
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for missing query params, got %d", w.Code)
	}
	body, _ := io.ReadAll(w.Body)
	if !strings.Contains(string(body), "deal_id and owner") {
		t.Fatalf("expected error about missing deal_id/owner, got: %s", string(body))
	}
}

// mockDealServer returns a simple LCD-like handler that serves a single deal
// with given owner and cid values.
func mockDealServer(owner, cid string) *httptest.Server {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := map[string]any{
			"deal": map[string]any{
				"owner": owner,
				"cid":   cid,
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	})
	return httptest.NewServer(handler)
}

func TestGatewayFetch_OwnerMismatch(t *testing.T) {
	r := testRouter()

	// Stub LCD so fetchDealOwnerAndCID returns a specific owner/cid.
	srv := mockDealServer("nil1realowner", "cid123")
	defer srv.Close()
	oldLCD := lcdBase
	lcdBase = srv.URL
	defer func() { lcdBase = oldLCD }()

	q := url.Values{}
	q.Set("deal_id", "1")
	q.Set("owner", "nil1otherowner")
	req := httptest.NewRequest("GET", "/gateway/fetch/cid123?"+q.Encode(), nil)
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for owner mismatch, got %d", w.Code)
	}
}

func TestGatewayFetch_CIDMismatch(t *testing.T) {
	r := testRouter()

	// Stub LCD: owner matches, cid does not.
	srv := mockDealServer("nil1owner", "cid-on-chain")
	defer srv.Close()
	oldLCD := lcdBase
	lcdBase = srv.URL
	defer func() { lcdBase = oldLCD }()

	q := url.Values{}
	q.Set("deal_id", "2")
	q.Set("owner", "nil1owner")
	req := httptest.NewRequest("GET", "/gateway/fetch/request-cid?"+q.Encode(), nil)
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for cid mismatch, got %d", w.Code)
	}
	body, _ := io.ReadAll(w.Body)
	if !strings.Contains(string(body), "cid does not match deal") {
		t.Fatalf("expected cid mismatch message, got: %s", string(body))
	}
}


package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/mux"
)

func testReceiptRouter() *mux.Router {
	r := mux.NewRouter()
	r.HandleFunc("/gateway/receipt", GatewaySubmitReceipt).Methods("POST", "OPTIONS")
	r.HandleFunc("/sp/receipt", SpSubmitReceipt).Methods("POST", "OPTIONS")
	return r
}

func TestGatewayReceipt_IsForwardedAndSpRequiresAuth(t *testing.T) {
	r := testReceiptRouter()
	srv := httptest.NewServer(r)
	defer srv.Close()

	oldBase := providerBase
	providerBase = srv.URL
	defer func() { providerBase = oldBase }()

	// Direct provider call must fail without gateway auth.
	{
		req := httptest.NewRequest(http.MethodPost, srv.URL+"/sp/receipt", strings.NewReader(`{}`))
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusForbidden {
			t.Fatalf("expected 403 for direct /sp/receipt without auth, got %d", w.Code)
		}
	}

	// Gateway endpoint should forward to provider (auth header attached), so we
	// should get a validation error other than 403.
	{
		req := httptest.NewRequest(http.MethodPost, srv.URL+"/gateway/receipt", strings.NewReader(`{}`))
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 for forwarded /gateway/receipt body validation, got %d", w.Code)
		}
		if !strings.Contains(w.Body.String(), "fetch_session") {
			t.Fatalf("expected fetch_session validation error, got: %s", w.Body.String())
		}
	}
}

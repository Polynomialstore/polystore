package main

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/gorilla/mux"
)

func testReceiptRouter() *mux.Router {
	r := mux.NewRouter()
	r.HandleFunc("/gateway/receipt", GatewaySubmitReceipt).Methods("POST", "OPTIONS")
	r.HandleFunc("/gateway/session-proof", GatewaySubmitRetrievalSessionProof).Methods("POST", "OPTIONS")
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

func TestGatewaySessionProof_UsesProviderAddressRouting(t *testing.T) {
	const providerAddr = "nil1providerroutingtest0000000000000000000000000"

	origCache := providerBaseCache
	providerBaseCache = sync.Map{}
	defer func() { providerBaseCache = origCache }()

	var gotPath string
	var gotAuth string
	var gotBody string
	providerSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = strings.TrimSpace(r.Header.Get(gatewayAuthHeader))
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"success","tx_hash":"0xabc"}`))
	}))
	defer providerSrv.Close()

	t.Setenv(
		"POLYSTORE_PROVIDER_HTTP_BASE_OVERRIDES",
		fmt.Sprintf("%s=%s", providerAddr, providerSrv.URL),
	)

	r := testReceiptRouter()
	gatewaySrv := httptest.NewServer(r)
	defer gatewaySrv.Close()

	oldBase := providerBase
	providerBase = "http://127.0.0.1:1"
	defer func() { providerBase = oldBase }()

	payload := fmt.Sprintf(`{"session_id":"0x%s","provider":"%s"}`, strings.Repeat("1", 64), providerAddr)
	req := httptest.NewRequest(http.MethodPost, gatewaySrv.URL+"/gateway/session-proof", strings.NewReader(payload))
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for forwarded session-proof, got %d body=%s", w.Code, w.Body.String())
	}
	if gotPath != "/sp/session-proof" {
		t.Fatalf("expected provider path /sp/session-proof, got %q", gotPath)
	}
	if gotAuth != gatewayToProviderAuthToken() {
		t.Fatalf("expected gateway auth header to be set")
	}
	if !strings.Contains(gotBody, providerAddr) {
		t.Fatalf("expected forwarded body to include provider address, got %s", gotBody)
	}
}

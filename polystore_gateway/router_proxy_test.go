package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/gorilla/mux"
)

func mustHTTPMultiaddr(t *testing.T, rawURL string) string {
	t.Helper()
	u, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("url.Parse failed: %v", err)
	}
	host, port, err := net.SplitHostPort(u.Host)
	if err != nil {
		t.Fatalf("net.SplitHostPort failed: %v", err)
	}
	if net.ParseIP(host) == nil {
		return fmt.Sprintf("/dns4/%s/tcp/%s/http", host, port)
	}
	return fmt.Sprintf("/ip4/%s/tcp/%s/http", host, port)
}

func TestRouterGatewayFetch_ProxiesByDealProvider(t *testing.T) {
	requireOnchainSessionForTest(t, false)
	dealProviderCache = sync.Map{}
	dealProvidersCache = sync.Map{}
	providerBaseCache = sync.Map{}

	providerAddr := "nil1provider"
	var gotPath string
	var gotQuery string
	providerSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.RawQuery
		w.Header().Set("X-Test-Routed", "1")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	defer providerSrv.Close()

	maddr := mustHTTPMultiaddr(t, providerSrv.URL)

	lcdSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/nilchain/nilchain/v1/deals/"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"deal": map[string]any{
					"providers": []string{providerAddr},
				},
			})
		case strings.HasPrefix(r.URL.Path, "/nilchain/nilchain/v1/providers/"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"provider": map[string]any{
					"endpoints": []string{maddr},
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer lcdSrv.Close()

	oldLCD := lcdBase
	lcdBase = lcdSrv.URL
	t.Cleanup(func() { lcdBase = oldLCD })

	r := mux.NewRouter()
	r.HandleFunc("/gateway/fetch/{cid}", RouterGatewayFetch).Methods("GET", "OPTIONS")

	req := httptest.NewRequest(http.MethodGet, "/gateway/fetch/0xabc?deal_id=1&owner=nil1x&file_path=a.txt", nil)
	req.Header.Set("Range", "bytes=0-0")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	if w.Header().Get("X-Test-Routed") != "1" {
		t.Fatalf("expected routed header")
	}
	if strings.TrimSpace(w.Body.String()) != "ok" {
		t.Fatalf("expected ok body, got %q", w.Body.String())
	}
	if gotPath != "/sp/retrieval/fetch/0xabc" {
		t.Fatalf("expected provider path forwarded, got %q", gotPath)
	}
	if !strings.Contains(gotQuery, "deal_id=1") {
		t.Fatalf("expected provider query forwarded, got %q", gotQuery)
	}
}

func TestRouterGatewayFetch_UnsignedMissingRangeRejected(t *testing.T) {
	requireOnchainSessionForTest(t, false)
	oldRequireSig := requireRetrievalReqSig
	requireRetrievalReqSig = false
	t.Cleanup(func() { requireRetrievalReqSig = oldRequireSig })

	r := mux.NewRouter()
	r.HandleFunc("/gateway/fetch/{cid}", RouterGatewayFetch).Methods("GET", "OPTIONS")

	req := httptest.NewRequest(http.MethodGet, "/gateway/fetch/0xabc?deal_id=1&owner=nil1x&file_path=a.txt", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d (%s)", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "Range header is required") {
		t.Fatalf("expected Range header error, got: %s", w.Body.String())
	}
}

func TestRouterGatewayFetch_SignedModeMissingRangeAllowedAtProxy(t *testing.T) {
	requireOnchainSessionForTest(t, false)
	dealProviderCache = sync.Map{}
	dealProvidersCache = sync.Map{}
	providerBaseCache = sync.Map{}

	oldRequireSig := requireRetrievalReqSig
	requireRetrievalReqSig = true
	t.Cleanup(func() { requireRetrievalReqSig = oldRequireSig })

	providerAddr := "nil1provider"
	var gotPath string
	providerSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	defer providerSrv.Close()

	maddr := mustHTTPMultiaddr(t, providerSrv.URL)
	lcdSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/nilchain/nilchain/v1/deals/"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"deal": map[string]any{
					"providers": []string{providerAddr},
				},
			})
		case strings.HasPrefix(r.URL.Path, "/nilchain/nilchain/v1/providers/"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"provider": map[string]any{
					"endpoints": []string{maddr},
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer lcdSrv.Close()

	oldLCD := lcdBase
	lcdBase = lcdSrv.URL
	t.Cleanup(func() { lcdBase = oldLCD })

	r := mux.NewRouter()
	r.HandleFunc("/gateway/fetch/{cid}", RouterGatewayFetch).Methods("GET", "OPTIONS")

	req := httptest.NewRequest(http.MethodGet, "/gateway/fetch/0xabc?deal_id=1&owner=nil1x&file_path=a.txt", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code == http.StatusBadRequest {
		t.Fatalf("expected signed mode missing Range not to be rejected at proxy layer, got 400 (%s)", w.Body.String())
	}
	if w.Code != http.StatusOK {
		t.Fatalf("expected request to reach provider path, got %d (%s)", w.Code, w.Body.String())
	}
	if gotPath != "/sp/retrieval/fetch/0xabc" {
		t.Fatalf("expected provider path forwarded, got %q", gotPath)
	}
}

func TestRouterGatewayUploadStatus_DeduplicatesCORSHeaders(t *testing.T) {
	requireOnchainSessionForTest(t, false)
	dealProviderCache = sync.Map{}
	dealProvidersCache = sync.Map{}
	providerBaseCache = sync.Map{}

	providerAddr := "nil1provider"
	providerSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := strings.TrimSpace(r.Header.Get("Origin"))
		if origin == "" {
			origin = "*"
		}
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"state":"done"}`))
	}))
	defer providerSrv.Close()

	maddr := mustHTTPMultiaddr(t, providerSrv.URL)
	lcdSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/nilchain/nilchain/v1/deals/"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"deal": map[string]any{
					"providers": []string{providerAddr},
				},
			})
		case strings.HasPrefix(r.URL.Path, "/nilchain/nilchain/v1/providers/"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"provider": map[string]any{
					"endpoints": []string{maddr},
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer lcdSrv.Close()

	oldLCD := lcdBase
	lcdBase = lcdSrv.URL
	t.Cleanup(func() { lcdBase = oldLCD })

	r := mux.NewRouter()
	r.HandleFunc("/gateway/upload-status", RouterGatewayUploadStatus).Methods("GET", "OPTIONS")
	handler := withGlobalCORS(r)

	const origin = "http://localhost:5173"
	req := httptest.NewRequest(http.MethodGet, "/gateway/upload-status?deal_id=1&upload_id=u1", nil)
	req.Header.Set("Origin", origin)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}

	values := w.Header().Values("Access-Control-Allow-Origin")
	if len(values) != 1 {
		t.Fatalf("expected single Access-Control-Allow-Origin header, got %v", values)
	}
	if got := strings.TrimSpace(values[0]); got != origin {
		t.Fatalf("expected Access-Control-Allow-Origin=%q, got %q", origin, got)
	}
}

func TestRouterGatewayFetch_FailsOverWhenPrimaryUnavailable(t *testing.T) {
	requireOnchainSessionForTest(t, false)
	dealProviderCache = sync.Map{}
	dealProvidersCache = sync.Map{}
	providerBaseCache = sync.Map{}

	primaryAddr := "nil1primary"
	deputyAddr := "nil1deputy"

	var deputyHits int
	deputySrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		deputyHits++
		w.Header().Set("X-Test-Routed", "1")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	defer deputySrv.Close()

	deputyMaddr := mustHTTPMultiaddr(t, deputySrv.URL)
	primaryMaddr := "/ip4/127.0.0.1/tcp/1/http" // connection refused

	lcdSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/nilchain/nilchain/v1/deals/"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"deal": map[string]any{
					"providers": []string{primaryAddr, deputyAddr},
				},
			})
		case strings.HasPrefix(r.URL.Path, "/nilchain/nilchain/v1/providers/"):
			provider := strings.TrimPrefix(r.URL.Path, "/nilchain/nilchain/v1/providers/")
			endpoint := deputyMaddr
			if provider == primaryAddr {
				endpoint = primaryMaddr
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"provider": map[string]any{
					"endpoints": []string{endpoint},
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer lcdSrv.Close()

	oldLCD := lcdBase
	lcdBase = lcdSrv.URL
	t.Cleanup(func() { lcdBase = oldLCD })

	r := mux.NewRouter()
	r.HandleFunc("/gateway/fetch/{cid}", RouterGatewayFetch).Methods("GET", "OPTIONS")

	req := httptest.NewRequest(http.MethodGet, "/gateway/fetch/0xabc?deal_id=1&owner=nil1x&file_path=a.txt", nil)
	req.Header.Set("Range", "bytes=0-0")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	if w.Header().Get("X-Test-Routed") != "1" {
		t.Fatalf("expected routed header")
	}
	if strings.TrimSpace(w.Body.String()) != "ok" {
		t.Fatalf("expected ok body, got %q", w.Body.String())
	}
	if deputyHits != 1 {
		t.Fatalf("expected deputy provider to receive request, hits=%d", deputyHits)
	}
}

func TestRouterGatewayReceipt_ForwardsToProviderByReceiptProvider(t *testing.T) {
	providerBaseCache = sync.Map{}

	providerAddr := "nil1provider"
	var gotAuth string
	providerSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/sp/receipt" {
			http.NotFound(w, r)
			return
		}
		gotAuth = strings.TrimSpace(r.Header.Get(gatewayAuthHeader))
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer providerSrv.Close()

	maddr := mustHTTPMultiaddr(t, providerSrv.URL)
	lcdSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/nilchain/nilchain/v1/providers/") {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"provider": map[string]any{
					"endpoints": []string{maddr},
				},
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer lcdSrv.Close()

	oldLCD := lcdBase
	lcdBase = lcdSrv.URL
	t.Cleanup(func() { lcdBase = oldLCD })

	r := mux.NewRouter()
	r.HandleFunc("/gateway/receipt", RouterGatewaySubmitReceipt).Methods("POST", "OPTIONS")

	body := fmt.Sprintf(`{"fetch_session":"s","receipt":{"deal_id":1,"provider":"%s"}}`, providerAddr)
	req := httptest.NewRequest(http.MethodPost, "/gateway/receipt", strings.NewReader(body))
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	if strings.TrimSpace(gotAuth) != strings.TrimSpace(gatewayToProviderAuthToken()) {
		t.Fatalf("expected gateway auth header to be forwarded")
	}
}

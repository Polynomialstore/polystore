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
	if gotPath != "/gateway/fetch/0xabc" {
		t.Fatalf("expected provider path forwarded, got %q", gotPath)
	}
	if !strings.Contains(gotQuery, "deal_id=1") {
		t.Fatalf("expected provider query forwarded, got %q", gotQuery)
	}
}

func TestRouterGatewayFetch_FailsOverWhenPrimaryUnavailable(t *testing.T) {
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

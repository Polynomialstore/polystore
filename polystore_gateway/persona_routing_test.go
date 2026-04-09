package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gorilla/mux"
)

func TestValidateRuntimePersona(t *testing.T) {
	t.Run("provider requires provider identity", func(t *testing.T) {
		t.Setenv("POLYSTORE_PROVIDER_KEY", "")
		t.Setenv("POLYSTORE_PROVIDER_ADDRESS", "")
		t.Setenv("POLYSTORE_LEGACY_MIXED_ROUTES", "0")
		if err := validateRuntimePersona(runtimePersonaProviderDaemon, false, ":8082"); err == nil {
			t.Fatalf("expected validation failure when provider identity is missing")
		}
	})

	t.Run("user rejects provider identity in strict mode", func(t *testing.T) {
		t.Setenv("POLYSTORE_PROVIDER_KEY", "provider1")
		t.Setenv("POLYSTORE_PROVIDER_ADDRESS", "")
		t.Setenv("POLYSTORE_LEGACY_MIXED_ROUTES", "0")
		if err := validateRuntimePersona(runtimePersonaUserGateway, true, ":8080"); err == nil {
			t.Fatalf("expected validation failure when user-gateway has provider identity env")
		}
	})

	t.Run("provider rejects user-gateway port by default", func(t *testing.T) {
		t.Setenv("POLYSTORE_PROVIDER_KEY", "provider1")
		t.Setenv("POLYSTORE_PROVIDER_ADDRESS", "")
		t.Setenv("POLYSTORE_LEGACY_MIXED_ROUTES", "0")
		t.Setenv("POLYSTORE_ALLOW_PROVIDER_ON_USER_PORT", "0")
		if err := validateRuntimePersona(runtimePersonaProviderDaemon, false, ":8080"); err == nil {
			t.Fatalf("expected validation failure when provider-daemon binds :8080")
		}
	})

	t.Run("provider can override user-gateway port guard for legacy compatibility", func(t *testing.T) {
		t.Setenv("POLYSTORE_PROVIDER_KEY", "provider1")
		t.Setenv("POLYSTORE_PROVIDER_ADDRESS", "")
		t.Setenv("POLYSTORE_LEGACY_MIXED_ROUTES", "0")
		t.Setenv("POLYSTORE_ALLOW_PROVIDER_ON_USER_PORT", "1")
		if err := validateRuntimePersona(runtimePersonaProviderDaemon, false, ":8080"); err != nil {
			t.Fatalf("expected provider-daemon :8080 override to pass, got: %v", err)
		}
	})
}

func TestProviderDaemonRoutes_DoNotExposeGatewaySurface(t *testing.T) {
	r := mux.NewRouter()
	registerProviderDaemonRoutes(r)

	wGateway := httptest.NewRecorder()
	reqGateway := httptest.NewRequest(http.MethodGet, "/gateway/fetch/0xabc?deal_id=1&owner=nil1x&file_path=a.txt", nil)
	r.ServeHTTP(wGateway, reqGateway)
	if wGateway.Code != http.StatusNotFound {
		t.Fatalf("expected provider daemon to return 404 on /gateway/*, got %d", wGateway.Code)
	}

	wSp := httptest.NewRecorder()
	reqSp := httptest.NewRequest(http.MethodGet, "/sp/retrieval/fetch/0xabc?deal_id=1&owner=nil1x&file_path=a.txt", nil)
	r.ServeHTTP(wSp, reqSp)
	if wSp.Code == http.StatusNotFound {
		t.Fatalf("expected provider daemon to expose /sp/retrieval/* routes")
	}

	for _, path := range []string{
		"/sp/retrieval/list-files/0xabc?deal_id=1&owner=nil1x",
		"/sp/retrieval/slab/0xabc?deal_id=1&owner=nil1x",
		"/sp/retrieval/manifest-info/0xabc?deal_id=1&owner=nil1x",
		"/sp/retrieval/mdu-kzg/0xabc/0?deal_id=1&owner=nil1x",
		"/sp/retrieval/debug/raw-fetch/0xabc",
	} {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		r.ServeHTTP(w, req)
		if w.Code != http.StatusNotFound {
			t.Fatalf("expected provider daemon to hide %s, got %d", path, w.Code)
		}
	}
}

func TestUserGatewayRoutes_DoNotExposeProviderSurface(t *testing.T) {
	r := mux.NewRouter()
	registerGatewayDealLifecycleRoutes(r)
	registerUserGatewayRoutes(r, true)

	wSp := httptest.NewRecorder()
	reqSp := httptest.NewRequest(http.MethodGet, "/sp/shard?deal_id=1&mdu_index=0&slot=0&manifest_root=0x01", nil)
	r.ServeHTTP(wSp, reqSp)
	if wSp.Code != http.StatusNotFound {
		t.Fatalf("expected user gateway to return 404 on /sp/*, got %d", wSp.Code)
	}

	wGateway := httptest.NewRecorder()
	reqGateway := httptest.NewRequest(http.MethodGet, "/gateway/fetch/0xabc?deal_id=1&owner=nil1x&file_path=a.txt", nil)
	reqGateway.Header.Set("Range", "bytes=0-0")
	r.ServeHTTP(wGateway, reqGateway)
	if wGateway.Code == http.StatusNotFound {
		t.Fatalf("expected user gateway to expose /gateway/* routes")
	}
}

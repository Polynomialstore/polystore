package main

import (
	"net/http/httptest"
	"sync"
	"testing"
)

func resetGatewayAuthStateForTest() {
	gatewayAuthToken = ""
	gatewayAuthOnce = sync.Once{}
}

func TestGatewayToProviderAuthToken_DefaultDeterministic(t *testing.T) {
	t.Setenv("POLYSTORE_GATEWAY_SP_AUTH", "")
	resetGatewayAuthStateForTest()

	got := gatewayToProviderAuthToken()
	if got != defaultGatewayToProviderAuthToken {
		t.Fatalf("expected default token %q, got %q", defaultGatewayToProviderAuthToken, got)
	}

	got2 := gatewayToProviderAuthToken()
	if got2 != got {
		t.Fatalf("expected cached token to stay stable: %q != %q", got2, got)
	}
}

func TestGatewayToProviderAuthToken_EnvOverride(t *testing.T) {
	t.Setenv("POLYSTORE_GATEWAY_SP_AUTH", "  custom-shared-token  ")
	resetGatewayAuthStateForTest()

	got := gatewayToProviderAuthToken()
	if got != "custom-shared-token" {
		t.Fatalf("expected env override token, got %q", got)
	}
}

func TestIsGatewayAuthorized_DefaultToken(t *testing.T) {
	t.Setenv("POLYSTORE_GATEWAY_SP_AUTH", "")
	resetGatewayAuthStateForTest()

	req := httptest.NewRequest("GET", "/sp/shard", nil)
	req.Header.Set(gatewayAuthHeader, defaultGatewayToProviderAuthToken)
	if !isGatewayAuthorized(req) {
		t.Fatalf("expected request to be authorized with default token")
	}

	req.Header.Set(gatewayAuthHeader, "wrong-token")
	if isGatewayAuthorized(req) {
		t.Fatalf("expected request with wrong token to be rejected")
	}
}

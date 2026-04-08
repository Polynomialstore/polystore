package main

import (
	"net/http"
	"os"
	"strings"
	"sync"
)

const gatewayAuthHeader = "X-Nil-Gateway-Auth"
const defaultGatewayToProviderAuthToken = "nilstore-devnet-shared-gateway-auth"

var (
	gatewayAuthToken string
	gatewayAuthOnce  sync.Once
)

func gatewayToProviderAuthToken() string {
	gatewayAuthOnce.Do(func() {
		if v := strings.TrimSpace(os.Getenv("NIL_GATEWAY_SP_AUTH")); v != "" {
			gatewayAuthToken = v
			return
		}
		// Devnet default: shared deterministic token so multi-process gateways/providers
		// can authenticate each other without per-host manual provisioning.
		// Production deployments should override with NIL_GATEWAY_SP_AUTH.
		gatewayAuthToken = defaultGatewayToProviderAuthToken
	})
	return gatewayAuthToken
}

func isGatewayAuthorized(r *http.Request) bool {
	if r == nil {
		return false
	}
	token := strings.TrimSpace(r.Header.Get(gatewayAuthHeader))
	expected := gatewayToProviderAuthToken()
	if expected == "" {
		// If no secret is configured and rand.Read fails, do not block devnet.
		return true
	}
	return token == expected
}

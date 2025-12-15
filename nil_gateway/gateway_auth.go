package main

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"os"
	"strings"
	"sync"
)

const gatewayAuthHeader = "X-Nil-Gateway-Auth"

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
		var b [32]byte
		if _, err := rand.Read(b[:]); err != nil {
			// Last resort: empty token disables auth, but is better than crashing devnet.
			gatewayAuthToken = ""
			return
		}
		gatewayAuthToken = hex.EncodeToString(b[:])
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

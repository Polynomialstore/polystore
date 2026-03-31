package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func mustStatusHTTPMultiaddr(t *testing.T, raw string) string {
	t.Helper()

	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse url %q: %v", raw, err)
	}
	host, port, err := net.SplitHostPort(parsed.Host)
	if err != nil {
		t.Fatalf("split host/port %q: %v", parsed.Host, err)
	}
	proto := "dns4"
	if ip := net.ParseIP(host); ip != nil {
		if ip.To4() != nil {
			proto = "ip4"
		} else {
			proto = "ip6"
		}
	}
	return fmt.Sprintf("/%s/%s/tcp/%s/%s", proto, host, port, parsed.Scheme)
}

func withProviderStatusGlobals(t *testing.T, newLCDBase, newProviderBase, newUploadDir, newHomeDir, newChainID, newNodeAddr string) {
	t.Helper()

	oldLCDBase := lcdBase
	oldProviderBase := providerBase
	oldUploadDir := uploadDir
	oldHomeDir := homeDir
	oldChainID := chainID
	oldNodeAddr := nodeAddr

	lcdBase = newLCDBase
	providerBase = newProviderBase
	uploadDir = newUploadDir
	homeDir = newHomeDir
	chainID = newChainID
	nodeAddr = newNodeAddr

	t.Cleanup(func() {
		lcdBase = oldLCDBase
		providerBase = oldProviderBase
		uploadDir = oldUploadDir
		homeDir = oldHomeDir
		chainID = oldChainID
		nodeAddr = oldNodeAddr
	})
}

func requireIssueContains(t *testing.T, issues []string, want string) {
	t.Helper()
	for _, issue := range issues {
		if strings.Contains(issue, want) {
			return
		}
	}
	t.Fatalf("expected issue containing %q, got %#v", want, issues)
}

func TestGatewayStatusIncludesProviderDaemonDetails(t *testing.T) {
	resetProviderAddressCacheForTest(t)
	t.Setenv("NIL_RUNTIME_PERSONA", "provider-daemon")
	t.Setenv("NIL_PROVIDER_KEY", "provider-status")
	t.Setenv("NIL_PROVIDER_ADDRESS", "nil1providerstatus")
	t.Setenv("NIL_PROVIDER_PAIRING_ID", "pair-status-001")
	t.Setenv("NIL_GATEWAY_SP_AUTH", "shared-secret")

	localSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer localSrv.Close()

	publicSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer publicSrv.Close()

	publicEndpoint := mustStatusHTTPMultiaddr(t, publicSrv.URL)
	t.Setenv("NIL_LISTEN_ADDR", localSrv.URL)
	t.Setenv("NIL_PROVIDER_ENDPOINTS", publicEndpoint)

	lcdSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/cosmos/base/tendermint/v1beta1/node_info":
			_ = json.NewEncoder(w).Encode(map[string]any{"default_node_info": map[string]any{}})
		case "/nilchain/nilchain/v1/providers/nil1providerstatus":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"provider": map[string]any{
					"address":      "nil1providerstatus",
					"status":       "PROVIDER_STATUS_ACTIVE",
					"capabilities": "General",
					"endpoints":    []string{publicEndpoint},
					"draining":     false,
				},
			})
		case "/nilchain/nilchain/v1/provider-pairings/nil1providerstatus":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"pairing": map[string]any{
					"provider":      "nil1providerstatus",
					"operator":      "nil1operatorstatus",
					"pairing_id":    "pair-status-001",
					"paired_height": "88",
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer lcdSrv.Close()

	withProviderStatusGlobals(t, lcdSrv.URL, "", t.TempDir(), t.TempDir(), "20260211", "https://rpc.nilstore.org")

	req := httptest.NewRequest(http.MethodGet, "/status", nil)
	w := httptest.NewRecorder()

	GatewayStatus(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("unexpected status code: got=%d want=%d", w.Code, http.StatusOK)
	}

	var status gatewayStatusResponse
	if err := json.NewDecoder(w.Body).Decode(&status); err != nil {
		t.Fatalf("decode status response: %v", err)
	}
	if status.Provider == nil {
		t.Fatal("expected provider status details")
	}
	if status.Persona != "provider-daemon" {
		t.Fatalf("unexpected persona: got=%q", status.Persona)
	}
	if !status.Dependencies["lcd_reachable"] {
		t.Fatal("expected lcd_reachable=true")
	}
	if !status.Dependencies["sp_reachable"] {
		t.Fatal("expected sp_reachable=true")
	}
	if status.Provider.Address != "nil1providerstatus" {
		t.Fatalf("unexpected provider address: got=%q", status.Provider.Address)
	}
	if status.Provider.PairingStatus != "paired" {
		t.Fatalf("unexpected pairing status: got=%q want=%q", status.Provider.PairingStatus, "paired")
	}
	if status.Provider.PairedOperator != "nil1operatorstatus" {
		t.Fatalf("unexpected paired operator: got=%q", status.Provider.PairedOperator)
	}
	if status.Provider.RegistrationStatus != "registered" {
		t.Fatalf("unexpected registration status: got=%q want=%q", status.Provider.RegistrationStatus, "registered")
	}
	if status.Provider.LocalBase != strings.TrimRight(localSrv.URL, "/") {
		t.Fatalf("unexpected local base: got=%q want=%q", status.Provider.LocalBase, strings.TrimRight(localSrv.URL, "/"))
	}
	if status.Provider.PublicBase != strings.TrimRight(publicSrv.URL, "/") {
		t.Fatalf("unexpected public base: got=%q want=%q", status.Provider.PublicBase, strings.TrimRight(publicSrv.URL, "/"))
	}
	if !status.Provider.LocalHealthOK {
		t.Fatal("expected local health to be reachable")
	}
	if !status.Provider.PublicHealthOK {
		t.Fatal("expected public health to be reachable")
	}
	if !status.Provider.SpAuthPresent {
		t.Fatal("expected sp_auth_present=true")
	}
	if len(status.Issues) != 0 {
		t.Fatalf("expected no provider issues, got %#v", status.Issues)
	}
}

func TestGatewayStatusReportsPendingProviderPairing(t *testing.T) {
	resetProviderAddressCacheForTest(t)
	t.Setenv("NIL_RUNTIME_PERSONA", "provider-daemon")
	t.Setenv("NIL_PROVIDER_KEY", "provider-pending")
	t.Setenv("NIL_PROVIDER_ADDRESS", "nil1providerpending")
	t.Setenv("NIL_PROVIDER_PAIRING_ID", "pair-pending-001")
	t.Setenv("NIL_GATEWAY_SP_AUTH", "shared-secret")

	localSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer localSrv.Close()

	publicEndpoint := mustStatusHTTPMultiaddr(t, localSrv.URL)
	t.Setenv("NIL_LISTEN_ADDR", localSrv.URL)
	t.Setenv("NIL_PROVIDER_ENDPOINTS", publicEndpoint)

	lcdSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/cosmos/base/tendermint/v1beta1/node_info":
			_ = json.NewEncoder(w).Encode(map[string]any{"default_node_info": map[string]any{}})
		case "/cosmos/base/tendermint/v1beta1/blocks/latest":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"block": map[string]any{
					"header": map[string]any{"height": "40"},
				},
			})
		case "/nilchain/nilchain/v1/providers/nil1providerpending":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"provider": map[string]any{
					"address":   "nil1providerpending",
					"status":    "PROVIDER_STATUS_ACTIVE",
					"endpoints": []string{publicEndpoint},
					"draining":  false,
				},
			})
		case "/nilchain/nilchain/v1/provider-pairings/nil1providerpending":
			http.NotFound(w, r)
		case "/nilchain/nilchain/v1/provider-pairings/pending/pair-pending-001":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"pairing": map[string]any{
					"pairing_id":    "pair-pending-001",
					"operator":      "nil1pendingoperator",
					"expires_at":    "55",
					"opened_height": "22",
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer lcdSrv.Close()

	withProviderStatusGlobals(t, lcdSrv.URL, "", t.TempDir(), t.TempDir(), "20260211", "https://rpc.nilstore.org")

	req := httptest.NewRequest(http.MethodGet, "/status", nil)
	w := httptest.NewRecorder()
	GatewayStatus(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("unexpected status code: got=%d want=%d", w.Code, http.StatusOK)
	}

	var status gatewayStatusResponse
	if err := json.NewDecoder(w.Body).Decode(&status); err != nil {
		t.Fatalf("decode status response: %v", err)
	}
	if status.Provider == nil {
		t.Fatal("expected provider status details")
	}
	if status.Provider.PairingStatus != "pending" {
		t.Fatalf("unexpected pairing status: got=%q want=%q", status.Provider.PairingStatus, "pending")
	}
	if status.Provider.PendingOperator != "nil1pendingoperator" {
		t.Fatalf("unexpected pending operator: got=%q", status.Provider.PendingOperator)
	}
	if status.Provider.PendingExpiresAt != 55 {
		t.Fatalf("unexpected pending expiry: got=%d want=%d", status.Provider.PendingExpiresAt, 55)
	}
	if status.Provider.LatestHeight != 40 {
		t.Fatalf("unexpected latest height: got=%d want=%d", status.Provider.LatestHeight, 40)
	}
	requireIssueContains(t, status.Issues, "pending confirmation")
}

func TestGatewayStatusReportsProviderDaemonIssues(t *testing.T) {
	resetProviderAddressCacheForTest(t)
	t.Setenv("NIL_RUNTIME_PERSONA", "provider-daemon")
	t.Setenv("NIL_PROVIDER_KEY", "provider-issues")
	t.Setenv("NIL_PROVIDER_ADDRESS", "nil1providerissues")
	t.Setenv("NIL_PROVIDER_PAIRING_ID", "pair-missing-001")
	t.Setenv("NIL_GATEWAY_SP_AUTH", "")
	t.Setenv("NIL_LISTEN_ADDR", "http://127.0.0.1:1")
	t.Setenv("NIL_PROVIDER_ENDPOINTS", "")

	lcdSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/cosmos/base/tendermint/v1beta1/node_info":
			_ = json.NewEncoder(w).Encode(map[string]any{"default_node_info": map[string]any{}})
		case "/nilchain/nilchain/v1/providers/nil1providerissues":
			http.NotFound(w, r)
		case "/nilchain/nilchain/v1/provider-pairings/nil1providerissues":
			http.NotFound(w, r)
		case "/nilchain/nilchain/v1/provider-pairings/pending/pair-missing-001":
			http.NotFound(w, r)
		default:
			http.NotFound(w, r)
		}
	}))
	defer lcdSrv.Close()

	withProviderStatusGlobals(t, lcdSrv.URL, "", t.TempDir(), t.TempDir(), "20260211", "https://rpc.nilstore.org")

	req := httptest.NewRequest(http.MethodGet, "/status", nil)
	w := httptest.NewRecorder()
	GatewayStatus(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("unexpected status code: got=%d want=%d", w.Code, http.StatusOK)
	}

	var status gatewayStatusResponse
	if err := json.NewDecoder(w.Body).Decode(&status); err != nil {
		t.Fatalf("decode status response: %v", err)
	}
	if status.Provider == nil {
		t.Fatal("expected provider status details")
	}
	if status.Provider.PairingStatus != "not_found" {
		t.Fatalf("unexpected pairing status: got=%q want=%q", status.Provider.PairingStatus, "not_found")
	}
	if status.Provider.RegistrationStatus != "unregistered" {
		t.Fatalf("unexpected registration status: got=%q want=%q", status.Provider.RegistrationStatus, "unregistered")
	}
	if status.Dependencies["sp_reachable"] {
		t.Fatal("expected sp_reachable=false")
	}
	requireIssueContains(t, status.Issues, "NIL_GATEWAY_SP_AUTH is missing")
	requireIssueContains(t, status.Issues, "configured pairing id is not open on-chain")
	requireIssueContains(t, status.Issues, "provider is not registered on-chain")
	requireIssueContains(t, status.Issues, "provider endpoints are not configured")
	requireIssueContains(t, status.Issues, "local provider health endpoint is unreachable")
}

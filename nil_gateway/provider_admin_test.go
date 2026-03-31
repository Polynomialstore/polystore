package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	gethCrypto "github.com/ethereum/go-ethereum/crypto"

	"nilchain/x/nilchain/types"
)

const providerAdminTestPrivKey = "4f3edf983ac636a65a842ce7c78d9aa706d3b113b37a2b2d6f6fcf7e9f59b5f1"

func resetProviderAdminNonceCacheForTest(t *testing.T) {
	t.Helper()
	providerAdminNonceCache.mu.Lock()
	prev := providerAdminNonceCache.used
	providerAdminNonceCache.used = make(map[string]map[uint64]uint64)
	providerAdminNonceCache.mu.Unlock()
	t.Cleanup(func() {
		providerAdminNonceCache.mu.Lock()
		providerAdminNonceCache.used = prev
		providerAdminNonceCache.mu.Unlock()
	})
}

func providerAdminTestKey(t *testing.T) *ecdsa.PrivateKey {
	t.Helper()
	key, err := gethCrypto.HexToECDSA(providerAdminTestPrivKey)
	if err != nil {
		t.Fatalf("HexToECDSA: %v", err)
	}
	return key
}

func providerAdminOperatorNilAddress(t *testing.T) string {
	t.Helper()
	key := providerAdminTestKey(t)
	addr, err := evmHexToNilAddress(gethCrypto.PubkeyToAddress(key.PublicKey).Hex())
	if err != nil {
		t.Fatalf("evmHexToNilAddress: %v", err)
	}
	return addr
}

func signProviderAdminRequest(t *testing.T, provider string, action string, endpoint string, nonce uint64, expiresAt uint64) string {
	t.Helper()
	key := providerAdminTestKey(t)
	structHash := types.HashProviderAdminAction(provider, action, endpoint, nonce, expiresAt)
	digest := types.ComputeEIP712Digest(types.HashDomainSeparator(eip712ChainID()), structHash)
	sig, err := gethCrypto.Sign(digest, key)
	if err != nil {
		t.Fatalf("sign provider admin request: %v", err)
	}
	return "0x" + hex.EncodeToString(sig)
}

func newProviderAdminBody(t *testing.T, provider string, action string, endpoint string, nonce uint64, expiresAt uint64) *bytes.Reader {
	t.Helper()
	body, err := json.Marshal(providerAdminRequest{
		Provider:  provider,
		Action:    action,
		Endpoint:  endpoint,
		Nonce:     nonce,
		ExpiresAt: expiresAt,
		Signature: signProviderAdminRequest(t, provider, action, endpoint, nonce, expiresAt),
	})
	if err != nil {
		t.Fatalf("marshal provider admin request: %v", err)
	}
	return bytes.NewReader(body)
}

func setupProviderAdminStatusEnv(t *testing.T, providerAddress string, localURL string, lcdURL string) {
	t.Helper()
	resetProviderAddressCacheForTest(t)
	resetProviderAdminNonceCacheForTest(t)
	t.Setenv("NIL_RUNTIME_PERSONA", "provider-daemon")
	t.Setenv("NIL_PROVIDER_KEY", "provider-admin")
	t.Setenv("NIL_PROVIDER_ADDRESS", providerAddress)
	t.Setenv("NIL_LISTEN_ADDR", localURL)
	t.Setenv("NIL_GATEWAY_SP_AUTH", "shared-secret")
	withProviderStatusGlobals(t, lcdURL, "", t.TempDir(), t.TempDir(), "20260211", "https://rpc.nilstore.org")
}

func TestSpAdminStatus_AllowsPairedOperator(t *testing.T) {
	operator := providerAdminOperatorNilAddress(t)
	const provider = "nil1provideradminstatus"

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
	lcdSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/cosmos/base/tendermint/v1beta1/node_info":
			_ = json.NewEncoder(w).Encode(map[string]any{"default_node_info": map[string]any{}})
		case "/nilchain/nilchain/v1/providers/" + provider:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"provider": map[string]any{
					"address":   provider,
					"status":    "PROVIDER_STATUS_ACTIVE",
					"endpoints": []string{publicEndpoint},
					"draining":  false,
				},
			})
		case "/nilchain/nilchain/v1/provider-pairings/" + provider:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"pairing": map[string]any{
					"provider":      provider,
					"operator":      operator,
					"pairing_id":    "pair-admin-001",
					"paired_height": "42",
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer lcdSrv.Close()

	setupProviderAdminStatusEnv(t, provider, localSrv.URL, lcdSrv.URL)

	nonce := uint64(1001)
	expiresAt := uint64(time.Now().Unix()) + 300
	req := httptest.NewRequest(http.MethodPost, "/sp/admin/status", newProviderAdminBody(t, provider, providerAdminActionStatusRefresh, "", nonce, expiresAt))
	w := httptest.NewRecorder()

	SpAdminStatus(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("unexpected status code: got=%d body=%s", w.Code, w.Body.String())
	}

	var resp providerAdminResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Action != providerAdminActionStatusRefresh {
		t.Fatalf("unexpected action: got=%q", resp.Action)
	}
	if resp.AuthorizedOperator != operator {
		t.Fatalf("unexpected authorized operator: got=%q want=%q", resp.AuthorizedOperator, operator)
	}
	if resp.Provider == nil || resp.Provider.Address != provider {
		t.Fatalf("unexpected provider response: %#v", resp.Provider)
	}
	if !resp.Provider.PublicHealthOK {
		t.Fatal("expected public health ok")
	}
}

func TestSpAdminDoctor_RejectsNonceReplay(t *testing.T) {
	operator := providerAdminOperatorNilAddress(t)
	const provider = "nil1provideradmindoctor"

	localSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			w.WriteHeader(http.StatusOK)
			return
		}
		http.NotFound(w, r)
	}))
	defer localSrv.Close()

	publicEndpoint := mustStatusHTTPMultiaddr(t, localSrv.URL)
	lcdSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/cosmos/base/tendermint/v1beta1/node_info":
			_ = json.NewEncoder(w).Encode(map[string]any{"default_node_info": map[string]any{}})
		case "/nilchain/nilchain/v1/providers/" + provider:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"provider": map[string]any{
					"address":   provider,
					"status":    "PROVIDER_STATUS_ACTIVE",
					"endpoints": []string{publicEndpoint},
				},
			})
		case "/nilchain/nilchain/v1/provider-pairings/" + provider:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"pairing": map[string]any{
					"provider":      provider,
					"operator":      operator,
					"pairing_id":    "pair-admin-002",
					"paired_height": "50",
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer lcdSrv.Close()

	setupProviderAdminStatusEnv(t, provider, localSrv.URL, lcdSrv.URL)

	nonce := uint64(2002)
	expiresAt := uint64(time.Now().Unix()) + 300
	body := newProviderAdminBody(t, provider, providerAdminActionRunDoctor, "", nonce, expiresAt)
	req := httptest.NewRequest(http.MethodPost, "/sp/admin/doctor", body)
	w := httptest.NewRecorder()
	SpAdminDoctor(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("unexpected first status code: got=%d body=%s", w.Code, w.Body.String())
	}

	req2 := httptest.NewRequest(http.MethodPost, "/sp/admin/doctor", newProviderAdminBody(t, provider, providerAdminActionRunDoctor, "", nonce, expiresAt))
	w2 := httptest.NewRecorder()
	SpAdminDoctor(w2, req2)
	if w2.Code != http.StatusForbidden {
		t.Fatalf("expected replay to be rejected, got=%d body=%s", w2.Code, w2.Body.String())
	}
	if !strings.Contains(w2.Body.String(), "nonce has already been used") {
		t.Fatalf("expected replay error in body, got=%s", w2.Body.String())
	}
}

func TestSpAdminRotateEndpoint_UsesUpdateTransaction(t *testing.T) {
	operator := providerAdminOperatorNilAddress(t)
	const provider = "nil1provideradminrotate"
	const endpoint = "/dns4/new.example.com/tcp/443/https"

	localSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			w.WriteHeader(http.StatusOK)
			return
		}
		http.NotFound(w, r)
	}))
	defer localSrv.Close()

	lcdSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/cosmos/base/tendermint/v1beta1/node_info":
			_ = json.NewEncoder(w).Encode(map[string]any{"default_node_info": map[string]any{}})
		case "/nilchain/nilchain/v1/providers/" + provider:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"provider": map[string]any{
					"address":   provider,
					"status":    "PROVIDER_STATUS_ACTIVE",
					"endpoints": []string{endpoint},
				},
			})
		case "/nilchain/nilchain/v1/provider-pairings/" + provider:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"pairing": map[string]any{
					"provider":      provider,
					"operator":      operator,
					"pairing_id":    "pair-admin-003",
					"paired_height": "60",
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer lcdSrv.Close()

	setupProviderAdminStatusEnv(t, provider, localSrv.URL, lcdSrv.URL)

	var gotName string
	var gotArgs []string
	setupMockCombinedOutput(t, func(_ context.Context, name string, args ...string) ([]byte, error) {
		gotName = name
		gotArgs = append([]string(nil), args...)
		return []byte("tx accepted"), nil
	})

	nonce := uint64(3003)
	expiresAt := uint64(time.Now().Unix()) + 300
	req := httptest.NewRequest(http.MethodPost, "/sp/admin/endpoint", newProviderAdminBody(t, provider, providerAdminActionRotateEndpoint, endpoint, nonce, expiresAt))
	w := httptest.NewRecorder()
	SpAdminRotateEndpoint(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("unexpected status code: got=%d body=%s", w.Code, w.Body.String())
	}
	if !strings.HasSuffix(gotName, "nilchaind") && gotName != "nilchaind" {
		t.Fatalf("expected nilchaind command, got=%q", gotName)
	}
	if !strings.Contains(strings.Join(gotArgs, " "), "update-provider-endpoints") {
		t.Fatalf("expected update-provider-endpoints args, got=%v", gotArgs)
	}
	if !strings.Contains(strings.Join(gotArgs, " "), endpoint) {
		t.Fatalf("expected endpoint in args, got=%v", gotArgs)
	}

	var resp providerAdminResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Endpoint != endpoint {
		t.Fatalf("unexpected endpoint: got=%q want=%q", resp.Endpoint, endpoint)
	}
	if strings.TrimSpace(resp.TxOutput) != "tx accepted" {
		t.Fatalf("unexpected tx output: got=%q", resp.TxOutput)
	}
}

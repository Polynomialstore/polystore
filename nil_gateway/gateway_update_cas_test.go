package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestGatewayUpdateDealContent_RejectsStalePreviousManifestRoot(t *testing.T) {
	oldRelay := txRelayEnabled
	txRelayEnabled = true
	t.Cleanup(func() { txRelayEnabled = oldRelay })

	expectedRoot := mustTestManifestRoot(t, "gateway-cas-legacy")
	lcdSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"deal": map[string]any{
				"owner":         "nil1owner",
				"manifest_root": expectedRoot.Canonical,
				"end_block":     999999,
			},
		})
	}))
	defer lcdSrv.Close()

	oldLCD := lcdBase
	lcdBase = lcdSrv.URL
	t.Cleanup(func() { lcdBase = oldLCD })

	body := `{
		"creator":"nil1owner",
		"deal_id":901,
		"previous_manifest_root":"` + mustTestManifestRoot(t, "gateway-cas-stale").Canonical + `",
		"cid":"` + mustTestManifestRoot(t, "gateway-cas-next").Canonical + `",
		"size_bytes":123,
		"total_mdus":3,
		"witness_mdus":1
	}`

	req := httptest.NewRequest(http.MethodPost, "/gateway/update-deal-content", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	GatewayUpdateDealContent(w, req)

	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "stale previous_manifest_root") {
		t.Fatalf("expected stale previous_manifest_root error, got %q", w.Body.String())
	}
}

func TestGatewayUpdateDealContentFromEvm_RejectsStalePreviousManifestRoot(t *testing.T) {
	oldRelay := txRelayEnabled
	txRelayEnabled = true
	t.Cleanup(func() { txRelayEnabled = oldRelay })

	expectedRoot := mustTestManifestRoot(t, "gateway-cas-evm-current")
	lcdSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"deal": map[string]any{
				"owner":         testDealOwner(t),
				"manifest_root": expectedRoot.Canonical,
				"end_block":     999999,
			},
		})
	}))
	defer lcdSrv.Close()

	oldLCD := lcdBase
	lcdBase = lcdSrv.URL
	t.Cleanup(func() { lcdBase = oldLCD })

	body := `{
		"intent":{
			"creator_evm":"0x1111222233334444555566667777888899990000",
			"deal_id":902,
			"previous_manifest_root":"` + mustTestManifestRoot(t, "gateway-cas-evm-stale").Canonical + `",
			"cid":"` + mustTestManifestRoot(t, "gateway-cas-evm-next").Canonical + `",
			"size_bytes":123,
			"total_mdus":3,
			"witness_mdus":1,
			"nonce":1,
			"chain_id":"test-1"
		},
		"evm_signature":"0xdeadbeef"
	}`

	req := httptest.NewRequest(http.MethodPost, "/gateway/update-deal-content-evm", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	GatewayUpdateDealContentFromEvm(w, req)

	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "stale previous_manifest_root") {
		t.Fatalf("expected stale previous_manifest_root error, got %q", w.Body.String())
	}
}

func TestGatewayUpdateDealContent_ForwardsPreviousManifestRootToCLI(t *testing.T) {
	oldRelay := txRelayEnabled
	txRelayEnabled = true
	t.Cleanup(func() { txRelayEnabled = oldRelay })

	useTempUploadDir(t)
	currentRoot := mustTestManifestRoot(t, "gateway-cas-cli-current")
	nextRoot := mustTestManifestRoot(t, "gateway-cas-cli-next")

	lcdSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"deal": map[string]any{
				"owner":         "nil1owner",
				"manifest_root": currentRoot.Canonical,
				"end_block":     999999,
			},
		})
	}))
	defer lcdSrv.Close()

	oldLCD := lcdBase
	lcdBase = lcdSrv.URL
	t.Cleanup(func() { lcdBase = oldLCD })

	var capturedArgs []string
	setupMockCombinedOutput(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		capturedArgs = append([]string(nil), args...)
		return []byte(`{"txhash":"0xabc","code":0,"raw_log":""}`), nil
	})

	body := `{
		"creator":"nil1owner",
		"deal_id":903,
		"previous_manifest_root":"` + currentRoot.Canonical + `",
		"cid":"` + nextRoot.Canonical + `",
		"size_bytes":123,
		"total_mdus":3,
		"witness_mdus":1
	}`

	req := httptest.NewRequest(http.MethodPost, "/gateway/update-deal-content", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	GatewayUpdateDealContent(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	joined := strings.Join(capturedArgs, " ")
	if !strings.Contains(joined, "--previous-manifest-root "+currentRoot.Canonical) {
		t.Fatalf("expected CLI args to include previous manifest root, got %v", capturedArgs)
	}
}

func TestGatewayUpdateDealContentFromEvm_ForwardsPreviousManifestRootInPayload(t *testing.T) {
	oldRelay := txRelayEnabled
	txRelayEnabled = true
	t.Cleanup(func() { txRelayEnabled = oldRelay })

	useTempUploadDir(t)
	currentRoot := mustTestManifestRoot(t, "gateway-cas-evm-payload-current")
	nextRoot := mustTestManifestRoot(t, "gateway-cas-evm-payload-next")

	lcdSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/cosmos/tx/v1beta1/txs/") {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"tx_response": map[string]any{
					"txhash": "0xabc",
					"code":   0,
					"logs":   []any{},
					"events": []any{},
				},
			})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"deal": map[string]any{
				"owner":         testDealOwner(t),
				"manifest_root": currentRoot.Canonical,
				"end_block":     999999,
			},
		})
	}))
	defer lcdSrv.Close()

	oldLCD := lcdBase
	lcdBase = lcdSrv.URL
	t.Cleanup(func() { lcdBase = oldLCD })

	var payloadPreviousRoot any
	setupMockCombinedOutput(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if len(args) >= 4 && args[0] == "tx" && args[1] == "nilchain" && args[2] == "update-deal-content-from-evm" {
			payloadBytes, err := os.ReadFile(args[3])
			if err != nil {
				t.Fatalf("read payload: %v", err)
			}
			var payload struct {
				Intent map[string]any `json:"intent"`
			}
			if err := json.Unmarshal(payloadBytes, &payload); err != nil {
				t.Fatalf("decode payload: %v", err)
			}
			payloadPreviousRoot = payload.Intent["previous_manifest_root"]
			return []byte(`{"txhash":"0xabc","code":0,"raw_log":""}`), nil
		}
		return []byte(`{"txhash":"0xabc","code":0,"raw_log":""}`), nil
	})

	body := `{
		"intent":{
			"creator_evm":"0x1111222233334444555566667777888899990000",
			"deal_id":904,
			"previous_manifest_root":"` + currentRoot.Canonical + `",
			"cid":"` + nextRoot.Canonical + `",
			"size_bytes":123,
			"total_mdus":3,
			"witness_mdus":1,
			"nonce":1,
			"chain_id":"test-1"
		},
		"evm_signature":"0xdeadbeef"
	}`

	req := httptest.NewRequest(http.MethodPost, "/gateway/update-deal-content-evm", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	GatewayUpdateDealContentFromEvm(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	if payloadPreviousRoot != currentRoot.Canonical {
		t.Fatalf("expected previous_manifest_root %q, got %#v", currentRoot.Canonical, payloadPreviousRoot)
	}
}

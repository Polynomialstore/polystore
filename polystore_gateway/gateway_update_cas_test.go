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
	resetPolyfsCASStatusCountersForTest()
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
	if got := polyfsCASStatusSnapshotForStatus()["polyfs_cas_preflight_conflicts_legacy"]; got != "1" {
		t.Fatalf("expected polyfs_cas_preflight_conflicts_legacy=1, got %q", got)
	}
}

func TestGatewayUpdateDealContentFromEvm_RejectsStalePreviousManifestRoot(t *testing.T) {
	resetPolyfsCASStatusCountersForTest()
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
	if got := polyfsCASStatusSnapshotForStatus()["polyfs_cas_preflight_conflicts_evm"]; got != "1" {
		t.Fatalf("expected polyfs_cas_preflight_conflicts_evm=1, got %q", got)
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

func TestGatewayUpdateDealContent_CompareAndSwapRace(t *testing.T) {
	oldRelay := txRelayEnabled
	txRelayEnabled = true
	t.Cleanup(func() { txRelayEnabled = oldRelay })

	useTempUploadDir(t)
	currentRoot := mustTestManifestRoot(t, "gateway-cas-race-current")
	nextRoot := mustTestManifestRoot(t, "gateway-cas-race-next")
	staleRoot := mustTestManifestRoot(t, "gateway-cas-race-stale-next")

	activeRoot := currentRoot.Canonical
	lcdSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"deal": map[string]any{
				"owner":         "nil1owner",
				"manifest_root": activeRoot,
				"end_block":     999999,
			},
		})
	}))
	defer lcdSrv.Close()

	oldLCD := lcdBase
	lcdBase = lcdSrv.URL
	t.Cleanup(func() { lcdBase = oldLCD })

	callCount := 0
	setupMockCombinedOutput(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		callCount += 1
		return []byte(`{"txhash":"0xabc","code":0,"raw_log":""}`), nil
	})

	firstBody := `{
		"creator":"nil1owner",
		"deal_id":905,
		"previous_manifest_root":"` + currentRoot.Canonical + `",
		"cid":"` + nextRoot.Canonical + `",
		"size_bytes":123,
		"total_mdus":3,
		"witness_mdus":1
	}`

	firstReq := httptest.NewRequest(http.MethodPost, "/gateway/update-deal-content", strings.NewReader(firstBody))
	firstReq.Header.Set("Content-Type", "application/json")
	firstW := httptest.NewRecorder()
	GatewayUpdateDealContent(firstW, firstReq)

	if firstW.Code != http.StatusOK {
		t.Fatalf("expected first request 200, got %d body=%s", firstW.Code, firstW.Body.String())
	}
	if callCount != 1 {
		t.Fatalf("expected first request to relay once, got %d", callCount)
	}

	activeRoot = nextRoot.Canonical

	staleBody := `{
		"creator":"nil1owner",
		"deal_id":905,
		"previous_manifest_root":"` + currentRoot.Canonical + `",
		"cid":"` + staleRoot.Canonical + `",
		"size_bytes":124,
		"total_mdus":4,
		"witness_mdus":1
	}`

	staleReq := httptest.NewRequest(http.MethodPost, "/gateway/update-deal-content", strings.NewReader(staleBody))
	staleReq.Header.Set("Content-Type", "application/json")
	staleW := httptest.NewRecorder()
	GatewayUpdateDealContent(staleW, staleReq)

	if staleW.Code != http.StatusConflict {
		t.Fatalf("expected stale request 409, got %d body=%s", staleW.Code, staleW.Body.String())
	}
	if !strings.Contains(staleW.Body.String(), "stale previous_manifest_root") {
		t.Fatalf("expected stale previous_manifest_root error, got %q", staleW.Body.String())
	}
	if callCount != 1 {
		t.Fatalf("expected stale request not to relay, got %d relay calls", callCount)
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
		if len(args) >= 4 && args[0] == "tx" && args[1] == "polystorechain" && args[2] == "update-deal-content-from-evm" {
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

func TestGatewayUpdateDealContentFromEvm_CompareAndSwapRace(t *testing.T) {
	resetPolyfsCASStatusCountersForTest()
	oldRelay := txRelayEnabled
	txRelayEnabled = true
	t.Cleanup(func() { txRelayEnabled = oldRelay })

	useTempUploadDir(t)
	currentRoot := mustTestManifestRoot(t, "gateway-cas-evm-race-current")
	nextRoot := mustTestManifestRoot(t, "gateway-cas-evm-race-next")
	staleRoot := mustTestManifestRoot(t, "gateway-cas-evm-race-stale")

	activeRoot := currentRoot.Canonical
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
				"manifest_root": activeRoot,
				"end_block":     999999,
			},
		})
	}))
	defer lcdSrv.Close()

	oldLCD := lcdBase
	lcdBase = lcdSrv.URL
	t.Cleanup(func() { lcdBase = oldLCD })

	callCount := 0
	setupMockCombinedOutput(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		callCount += 1
		return []byte(`{"txhash":"0xabc","code":0,"raw_log":""}`), nil
	})

	firstBody := `{
		"intent":{
			"creator_evm":"0x1111222233334444555566667777888899990000",
			"deal_id":906,
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

	firstReq := httptest.NewRequest(http.MethodPost, "/gateway/update-deal-content-evm", strings.NewReader(firstBody))
	firstReq.Header.Set("Content-Type", "application/json")
	firstW := httptest.NewRecorder()
	GatewayUpdateDealContentFromEvm(firstW, firstReq)

	if firstW.Code != http.StatusOK {
		t.Fatalf("expected first request 200, got %d body=%s", firstW.Code, firstW.Body.String())
	}
	if callCount != 1 {
		t.Fatalf("expected first request to relay once, got %d", callCount)
	}

	activeRoot = nextRoot.Canonical

	staleBody := `{
		"intent":{
			"creator_evm":"0x1111222233334444555566667777888899990000",
			"deal_id":906,
			"previous_manifest_root":"` + currentRoot.Canonical + `",
			"cid":"` + staleRoot.Canonical + `",
			"size_bytes":124,
			"total_mdus":4,
			"witness_mdus":1,
			"nonce":2,
			"chain_id":"test-1"
		},
		"evm_signature":"0xdeadbeef"
	}`

	staleReq := httptest.NewRequest(http.MethodPost, "/gateway/update-deal-content-evm", strings.NewReader(staleBody))
	staleReq.Header.Set("Content-Type", "application/json")
	staleW := httptest.NewRecorder()
	GatewayUpdateDealContentFromEvm(staleW, staleReq)

	if staleW.Code != http.StatusConflict {
		t.Fatalf("expected stale request 409, got %d body=%s", staleW.Code, staleW.Body.String())
	}
	if !strings.Contains(staleW.Body.String(), "stale previous_manifest_root") {
		t.Fatalf("expected stale previous_manifest_root error, got %q", staleW.Body.String())
	}
	if callCount != 1 {
		t.Fatalf("expected stale request not to relay, got %d relay calls", callCount)
	}
}

func TestGatewayStatusIncludesPolyfsCASConflictSnapshot(t *testing.T) {
	resetPolyfsCASStatusCountersForTest()
	recordPolyfsCASPreflightConflict(polyfsCASPreflightConflictLegacy)
	recordPolyfsCASPreflightConflict(polyfsCASPreflightConflictEvm)
	recordPolyfsCASPreflightConflict(polyfsCASPreflightConflictEvm)
	recordPolyfsCASPreflightConflict(polyfsCASPreflightConflictUpload)

	oldLCDBase := lcdBase
	oldProviderBase := providerBase
	lcdBase = ""
	providerBase = ""
	t.Cleanup(func() {
		lcdBase = oldLCDBase
		providerBase = oldProviderBase
	})

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
	if status.Extra["polyfs_cas_preflight_conflicts_total"] != "4" {
		t.Fatalf("expected polyfs_cas_preflight_conflicts_total=4, got=%q", status.Extra["polyfs_cas_preflight_conflicts_total"])
	}
	if status.Extra["polyfs_cas_preflight_conflicts_legacy"] != "1" {
		t.Fatalf("expected polyfs_cas_preflight_conflicts_legacy=1, got=%q", status.Extra["polyfs_cas_preflight_conflicts_legacy"])
	}
	if status.Extra["polyfs_cas_preflight_conflicts_evm"] != "2" {
		t.Fatalf("expected polyfs_cas_preflight_conflicts_evm=2, got=%q", status.Extra["polyfs_cas_preflight_conflicts_evm"])
	}
	if status.Extra["polyfs_cas_preflight_conflicts_upload"] != "1" {
		t.Fatalf("expected polyfs_cas_preflight_conflicts_upload=1, got=%q", status.Extra["polyfs_cas_preflight_conflicts_upload"])
	}
}

package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSpUploadManifest_WritesManifestBin(t *testing.T) {
	useTempUploadDir(t)
	resetPolyfsCASStatusCountersForTest()
	resetPolyfsUploadRootPreflightCacheForTest()

	manifestRoot := mustTestManifestRoot(t, "sp-upload-manifest")
	dealID := uint64(1)
	owner := "nil1owner"

	srv := dynamicMockDealServer(map[uint64]struct {
		Owner string
		CID   string
	}{
		dealID: {Owner: owner, CID: ""},
	})
	defer srv.Close()
	oldLCD := lcdBase
	lcdBase = srv.URL
	t.Cleanup(func() { lcdBase = oldLCD })

	body := bytes.Repeat([]byte{0xAB}, 131072)
	req := httptest.NewRequest(http.MethodPost, "/sp/upload_manifest", bytes.NewReader(body))
	req.Header.Set("X-PolyStore-Deal-ID", "1")
	req.Header.Set("X-PolyStore-Manifest-Root", manifestRoot.Canonical)
	req.Header.Set(polystoreUploadPreviousManifestRootHeader, "")
	req.Header.Set("Content-Type", "application/octet-stream")

	w := httptest.NewRecorder()
	r := testRouter()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	path := filepath.Join(uploadDir, "deals", "1", manifestRoot.Key, "manifest.bin")
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read manifest.bin: %v", err)
	}
	if len(got) != len(body) {
		t.Fatalf("unexpected manifest.bin length: got=%d want=%d", len(got), len(body))
	}
}

func TestSpUploadManifest_RequiresHeaders(t *testing.T) {
	useTempUploadDir(t)

	srv := dynamicMockDealServer(map[uint64]struct {
		Owner string
		CID   string
	}{
		1: {Owner: "nil1owner", CID: ""},
	})
	defer srv.Close()
	oldLCD := lcdBase
	lcdBase = srv.URL
	t.Cleanup(func() { lcdBase = oldLCD })

	req := httptest.NewRequest(http.MethodPost, "/sp/upload_manifest", bytes.NewReader([]byte{0x01}))
	w := httptest.NewRecorder()
	r := testRouter()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}

	var payload map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &payload)
}

func TestSpUploadManifest_AcceptsSparseBodyWithFullSizeHeader(t *testing.T) {
	useTempUploadDir(t)
	resetPolyfsCASStatusCountersForTest()
	resetPolyfsUploadRootPreflightCacheForTest()

	manifestRoot := mustTestManifestRoot(t, "sp-upload-manifest-sparse")
	dealID := uint64(1)
	owner := "nil1owner"

	srv := dynamicMockDealServer(map[uint64]struct {
		Owner string
		CID   string
	}{
		dealID: {Owner: owner, CID: ""},
	})
	defer srv.Close()
	oldLCD := lcdBase
	lcdBase = srv.URL
	t.Cleanup(func() { lcdBase = oldLCD })

	body := bytes.Repeat([]byte{0xAC}, 1024)
	req := httptest.NewRequest(http.MethodPost, "/sp/upload_manifest", bytes.NewReader(body))
	req.Header.Set("X-PolyStore-Deal-ID", "1")
	req.Header.Set("X-PolyStore-Manifest-Root", manifestRoot.Canonical)
	req.Header.Set(polystoreUploadPreviousManifestRootHeader, "")
	req.Header.Set("X-PolyStore-Full-Size", "131072")
	req.Header.Set("Content-Type", "application/octet-stream")

	w := httptest.NewRecorder()
	r := testRouter()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	path := filepath.Join(uploadDir, "deals", "1", manifestRoot.Key, "manifest.bin")
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read manifest.bin: %v", err)
	}
	if len(got) != 131072 {
		t.Fatalf("unexpected manifest length: got=%d want=%d", len(got), 131072)
	}
	if !bytes.Equal(got[:len(body)], body) {
		t.Fatalf("stored manifest prefix mismatch")
	}
}

func TestSpUploadManifest_PromotesStagedGenerationArtifacts(t *testing.T) {
	useTempUploadDir(t)
	resetPolyfsCASStatusCountersForTest()
	resetPolyfsUploadRootPreflightCacheForTest()

	manifestRoot := mustTestManifestRoot(t, "sp-upload-staged-generation")
	dealID := uint64(1)
	owner := "nil1owner"
	generationID := "browser-run-123"

	srv := dynamicMockDealServer(map[uint64]struct {
		Owner string
		CID   string
	}{
		dealID: {Owner: owner, CID: ""},
	})
	defer srv.Close()
	oldLCD := lcdBase
	lcdBase = srv.URL
	t.Cleanup(func() { lcdBase = oldLCD })

	r := testRouter()

	mduReq := httptest.NewRequest(http.MethodPost, "/sp/upload_mdu", bytes.NewReader([]byte{0xAA}))
	mduReq.Header.Set("X-PolyStore-Deal-ID", "1")
	mduReq.Header.Set("X-PolyStore-Mdu-Index", "0")
	mduReq.Header.Set(polystoreUploadGenerationHeader, generationID)
	mduReq.Header.Set("X-PolyStore-Full-Size", "8388608")
	mduReq.Header.Set("Content-Type", "application/octet-stream")
	mduW := httptest.NewRecorder()
	r.ServeHTTP(mduW, mduReq)
	if mduW.Code != http.StatusOK {
		t.Fatalf("expected staged mdu upload 200, got %d: %s", mduW.Code, mduW.Body.String())
	}

	shardReq := httptest.NewRequest(http.MethodPost, "/sp/upload_shard", bytes.NewReader([]byte{0xBB}))
	shardReq.Header.Set("X-PolyStore-Deal-ID", "1")
	shardReq.Header.Set("X-PolyStore-Mdu-Index", "2")
	shardReq.Header.Set("X-PolyStore-Slot", "1")
	shardReq.Header.Set(polystoreUploadGenerationHeader, generationID)
	shardReq.Header.Set("X-PolyStore-Full-Size", "1024")
	shardReq.Header.Set("Content-Type", "application/octet-stream")
	shardW := httptest.NewRecorder()
	r.ServeHTTP(shardW, shardReq)
	if shardW.Code != http.StatusOK {
		t.Fatalf("expected staged shard upload 200, got %d: %s", shardW.Code, shardW.Body.String())
	}

	stageDir := stagedUploadDir(dealID, generationID)
	if _, err := os.Stat(filepath.Join(stageDir, "mdu_0.bin")); err != nil {
		t.Fatalf("expected staged mdu before manifest finalize: %v", err)
	}

	manifestReq := httptest.NewRequest(http.MethodPost, "/sp/upload_manifest", bytes.NewReader([]byte{0xCC}))
	manifestReq.Header.Set("X-PolyStore-Deal-ID", "1")
	manifestReq.Header.Set("X-PolyStore-Manifest-Root", manifestRoot.Canonical)
	manifestReq.Header.Set(polystoreUploadPreviousManifestRootHeader, "")
	manifestReq.Header.Set(polystoreUploadGenerationHeader, generationID)
	manifestReq.Header.Set("X-PolyStore-Full-Size", "131072")
	manifestReq.Header.Set("Content-Type", "application/octet-stream")
	manifestW := httptest.NewRecorder()
	r.ServeHTTP(manifestW, manifestReq)
	if manifestW.Code != http.StatusOK {
		t.Fatalf("expected staged manifest finalize 200, got %d: %s", manifestW.Code, manifestW.Body.String())
	}

	finalDir := filepath.Join(uploadDir, "deals", "1", manifestRoot.Key)
	for _, item := range []struct {
		name string
		size int64
	}{
		{name: "mdu_0.bin", size: 8388608},
		{name: "mdu_2_slot_1.bin", size: 1024},
		{name: "manifest.bin", size: 131072},
	} {
		info, err := os.Stat(filepath.Join(finalDir, item.name))
		if err != nil {
			t.Fatalf("expected promoted %s: %v", item.name, err)
		}
		if info.Size() != item.size {
			t.Fatalf("promoted %s size mismatch: got=%d want=%d", item.name, info.Size(), item.size)
		}
	}
	if _, err := os.Stat(stageDir); !os.IsNotExist(err) {
		t.Fatalf("expected staged generation to be removed, stat err=%v", err)
	}
}

func TestSpUploadManifest_RejectsStalePreviousManifestRoot(t *testing.T) {
	useTempUploadDir(t)
	resetPolyfsCASStatusCountersForTest()
	resetPolyfsUploadRootPreflightCacheForTest()

	manifestRoot := mustTestManifestRoot(t, "sp-upload-manifest-stale")
	currentRoot := mustTestManifestRoot(t, "sp-upload-manifest-current")

	srv := dynamicMockDealServer(map[uint64]struct {
		Owner string
		CID   string
	}{
		1: {Owner: "nil1owner", CID: currentRoot.Canonical},
	})
	defer srv.Close()
	oldLCD := lcdBase
	lcdBase = srv.URL
	t.Cleanup(func() { lcdBase = oldLCD })

	req := httptest.NewRequest(http.MethodPost, "/sp/upload_manifest", bytes.NewReader(bytes.Repeat([]byte{0xAC}, 1024)))
	req.Header.Set("X-PolyStore-Deal-ID", "1")
	req.Header.Set("X-PolyStore-Manifest-Root", manifestRoot.Canonical)
	req.Header.Set(polystoreUploadPreviousManifestRootHeader, mustTestManifestRoot(t, "sp-upload-manifest-stale-prev").Canonical)
	req.Header.Set("X-PolyStore-Full-Size", "131072")
	req.Header.Set("Content-Type", "application/octet-stream")

	w := httptest.NewRecorder()
	r := testRouter()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "stale previous_manifest_root") {
		t.Fatalf("expected stale previous_manifest_root error, got %q", w.Body.String())
	}
	if got := polyfsCASStatusSnapshotForStatus()["polyfs_cas_preflight_conflicts_upload"]; got != "1" {
		t.Fatalf("expected polyfs_cas_preflight_conflicts_upload=1, got %q", got)
	}
}

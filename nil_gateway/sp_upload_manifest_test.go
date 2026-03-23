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
	resetNilfsCASStatusCountersForTest()
	resetNilfsUploadRootPreflightCacheForTest()

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
	req.Header.Set("X-Nil-Deal-ID", "1")
	req.Header.Set("X-Nil-Manifest-Root", manifestRoot.Canonical)
	req.Header.Set(nilUploadPreviousManifestRootHeader, "")
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
	resetNilfsCASStatusCountersForTest()
	resetNilfsUploadRootPreflightCacheForTest()

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
	req.Header.Set("X-Nil-Deal-ID", "1")
	req.Header.Set("X-Nil-Manifest-Root", manifestRoot.Canonical)
	req.Header.Set(nilUploadPreviousManifestRootHeader, "")
	req.Header.Set("X-Nil-Full-Size", "131072")
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

func TestSpUploadManifest_RejectsStalePreviousManifestRoot(t *testing.T) {
	useTempUploadDir(t)
	resetNilfsCASStatusCountersForTest()
	resetNilfsUploadRootPreflightCacheForTest()

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
	req.Header.Set("X-Nil-Deal-ID", "1")
	req.Header.Set("X-Nil-Manifest-Root", manifestRoot.Canonical)
	req.Header.Set(nilUploadPreviousManifestRootHeader, mustTestManifestRoot(t, "sp-upload-manifest-stale-prev").Canonical)
	req.Header.Set("X-Nil-Full-Size", "131072")
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
	if got := nilfsCASStatusSnapshotForStatus()["nilfs_cas_preflight_conflicts_upload"]; got != "1" {
		t.Fatalf("expected nilfs_cas_preflight_conflicts_upload=1, got %q", got)
	}
}

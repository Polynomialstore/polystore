package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestSpUploadManifest_WritesManifestBin(t *testing.T) {
	useTempUploadDir(t)

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

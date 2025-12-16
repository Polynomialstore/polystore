package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"nil_gateway/pkg/builder"
	"nil_gateway/pkg/layout"
)

func TestGatewayListFiles_Basic(t *testing.T) {
	useTempUploadDir(t)

	manifestRoot := mustTestManifestRoot(t, "list-files-basic")
	dealDir := filepath.Join(uploadDir, manifestRoot.Key)
	if err := os.MkdirAll(dealDir, 0o755); err != nil {
		t.Fatalf("mkdir deal dir: %v", err)
	}
	defer os.RemoveAll(dealDir)

	b, err := builder.NewMdu0Builder(1)
	if err != nil {
		t.Fatalf("NewMdu0Builder: %v", err)
	}

	rec := layout.FileRecordV1{
		StartOffset:    0,
		LengthAndFlags: layout.PackLengthAndFlags(5, 0),
		Timestamp:      0,
	}
	copy(rec.Path[:], "a.txt")
	if err := b.AppendFileRecord(rec); err != nil {
		t.Fatalf("AppendFileRecord: %v", err)
	}

	if err := os.WriteFile(filepath.Join(dealDir, "mdu_0.bin"), b.Bytes(), 0o644); err != nil {
		t.Fatalf("write mdu_0.bin: %v", err)
	}

	srv := dynamicMockDealServer(map[uint64]struct{ Owner string; CID string }{
		1: {Owner: "nil1owner", CID: manifestRoot.Canonical},
	})
	defer srv.Close()
	oldLCD := lcdBase
	lcdBase = srv.URL
	defer func() { lcdBase = oldLCD }()

	r := testRouter()
	req := httptest.NewRequest("GET", fmt.Sprintf("/gateway/list-files/%s?deal_id=1&owner=nil1owner", manifestRoot.Canonical), nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var payload struct {
		ManifestRoot   string `json:"manifest_root"`
		TotalSizeBytes uint64 `json:"total_size_bytes"`
		Files          []struct {
			Path      string `json:"path"`
			SizeBytes uint64 `json:"size_bytes"`
		} `json:"files"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.ManifestRoot != manifestRoot.Canonical {
		t.Fatalf("unexpected manifest_root: %q", payload.ManifestRoot)
	}
	if payload.TotalSizeBytes != 5 {
		t.Fatalf("unexpected total_size_bytes: %d", payload.TotalSizeBytes)
	}
	if len(payload.Files) != 1 {
		t.Fatalf("expected 1 file, got %d", len(payload.Files))
	}
	if payload.Files[0].Path != "a.txt" || payload.Files[0].SizeBytes != 5 {
		t.Fatalf("unexpected file entry: %+v", payload.Files[0])
	}
}

func TestGatewayListFiles_WithOwnerCheck(t *testing.T) {
	useTempUploadDir(t)

	manifestRoot := mustTestManifestRoot(t, "list-files-authz")
	dealDir := filepath.Join(uploadDir, manifestRoot.Key)
	if err := os.MkdirAll(dealDir, 0o755); err != nil {
		t.Fatalf("mkdir deal dir: %v", err)
	}
	defer os.RemoveAll(dealDir)

	b, err := builder.NewMdu0Builder(1)
	if err != nil {
		t.Fatalf("NewMdu0Builder: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_0.bin"), b.Bytes(), 0o644); err != nil {
		t.Fatalf("write mdu_0.bin: %v", err)
	}

	srv := dynamicMockDealServer(map[uint64]struct{ Owner string; CID string }{
		1: {Owner: "nil1owner", CID: manifestRoot.Canonical},
	})
	defer srv.Close()
	oldLCD := lcdBase
	lcdBase = srv.URL
	defer func() { lcdBase = oldLCD }()

	q := url.Values{}
	q.Set("deal_id", "1")
	q.Set("owner", "nil1owner")

	r := testRouter()
	req := httptest.NewRequest("GET", fmt.Sprintf("/gateway/list-files/%s?%s", manifestRoot.Canonical, q.Encode()), nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

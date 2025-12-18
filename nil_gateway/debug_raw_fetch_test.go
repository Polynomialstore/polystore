package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"nilchain/x/crypto_ffi"
)

func TestGatewayDebugRawFetch_ByPath_NoManifestBin(t *testing.T) {
	useTempUploadDir(t)
	owner := testDealOwner(t)

	if err := crypto_ffi.Init(trustedSetup); err != nil {
		t.Fatalf("crypto_ffi.Init failed: %v", err)
	}

	// Produce a valid manifest root (G1 compressed) for directory naming.
	roots := make([][]byte, 2)
	roots[0] = make([]byte, 32)
	roots[1] = make([]byte, 32)
	commitment, _, err := crypto_ffi.ComputeManifestCommitment(roots)
	if err != nil {
		t.Fatalf("ComputeManifestCommitment failed: %v", err)
	}
	manifestRoot, err := parseManifestRoot("0x" + fmt.Sprintf("%x", commitment))
	if err != nil {
		t.Fatalf("parseManifestRoot failed: %v", err)
	}

	// Create a minimal NilFS slab:
	// - mdu_0.bin: file record
	// - mdu_1.bin: user-data MDU containing the file bytes
	// (No manifest.bin required for debug raw fetch.)
	filePath := "debug.md"
	fileContent := []byte("Hello Debug Raw Fetch")

	dealDir := filepath.Join(uploadDir, manifestRoot.Key)
	if err := os.MkdirAll(dealDir, 0o755); err != nil {
		t.Fatalf("MkdirAll failed: %v", err)
	}

	b := crypto_ffi.NewMdu0Builder(1)
	defer b.Free()
	b.AppendFile(filePath, uint64(len(fileContent)), 0)
	mdu0Data, _ := b.Bytes()
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_0.bin"), mdu0Data, 0o644); err != nil {
		t.Fatalf("write mdu_0.bin failed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_1.bin"), encodeRawToMdu(fileContent), 0o644); err != nil {
		t.Fatalf("write mdu_1.bin failed: %v", err)
	}

	// Mock LCD deal for optional validation.
	const dealID = 1
	dealStates := map[uint64]struct {
		Owner string
		CID   string
	}{
		dealID: {Owner: owner, CID: manifestRoot.Canonical},
	}
	srv := dynamicMockDealServer(dealStates)
	defer srv.Close()
	oldLCD := lcdBase
	lcdBase = srv.URL
	defer func() { lcdBase = oldLCD }()

	r := testRouter()

	q := url.Values{}
	q.Set("deal_id", "1")
	q.Set("owner", owner)
	q.Set("file_path", filePath)
	q.Set("range_start", "0")
	q.Set("range_len", "0")

	req := httptest.NewRequest("GET", "/gateway/debug/raw-fetch/"+manifestRoot.Canonical+"?"+q.Encode(), nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("raw fetch failed: %d, body: %s", w.Code, w.Body.String())
	}
	if got := w.Body.String(); got != string(fileContent) {
		t.Fatalf("content mismatch: want %q got %q", string(fileContent), got)
	}

	// Range fetch.
	q.Set("range_start", "6")
	q.Set("range_len", "5")
	req2 := httptest.NewRequest("GET", "/gateway/debug/raw-fetch/"+manifestRoot.Canonical+"?"+q.Encode(), nil)
	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("raw fetch range failed: %d, body: %s", w2.Code, w2.Body.String())
	}
	if got := w2.Body.String(); got != "Debug" {
		t.Fatalf("range mismatch: want %q got %q", "Debug", got)
	}
}

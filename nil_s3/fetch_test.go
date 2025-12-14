package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"nil_s3/pkg/builder"
	"nil_s3/pkg/layout"
)

func TestGatewayFetch_ByPath(t *testing.T) {
	useTempUploadDir(t)
	t.Setenv("NIL_PROVIDER_ADDRESS", "nil1testprovider")
	owner := testDealOwner(t)

	// Setup Fake Deal
	manifestRoot := mustTestManifestRoot(t, "fetch-by-path")
	dealDir := filepath.Join(uploadDir, manifestRoot.Key)
	os.MkdirAll(dealDir, 0755)
	defer os.RemoveAll(dealDir)

	// Create MDU #0
	b, _ := builder.NewMdu0Builder(65536)
	// W = 24. User Data starts at MDU #25 (Index 25).

	// Add File Record
	fileContent := []byte("Hello World from Slab")
	rec := layout.FileRecordV1{
		StartOffset:    0, // Starts at MDU #25, Offset 0
		LengthAndFlags: layout.PackLengthAndFlags(uint64(len(fileContent)), 0),
	}
	copy(rec.Path[:], "video.mp4")
	b.AppendFileRecord(rec)

	mdu0Data := b.Bytes()
	os.WriteFile(filepath.Join(dealDir, "mdu_0.bin"), mdu0Data, 0644)

	// Create User Data MDU (MDU #25)
	// Slab Index = 1 + W + 0 = 1 + 24 + 0 = 25.
	// For the on-disk slab to infer W correctly, create placeholder Witness MDUs.
	for i := 1; i <= int(b.WitnessMduCount); i++ {
		os.WriteFile(filepath.Join(dealDir, fmt.Sprintf("mdu_%d.bin", i)), []byte{0}, 0644)
	}
	mdu25Path := filepath.Join(dealDir, "mdu_25.bin")
	os.WriteFile(mdu25Path, encodeRawToMdu(fileContent), 0644)

	// Mock LCD for owner check
	srv := mockDealServer(owner, manifestRoot.Canonical)
	defer srv.Close()
	oldLCD := lcdBase
	lcdBase = srv.URL
	defer func() { lcdBase = oldLCD }()

	r := testRouter()

	// Request
	const dealID = 1
	nonce := uint64(1)
	expiresAt := uint64(time.Now().Unix()) + 120
	reqSig := signRetrievalRequest(t, dealID, "video.mp4", nonce, expiresAt)
	u := fmt.Sprintf(
		"/gateway/fetch/%s?deal_id=%d&owner=%s&file_path=video.mp4&req_sig=%s&req_nonce=%d&req_expires_at=%d",
		manifestRoot.Canonical,
		dealID,
		owner,
		reqSig,
		nonce,
		expiresAt,
	)
	req := httptest.NewRequest("GET", u, nil)
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Fetch failed: %d, body: %s", w.Code, w.Body.String())
	}

	if w.Body.String() != string(fileContent) {
		t.Errorf("Content mismatch. Want %q, got %q", string(fileContent), w.Body.String())
	}
}

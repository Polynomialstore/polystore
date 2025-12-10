package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"nil_s3/pkg/builder"
	"nil_s3/pkg/layout"
)

func TestGatewayFetch_ByPath(t *testing.T) {
	// Setup Fake Deal
	manifestRoot := "fake_manifest_root"
	dealDir := filepath.Join(uploadDir, manifestRoot)
	os.MkdirAll(dealDir, 0755)
	defer os.RemoveAll(dealDir)

	// Create MDU #0
	b, _ := builder.NewMdu0Builder(65536)
	// W = 24. User Data starts at MDU #25 (Index 25).
	
	// Add File Record
	fileContent := []byte("Hello World from Slab")
	rec := layout.FileRecordV1{
		StartOffset: 0, // Starts at MDU #25, Offset 0
		LengthAndFlags: layout.PackLengthAndFlags(uint64(len(fileContent)), 0),
	}
	copy(rec.Path[:], "video.mp4")
	b.AppendFileRecord(rec)
	
	mdu0Data := b.Bytes()
	os.WriteFile(filepath.Join(dealDir, "mdu_0.bin"), mdu0Data, 0644)

	// Create User Data MDU (MDU #25)
	// Slab Index = 1 + W + 0 = 1 + 24 + 0 = 25.
	mdu25Path := filepath.Join(dealDir, "mdu_25.bin")
	os.WriteFile(mdu25Path, fileContent, 0644) // Doesn't need to be full 8MB for read test if we only read len bytes

	// Mock LCD for owner check
	srv := mockDealServer("nil1owner", manifestRoot)
	defer srv.Close()
	oldLCD := lcdBase
	lcdBase = srv.URL
	defer func() { lcdBase = oldLCD }()

	r := testRouter()
	
	// Request
	u := fmt.Sprintf("/gateway/fetch/%s?deal_id=1&owner=nil1owner&file_path=video.mp4", manifestRoot)
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

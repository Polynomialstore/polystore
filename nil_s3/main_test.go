package main

import (
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/gorilla/mux"
)

// helper to build a router with only the GatewayFetch endpoint wired.
func testRouter() *mux.Router {
	r := mux.NewRouter()
	r.HandleFunc("/gateway/fetch/{cid}", GatewayFetch).Methods("GET", "OPTIONS")
	r.HandleFunc("/gateway/list-files/{cid}", GatewayListFiles).Methods("GET", "OPTIONS")
	r.HandleFunc("/gateway/upload", GatewayUpload).Methods("POST", "OPTIONS")
	return r
}

func TestGatewayFetch_MissingParams(t *testing.T) {
	r := testRouter()

	req := httptest.NewRequest("GET", "/gateway/fetch/testcid", nil)
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for missing query params, got %d", w.Code)
	}
	body, _ := io.ReadAll(w.Body)
	if !strings.Contains(string(body), "deal_id and owner") {
		t.Fatalf("expected error about missing deal_id/owner, got: %s", string(body))
	}
}

// mockDealServer returns a simple LCD-like handler that serves a single deal
// with given owner and cid values.
func mockDealServer(owner, cid string) *httptest.Server {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := map[string]any{
			"deal": map[string]any{
				"owner": owner,
				"cid":   cid,
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	})
	return httptest.NewServer(handler)
}

func TestGatewayFetch_OwnerMismatch(t *testing.T) {
	r := testRouter()

	// Stub LCD so fetchDealOwnerAndCID returns a specific owner/cid.
	srv := mockDealServer("nil1realowner", "cid123")
	defer srv.Close()
	oldLCD := lcdBase
	lcdBase = srv.URL
	defer func() { lcdBase = oldLCD }()

	q := url.Values{}
	q.Set("deal_id", "1")
	q.Set("owner", "nil1otherowner")
	req := httptest.NewRequest("GET", "/gateway/fetch/cid123?"+q.Encode(), nil)
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for owner mismatch, got %d", w.Code)
	}
}

func TestGatewayFetch_CIDMismatch(t *testing.T) {
	r := testRouter()

	// Stub LCD: owner matches, cid does not.
	srv := mockDealServer("nil1owner", "cid-on-chain")
	defer srv.Close()
	oldLCD := lcdBase
	lcdBase = srv.URL
	defer func() { lcdBase = oldLCD }()

	q := url.Values{}
	q.Set("deal_id", "2")
	q.Set("owner", "nil1owner")
	req := httptest.NewRequest("GET", "/gateway/fetch/request-cid?"+q.Encode(), nil)
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for cid mismatch, got %d", w.Code)
	}
	body, _ := io.ReadAll(w.Body)
	if !strings.Contains(string(body), "cid does not match deal") {
		t.Fatalf("expected cid mismatch message, got: %s", string(body))
	}
}

// TestHelperProcess is used to mock exec.Command
func TestHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_HELPER_PROCESS") != "1" {
		return
	}
	defer os.Exit(0)

	// Args: [nil_cli, --trusted-setup, ..., shard, path, --out, outPath]
	// We want to write specific JSON to outPath based on 'path'.

	args := os.Args
	for len(args) > 0 {
		if args[0] == "--" {
			args = args[1:]
			break
		}
		args = args[1:]
	}

	if len(args) == 0 {
		fmt.Fprintf(os.Stderr, "No args\n")
		os.Exit(1)
	}

	_ = args[0] // path to executable (ignored)
	// find "shard"
	shardIdx := -1
	for i, arg := range args {
		if arg == "shard" {
			shardIdx = i
			break
		}
	}

	if shardIdx == -1 {
		// keys show, etc.
		return
	}

	inputFile := args[shardIdx+1]
	outPath := ""
	for i, arg := range args {
		if arg == "--out" && i+1 < len(args) {
			outPath = args[i+1]
			break
		}
	}

	// Generate Fake Output
	output := NilCliOutput{
		ManifestRootHex: "0x1234567890abcdef",
		ManifestBlobHex: "0xdeadbeef",
		FileSize:        100,
		Mdus: []MduData{
			{Index: 0, RootHex: "0x1111", Blobs: []string{"0xaaaa"}},
		},
	}

	if strings.Contains(inputFile, "witness") {
		output.ManifestRootHex = "0xwitnessroot"
	} else if strings.Contains(inputFile, "mdu0") {
		output.ManifestRootHex = "0xfinalroot"
	} else {
		// User file
		output.ManifestRootHex = "0xuserroot"
	}

	data, _ := json.Marshal(output)
	os.WriteFile(outPath, data, 0644)
}

func TestGatewayUpload_NewDealLifecycle(t *testing.T) {
	// Force fast shard path for lightweight tests.
	oldFast := fastShardMode
	fastShardMode = true
	defer func() { fastShardMode = oldFast }()

	r := testRouter()

	// Prepare Multipart Upload
	body := &strings.Builder{}
	writer := multipart.NewWriter(body)
	part, _ := writer.CreateFormFile("file", "test.txt")
	part.Write([]byte("some data"))
	writer.Close()

	req := httptest.NewRequest("POST", "/gateway/upload", strings.NewReader(body.String()))
	req.Header.Set("Content-Type", writer.FormDataContentType())
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("GatewayUpload failed: %d, body: %s", w.Code, w.Body.String())
	}

	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)

	if resp["cid"] == nil || resp["cid"] == "" {
		t.Errorf("Expected cid in response, got %v", resp["cid"])
	}
	if resp["manifest_root"] != resp["cid"] {
		t.Errorf("manifest_root should mirror cid, got %v vs %v", resp["manifest_root"], resp["cid"])
	}
	if resp["allocated_length"] == nil {
		t.Errorf("Expected allocated_length")
	}
}

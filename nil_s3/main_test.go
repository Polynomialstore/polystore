package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/mux"
)

func useTempUploadDir(t *testing.T) string {
	t.Helper()
	old := uploadDir
	dir := t.TempDir()
	uploadDir = dir
	t.Cleanup(func() { uploadDir = old })
	return dir
}

func mockExecCommandContext(t *testing.T) {
	t.Helper()
	old := execCommandContext
	execCommandContext = func(ctx context.Context, name string, args ...string) *exec.Cmd {
		cs := []string{"-test.run=TestHelperProcess", "--", name}
		cs = append(cs, args...)
		cmd := exec.CommandContext(ctx, os.Args[0], cs...)
		cmd.Env = append(os.Environ(), "GO_WANT_HELPER_PROCESS=1")
		return cmd
	}
	t.Cleanup(func() { execCommandContext = old })
}

// helper to build a router with only the GatewayFetch endpoint wired.
func testRouter() *mux.Router {
	r := mux.NewRouter()
	r.HandleFunc("/gateway/fetch/{cid}", GatewayFetch).Methods("GET", "OPTIONS")
	r.HandleFunc("/gateway/list-files/{cid}", GatewayListFiles).Methods("GET", "OPTIONS")
	r.HandleFunc("/gateway/slab/{cid}", GatewaySlab).Methods("GET", "OPTIONS")
	r.HandleFunc("/gateway/manifest-info/{cid}", GatewayManifestInfo).Methods("GET", "OPTIONS")
	r.HandleFunc("/gateway/mdu-kzg/{cid}/{index}", GatewayMduKzg).Methods("GET", "OPTIONS")
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

	if raw := strings.TrimSpace(os.Getenv("NIL_HELPER_SLEEP_MS")); raw != "" {
		if ms, err := strconv.Atoi(raw); err == nil && ms > 0 {
			time.Sleep(time.Duration(ms) * time.Millisecond)
		}
	}

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
	cmdIdx := -1
	cmdName := ""
	for i, arg := range args {
		if arg == "shard" || arg == "aggregate" {
			cmdIdx = i
			cmdName = arg
			break
		}
	}

	if cmdIdx == -1 {
		return
	}

	switch cmdName {
	case "shard":
		if cmdIdx+1 >= len(args) {
			fmt.Fprintf(os.Stderr, "Missing shard input file\n")
			os.Exit(1)
		}
		inputFile := args[cmdIdx+1]
		inputBase := filepath.Base(inputFile)

		outPath := ""
		savePrefix := ""
		rawFlag := false
		for i, arg := range args {
			switch arg {
			case "--out":
				if i+1 < len(args) {
					outPath = args[i+1]
				}
			case "--save-mdu-prefix":
				if i+1 < len(args) {
					savePrefix = args[i+1]
				}
			case "--raw":
				rawFlag = true
			}
		}
		if outPath == "" {
			fmt.Fprintf(os.Stderr, "Missing --out\n")
			os.Exit(1)
		}

		if os.Getenv("EXPECT_MDU0_RAW") == "1" && strings.Contains(inputBase, "mdu0") && !rawFlag {
			fmt.Fprintf(os.Stderr, "expected --raw for mdu0 sharding (%s)\n", inputBase)
			os.Exit(2)
		}

		if savePrefix != "" {
			if err := os.MkdirAll(filepath.Dir(savePrefix), 0o755); err != nil {
				fmt.Fprintf(os.Stderr, "mkdir savePrefix dir: %v\n", err)
				os.Exit(1)
			}
			// Ingest flows only need the file to exist for rename/copy.
			if err := os.WriteFile(fmt.Sprintf("%s.mdu.0.bin", savePrefix), []byte("dummy"), 0o644); err != nil {
				fmt.Fprintf(os.Stderr, "write dummy mdu: %v\n", err)
				os.Exit(1)
			}
		}

		output := NilCliOutput{
			ManifestRootHex: "0xuserroot",
			ManifestBlobHex: "0xdeadbeef",
			FileSize:        100,
			Mdus: []MduData{
				{Index: 0, RootHex: "0x1111", Blobs: []string{"0xaaaa"}},
			},
		}
		switch {
		case strings.Contains(inputBase, "witness"):
			output.ManifestRootHex = "0xwitnessroot"
		case strings.Contains(inputBase, "mdu0"):
			output.ManifestRootHex = "0xmdu0root"
		}

		data, _ := json.Marshal(output)
		if err := os.WriteFile(outPath, data, 0o644); err != nil {
			fmt.Fprintf(os.Stderr, "write shard output: %v\n", err)
			os.Exit(1)
		}

	case "aggregate":
		outPath := ""
		for i, arg := range args {
			if arg == "--out" && i+1 < len(args) {
				outPath = args[i+1]
				break
			}
		}
		if outPath == "" {
			fmt.Fprintf(os.Stderr, "Missing --out for aggregate\n")
			os.Exit(1)
		}
		res := NilCliAggregateOutput{
			ManifestRootHex: "0xmanifestroot",
			ManifestBlobHex: "0xfeedface",
		}
		data, _ := json.Marshal(res)
		if err := os.WriteFile(outPath, data, 0o644); err != nil {
			fmt.Fprintf(os.Stderr, "write aggregate output: %v\n", err)
			os.Exit(1)
		}
	}
}

func TestGatewayUpload_NewDealLifecycle(t *testing.T) {
	useTempUploadDir(t)
	mockExecCommandContext(t)

	r := testRouter()

	// Prepare Multipart Upload
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, _ := writer.CreateFormFile("file", "test.txt")
	part.Write([]byte("some data"))
	writer.Close()

	req := httptest.NewRequest("POST", "/gateway/upload", body)
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

func TestShardFile_TimeoutCancels(t *testing.T) {
	useTempUploadDir(t)
	mockExecCommandContext(t)
	t.Setenv("NIL_HELPER_SLEEP_MS", "200")

	oldShardTimeout := shardTimeout
	shardTimeout = 50 * time.Millisecond
	t.Cleanup(func() { shardTimeout = oldShardTimeout })

	input := filepath.Join(uploadDir, "input.bin")
	if err := os.WriteFile(input, []byte("hi"), 0o644); err != nil {
		t.Fatalf("write input: %v", err)
	}

	_, err := shardFile(context.Background(), input, false, "")
	if err == nil {
		t.Fatalf("expected timeout error, got nil")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected DeadlineExceeded, got %v", err)
	}
}

func TestGatewayUpload_TimeoutReturns408AndNoDealDir(t *testing.T) {
	useTempUploadDir(t)
	mockExecCommandContext(t)
	t.Setenv("NIL_HELPER_SLEEP_MS", "200")

	oldUploadTimeout := uploadIngestTimeout
	uploadIngestTimeout = 50 * time.Millisecond
	t.Cleanup(func() { uploadIngestTimeout = oldUploadTimeout })

	r := testRouter()

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, _ := writer.CreateFormFile("file", "test.txt")
	part.Write([]byte("some data"))
	writer.Close()

	req := httptest.NewRequest("POST", "/gateway/upload", body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusRequestTimeout {
		t.Fatalf("expected 408, got %d: %s", w.Code, w.Body.String())
	}

	entries, err := os.ReadDir(uploadDir)
	if err != nil {
		t.Fatalf("readdir uploadDir: %v", err)
	}
	for _, e := range entries {
		if e.IsDir() {
			t.Fatalf("expected no deal dirs, found dir %s", e.Name())
		}
	}
}

func TestIngestNewDeal_Mdu0UsesRaw(t *testing.T) {
	useTempUploadDir(t)
	mockExecCommandContext(t)
	t.Setenv("EXPECT_MDU0_RAW", "1")

	input := filepath.Join(uploadDir, "file.txt")
	if err := os.WriteFile(input, []byte("hi"), 0o644); err != nil {
		t.Fatalf("write input: %v", err)
	}

	_, manifestRoot, _, err := IngestNewDeal(context.Background(), input, 256)
	if err != nil {
		t.Fatalf("IngestNewDeal failed: %v", err)
	}
	if manifestRoot != "0xmanifestroot" {
		t.Fatalf("unexpected manifest root %q", manifestRoot)
	}
	if _, err := os.Stat(filepath.Join(uploadDir, manifestRoot)); err != nil {
		t.Fatalf("expected deal dir to exist: %v", err)
	}
}

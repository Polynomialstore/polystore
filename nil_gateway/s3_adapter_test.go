package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/gorilla/mux"

	"nilchain/x/crypto_ffi"
)

func mockLCDDealsServer(t *testing.T, dealStates map[uint64]struct {
	Owner string
	CID   string
}) *httptest.Server {
	t.Helper()
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/nilchain/nilchain/v1/deals") {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}

		trimmed := strings.TrimPrefix(r.URL.Path, "/nilchain/nilchain/v1/deals")
		trimmed = strings.TrimPrefix(trimmed, "/")
		if trimmed == "" {
			// list deals
			type dealRow struct {
				ID string `json:"id"`
			}
			rows := make([]dealRow, 0, len(dealStates))
			for id := range dealStates {
				rows = append(rows, dealRow{ID: strconv.FormatUint(id, 10)})
			}
			resp := map[string]any{"deals": rows}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(resp)
			return
		}

		dealID, err := strconv.ParseUint(trimmed, 10, 64)
		if err != nil {
			http.Error(w, "invalid deal ID", http.StatusBadRequest)
			return
		}
		state, ok := dealStates[dealID]
		if !ok {
			http.Error(w, "deal not found", http.StatusNotFound)
			return
		}

		resp := map[string]any{
			"deal": map[string]any{
				"id":    strconv.FormatUint(dealID, 10),
				"owner": state.Owner,
				"cid":   state.CID,
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	})
	return httptest.NewServer(handler)
}

func s3TestRouter() *mux.Router {
	r := mux.NewRouter()
	registerS3Routes(r)
	return r
}

func TestS3_ListBuckets_UsesDealIDs(t *testing.T) {
	useTempUploadDir(t)

	root := mustTestManifestRoot(t, "s3-buckets")
	srv := mockLCDDealsServer(t, map[uint64]struct {
		Owner string
		CID   string
	}{
		1: {Owner: "nil1owner", CID: root.Canonical},
		7: {Owner: "nil1owner", CID: root.Canonical},
	})
	defer srv.Close()

	old := lcdBase
	lcdBase = srv.URL
	t.Cleanup(func() { lcdBase = old })

	r := s3TestRouter()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if !strings.Contains(body, "<Name>deal-1</Name>") {
		t.Fatalf("expected deal-1 bucket, got: %s", body)
	}
	if !strings.Contains(body, "<Name>deal-7</Name>") {
		t.Fatalf("expected deal-7 bucket, got: %s", body)
	}
}

func TestS3_ListObjects_ListsNilfsFileTable(t *testing.T) {
	useTempUploadDir(t)

	root := mustTestManifestRoot(t, "s3-list")
	dealDir := dealScopedDir(1, root)
	if err := os.MkdirAll(dealDir, 0o755); err != nil {
		t.Fatalf("mkdir deal dir: %v", err)
	}
	defer os.RemoveAll(filepath.Join(uploadDir, "deals"))

	b := crypto_ffi.NewMdu0Builder(1)
	defer b.Free()
	if err := b.AppendFile("a.txt", 5, 0); err != nil {
		t.Fatalf("AppendFile: %v", err)
	}
	mdu0, _ := b.Bytes()
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_0.bin"), mdu0, 0o644); err != nil {
		t.Fatalf("write mdu_0.bin: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_1.bin"), encodeRawToMdu([]byte("hello")), 0o644); err != nil {
		t.Fatalf("write mdu_1.bin: %v", err)
	}

	srv := mockLCDDealsServer(t, map[uint64]struct {
		Owner string
		CID   string
	}{
		1: {Owner: "nil1owner", CID: root.Canonical},
	})
	defer srv.Close()
	old := lcdBase
	lcdBase = srv.URL
	t.Cleanup(func() { lcdBase = old })

	r := s3TestRouter()
	req := httptest.NewRequest(http.MethodGet, "/deal-1?list-type=2", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "<Key>a.txt</Key>") {
		t.Fatalf("expected a.txt key in response, got: %s", w.Body.String())
	}
}

func TestS3_GetObject_ReturnsDecodedBytes(t *testing.T) {
	useTempUploadDir(t)

	root := mustTestManifestRoot(t, "s3-get")
	dealDir := dealScopedDir(1, root)
	if err := os.MkdirAll(dealDir, 0o755); err != nil {
		t.Fatalf("mkdir deal dir: %v", err)
	}
	defer os.RemoveAll(filepath.Join(uploadDir, "deals"))

	b := crypto_ffi.NewMdu0Builder(1)
	defer b.Free()
	if err := b.AppendFile("a.txt", 5, 0); err != nil {
		t.Fatalf("AppendFile: %v", err)
	}
	mdu0, _ := b.Bytes()
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_0.bin"), mdu0, 0o644); err != nil {
		t.Fatalf("write mdu_0.bin: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_1.bin"), encodeRawToMdu([]byte("hello")), 0o644); err != nil {
		t.Fatalf("write mdu_1.bin: %v", err)
	}

	srv := mockLCDDealsServer(t, map[uint64]struct {
		Owner string
		CID   string
	}{
		1: {Owner: "nil1owner", CID: root.Canonical},
	})
	defer srv.Close()
	old := lcdBase
	lcdBase = srv.URL
	t.Cleanup(func() { lcdBase = old })

	r := s3TestRouter()
	req := httptest.NewRequest(http.MethodGet, "/deal-1/a.txt", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	data, _ := io.ReadAll(w.Body)
	if string(data) != "hello" {
		t.Fatalf("unexpected body: %q", string(data))
	}
	if got := w.Header().Get("Content-Length"); got != "5" {
		t.Fatalf("expected Content-Length=5, got %q", got)
	}
}

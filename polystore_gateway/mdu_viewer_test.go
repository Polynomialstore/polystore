package main

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/gorilla/mux"

	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/types"
)

func TestGatewayManifestInfo_Basic(t *testing.T) {
	useTempUploadDir(t)
	setupMockCombinedOutput(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if name == nilCliPath && hasArg(args, "shard") {
			output := NilCliOutput{
				ManifestRootHex: deterministicManifestRootHex("ingest-raw"), // unused by manifest-info but part of struct
				ManifestBlobHex: "0x0102",
				FileSize:        100,
				Mdus:            []MduData{{Index: 0, RootHex: "0x1111", Blobs: []string{"0xaaaa"}}},
			}
			data, _ := json.Marshal(output)
			return data, nil
		}
		return []byte{}, nil
	})

	cid := mustTestManifestRoot(t, "manifest-info-basic")
	dealDir := filepath.Join(uploadDir, cid.Key)
	if err := os.MkdirAll(dealDir, 0o755); err != nil {
		t.Fatalf("mkdir deal dir: %v", err)
	}

	if err := os.WriteFile(filepath.Join(dealDir, "manifest.bin"), []byte{0x01, 0x02}, 0o644); err != nil {
		t.Fatalf("write manifest.bin: %v", err)
	}

	b := crypto_ffi.NewMdu0Builder(256)
	defer b.Free()

	var root1, root2 [32]byte
	for i := 0; i < 32; i++ {
		root1[i] = 0x11
		root2[i] = 0x22
	}
	if err := b.SetRoot(0, root1[:]); err != nil {
		t.Fatalf("SetRoot 0: %v", err)
	}
	if err := b.SetRoot(1, root2[:]); err != nil {
		t.Fatalf("SetRoot 1: %v", err)
	}

	if err := b.AppendFile("file.txt", 100, 0); err != nil {
		t.Fatalf("AppendFileRecord: %v", err)
	}

	mdu0Bytes, _ := b.Bytes()
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_0.bin"), mdu0Bytes, 0o644); err != nil {
		t.Fatalf("write mdu_0.bin: %v", err)
	}

	zeros := make([]byte, types.MDU_SIZE)
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_1.bin"), zeros, 0o644); err != nil {
		t.Fatalf("write mdu_1.bin: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_2.bin"), zeros, 0o644); err != nil {
		t.Fatalf("write mdu_2.bin: %v", err)
	}

	r := testRouter()
	req := httptest.NewRequest("GET", "/gateway/manifest-info/"+cid.Canonical, nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp manifestInfoResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	if resp.ManifestRoot != cid.Canonical {
		t.Fatalf("expected manifest_root %q, got %q", cid.Canonical, resp.ManifestRoot)
	}
	if resp.ManifestBlobHex != "0x0102" {
		t.Fatalf("expected manifest_blob_hex 0x0102, got %q", resp.ManifestBlobHex)
	}
	if resp.TotalMdus != 3 {
		t.Fatalf("expected total_mdus 3, got %d", resp.TotalMdus)
	}
	if resp.WitnessMdus != 1 || resp.UserMdus != 1 {
		t.Fatalf("expected witness_mdus=1 user_mdus=1, got witness=%d user=%d", resp.WitnessMdus, resp.UserMdus)
	}
	if len(resp.Roots) != 3 {
		t.Fatalf("expected 3 roots, got %d", len(resp.Roots))
	}

	if resp.Roots[0].MduIndex != 0 || resp.Roots[0].Kind != "mdu0" {
		t.Fatalf("expected roots[0] to be mdu0, got %+v", resp.Roots[0])
	}
	// The mocked polystore_cli helper returns root_hex=0x1111 for raw sharding.
	if resp.Roots[0].RootHex != "0x1111" {
		t.Fatalf("expected mdu0 root_hex 0x1111, got %q", resp.Roots[0].RootHex)
	}

	want1 := "0x" + hex.EncodeToString(root1[:])
	want2 := "0x" + hex.EncodeToString(root2[:])
	if resp.Roots[1].RootHex != want1 {
		t.Fatalf("expected roots[1] root_hex %q, got %q", want1, resp.Roots[1].RootHex)
	}
	if resp.Roots[2].RootHex != want2 {
		t.Fatalf("expected roots[2] root_hex %q, got %q", want2, resp.Roots[2].RootHex)
	}
}

func TestGatewayMduKzg_Basic(t *testing.T) {
	useTempUploadDir(t)
	setupMockCombinedOutput(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if name == nilCliPath && hasArg(args, "shard") {
			output := NilCliOutput{
				ManifestRootHex: deterministicManifestRootHex("ingest-raw"),
				ManifestBlobHex: "0xdeadbeef",
				FileSize:        100,
				Mdus:            []MduData{{Index: 0, RootHex: "0x1111", Blobs: []string{"0xaaaa"}}},
			}
			data, _ := json.Marshal(output)
			return data, nil
		}
		return []byte{}, nil
	})

	cid := mustTestManifestRoot(t, "mdu-kzg-basic")
	dealDir := filepath.Join(uploadDir, cid.Key)
	if err := os.MkdirAll(dealDir, 0o755); err != nil {
		t.Fatalf("mkdir deal dir: %v", err)
	}

	if err := os.WriteFile(filepath.Join(dealDir, "manifest.bin"), []byte{0x01}, 0o644); err != nil {
		t.Fatalf("write manifest.bin: %v", err)
	}

	b := crypto_ffi.NewMdu0Builder(256)
	defer b.Free()
	if err := b.AppendFile("file.txt", 100, 0); err != nil {
		t.Fatalf("AppendFileRecord: %v", err)
	}
	mdu0Bytes, _ := b.Bytes()
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_0.bin"), mdu0Bytes, 0o644); err != nil {
		t.Fatalf("write mdu_0.bin: %v", err)
	}

	zeros := make([]byte, types.MDU_SIZE)
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_1.bin"), zeros, 0o644); err != nil {
		t.Fatalf("write mdu_1.bin: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_2.bin"), zeros, 0o644); err != nil {
		t.Fatalf("write mdu_2.bin: %v", err)
	}

	r := testRouter()
	req := httptest.NewRequest("GET", "/gateway/mdu-kzg/"+cid.Canonical+"/2", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp mduKzgResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.ManifestRoot != cid.Canonical {
		t.Fatalf("expected manifest_root %q, got %q", cid.Canonical, resp.ManifestRoot)
	}
	if resp.MduIndex != 2 {
		t.Fatalf("expected mdu_index 2, got %d", resp.MduIndex)
	}
	if resp.RootHex != "0x1111" {
		t.Fatalf("expected root_hex 0x1111, got %q", resp.RootHex)
	}
	if len(resp.Blobs) == 0 {
		t.Fatalf("expected blobs to be non-empty")
	}
}

func TestGatewayMdu_Basic(t *testing.T) {
	useTempUploadDir(t)

	cid := mustTestManifestRoot(t, "mdu-raw-basic")
	dealDir := filepath.Join(uploadDir, cid.Key)
	if err := os.MkdirAll(dealDir, 0o755); err != nil {
		t.Fatalf("mkdir deal dir: %v", err)
	}

	if err := os.WriteFile(filepath.Join(dealDir, "manifest.bin"), []byte{0x01}, 0o644); err != nil {
		t.Fatalf("write manifest.bin: %v", err)
	}

	b := crypto_ffi.NewMdu0Builder(256)
	defer b.Free()
	if err := b.AppendFile("file.txt", 100, 0); err != nil {
		t.Fatalf("AppendFileRecord: %v", err)
	}
	mdu0Bytes, _ := b.Bytes()
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_0.bin"), mdu0Bytes, 0o644); err != nil {
		t.Fatalf("write mdu_0.bin: %v", err)
	}

	zeros := make([]byte, types.MDU_SIZE)
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_1.bin"), zeros, 0o644); err != nil {
		t.Fatalf("write mdu_1.bin: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_2.bin"), zeros, 0o644); err != nil {
		t.Fatalf("write mdu_2.bin: %v", err)
	}

	r := testRouter()
	req := httptest.NewRequest("GET", "/gateway/mdu/"+cid.Canonical+"/0", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if got := w.Header().Get("Content-Type"); got != "application/octet-stream" {
		t.Fatalf("expected octet-stream content-type, got %q", got)
	}
	if got := w.Header().Get("X-PolyStore-Mdu-Index"); got != "0" {
		t.Fatalf("expected X-PolyStore-Mdu-Index=0, got %q", got)
	}
	if got := w.Body.Bytes(); len(got) != len(mdu0Bytes) {
		t.Fatalf("expected %d bytes, got %d", len(mdu0Bytes), len(got))
	}
}

func TestProviderGatewayMdu_RequiresOnchainSession(t *testing.T) {
	useTempUploadDir(t)

	cid := mustTestManifestRoot(t, "provider-mdu-session-required")
	dealDir := filepath.Join(uploadDir, cid.Key)
	if err := os.MkdirAll(dealDir, 0o755); err != nil {
		t.Fatalf("mkdir deal dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dealDir, "manifest.bin"), []byte{0x01}, 0o644); err != nil {
		t.Fatalf("write manifest.bin: %v", err)
	}

	b := crypto_ffi.NewMdu0Builder(256)
	defer b.Free()
	if err := b.AppendFile("file.txt", 100, 0); err != nil {
		t.Fatalf("AppendFileRecord: %v", err)
	}
	mdu0Bytes, _ := b.Bytes()
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_0.bin"), mdu0Bytes, 0o644); err != nil {
		t.Fatalf("write mdu_0.bin: %v", err)
	}
	zeros := make([]byte, types.MDU_SIZE)
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_1.bin"), zeros, 0o644); err != nil {
		t.Fatalf("write mdu_1.bin: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_2.bin"), zeros, 0o644); err != nil {
		t.Fatalf("write mdu_2.bin: %v", err)
	}

	owner := testDealOwner(t)
	const dealID = uint64(1)
	lcdSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/polystorechain/polystorechain/v1/deals/"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"deal": map[string]any{
					"id":        "1",
					"owner":     owner,
					"cid":       cid.Canonical,
					"end_block": "1000",
				},
			})
			return
		default:
			http.NotFound(w, r)
		}
	}))
	defer lcdSrv.Close()
	oldLCD := lcdBase
	lcdBase = lcdSrv.URL
	t.Cleanup(func() { lcdBase = oldLCD })
	t.Setenv("NIL_PROVIDER_ADDRESS", "nil1provider")

	r := mux.NewRouter()
	registerProviderDaemonRoutes(r)
	req := httptest.NewRequest(http.MethodGet, "/sp/retrieval/mdu/"+cid.Canonical+"/0?deal_id=1&owner="+owner, nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 missing session, got %d (%s)", w.Code, w.Body.String())
	}
}

func TestProviderGatewayMdu_AllowsOnchainSession(t *testing.T) {
	useTempUploadDir(t)
	dealMetaCache = sync.Map{}
	t.Setenv("NIL_PROVIDER_ADDRESS", "nil1provider")

	cid := mustTestManifestRoot(t, "provider-mdu-session-ok")
	dealDir := filepath.Join(uploadDir, cid.Key)
	if err := os.MkdirAll(dealDir, 0o755); err != nil {
		t.Fatalf("mkdir deal dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dealDir, "manifest.bin"), []byte{0x01}, 0o644); err != nil {
		t.Fatalf("write manifest.bin: %v", err)
	}

	b := crypto_ffi.NewMdu0Builder(256)
	defer b.Free()
	if err := b.AppendFile("file.txt", 100, 0); err != nil {
		t.Fatalf("AppendFileRecord: %v", err)
	}
	mdu0Bytes, _ := b.Bytes()
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_0.bin"), mdu0Bytes, 0o644); err != nil {
		t.Fatalf("write mdu_0.bin: %v", err)
	}
	zeros := make([]byte, types.MDU_SIZE)
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_1.bin"), zeros, 0o644); err != nil {
		t.Fatalf("write mdu_1.bin: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_2.bin"), zeros, 0o644); err != nil {
		t.Fatalf("write mdu_2.bin: %v", err)
	}

	owner := testDealOwner(t)
	const dealID = uint64(1)
	sessionHex := "0x" + strings.Repeat("11", 32)
	sessionBytes, _ := hex.DecodeString(strings.Repeat("11", 32))
	sessionB64 := base64.URLEncoding.EncodeToString(sessionBytes)
	lcdSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/polystorechain/polystorechain/v1/deals/"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"deal": map[string]any{
					"id":        "1",
					"owner":     owner,
					"cid":       cid.Canonical,
					"end_block": "1000",
				},
			})
			return
		case strings.HasPrefix(r.URL.Path, "/polystorechain/polystorechain/v1/retrieval-sessions/"):
			sid := strings.TrimPrefix(r.URL.Path, "/polystorechain/polystorechain/v1/retrieval-sessions/")
			if sid != sessionB64 {
				http.NotFound(w, r)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"session": map[string]any{
					"session_id":       base64.URLEncoding.EncodeToString(sessionBytes),
					"deal_id":          "1",
					"owner":            owner,
					"provider":         "nil1provider",
					"manifest_root":    base64.StdEncoding.EncodeToString(cid.Bytes[:]),
					"start_mdu_index":  "0",
					"start_blob_index": "0",
					"blob_count":       "64",
					"total_bytes":      "8388608",
					"nonce":            "1",
					"expires_at":       "100",
					"opened_height":    "1",
					"updated_height":   "1",
					"status":           "RETRIEVAL_SESSION_STATUS_OPEN",
				},
			})
			return
		default:
			http.NotFound(w, r)
		}
	}))
	defer lcdSrv.Close()
	oldLCD := lcdBase
	lcdBase = lcdSrv.URL
	t.Cleanup(func() { lcdBase = oldLCD })

	r := mux.NewRouter()
	registerProviderDaemonRoutes(r)
	req := httptest.NewRequest(http.MethodGet, "/sp/retrieval/mdu/"+cid.Canonical+"/0?deal_id=1&owner="+owner, nil)
	req.Header.Set("X-PolyStore-Session-Id", sessionHex)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	if got := w.Header().Get("X-PolyStore-Mdu-Index"); got != "0" {
		t.Fatalf("expected mdu index header 0, got %q", got)
	}
	if len(w.Body.Bytes()) != len(mdu0Bytes) {
		t.Fatalf("expected %d bytes, got %d", len(mdu0Bytes), len(w.Body.Bytes()))
	}
}

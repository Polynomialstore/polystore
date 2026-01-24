package main

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/blake2s"

	"nilchain/x/crypto_ffi"
	niltypes "nilchain/x/nilchain/types"
)

func TestGatewayFetch_RequiresOnchainSession_WhenEnabled(t *testing.T) {
	requireOnchainSessionForTest(t, true)
	useTempUploadDir(t)
	t.Setenv("NIL_PROVIDER_ADDRESS", "nil1testprovider")
	owner := testDealOwner(t)

	// GatewayFetch records per-blob proofs for on-chain sessions; ensure the DB exists.
	dbPath := filepath.Join(t.TempDir(), "sessions.db")
	_ = closeSessionDB()
	require.NoError(t, initSessionDB(dbPath))
	t.Cleanup(func() { _ = closeSessionDB() })

	if err := crypto_ffi.Init(trustedSetup); err != nil {
		t.Fatalf("crypto_ffi.Init failed: %v", err)
	}

	// Build a minimal slab (same structure as TestGatewayFetch_ByPath).
	fileContent := []byte("Hello World from Slab")

	commitmentBytes := 48
	witnessPlain := make([]byte, niltypes.BLOBS_PER_MDU*commitmentBytes)
	leafHashes := make([][32]byte, 0, niltypes.BLOBS_PER_MDU)
	for i := 0; i < len(witnessPlain); i += commitmentBytes {
		for j := 0; j < commitmentBytes; j++ {
			witnessPlain[i+j] = byte(i / commitmentBytes)
		}
		leafHashes = append(leafHashes, blake2s.Sum256(witnessPlain[i:i+commitmentBytes]))
	}
	mduRootFr, _ := merkleRootAndPath(leafHashes, 0)

	roots := make([][]byte, 3)
	roots[0] = make([]byte, 32)
	roots[1] = make([]byte, 32)
	roots[2] = make([]byte, 32)
	copy(roots[2], mduRootFr)
	commitment, manifestBlob, err := crypto_ffi.ComputeManifestCommitment(roots)
	if err != nil {
		t.Fatalf("ComputeManifestCommitment failed: %v", err)
	}
	manifestRoot, err := parseManifestRoot("0x" + fmt.Sprintf("%x", commitment))
	if err != nil {
		t.Fatalf("parseManifestRoot(manifest commitment) failed: %v", err)
	}

	dealDir := filepath.Join(uploadDir, manifestRoot.Key)
	require.NoError(t, os.MkdirAll(dealDir, 0o755))

	b := crypto_ffi.NewMdu0Builder(1)
	defer b.Free()
	b.AppendFile("video.mp4", uint64(len(fileContent)), 0)
	mdu0Data, _ := b.Bytes()
	require.NoError(t, os.WriteFile(filepath.Join(dealDir, "mdu_0.bin"), mdu0Data, 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(dealDir, "manifest.bin"), manifestBlob, 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(dealDir, "mdu_1.bin"), encodeRawToMdu(witnessPlain), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(dealDir, "mdu_2.bin"), encodeRawToMdu(fileContent), 0o644))

	// Mock LCD: deal + retrieval session + latest height.
	const dealID = uint64(1)
	sessionHex := "0x" + strings.Repeat("11", 32) // 32 bytes
	sessionBytes, _ := hex.DecodeString(strings.Repeat("11", 32))
	sessionB64 := base64.URLEncoding.EncodeToString(sessionBytes)

	makeLCD := func(startBlob uint32) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case strings.HasPrefix(r.URL.Path, "/cosmos/base/tendermint/v1beta1/blocks/latest"):
				_ = json.NewEncoder(w).Encode(map[string]any{
					"block": map[string]any{
						"header": map[string]any{
							"height": "10",
						},
					},
				})
				return
			case strings.HasPrefix(r.URL.Path, "/nilchain/nilchain/v1/deals/"):
				_ = json.NewEncoder(w).Encode(map[string]any{
					"deal": map[string]any{
						"id":        "1",
						"owner":     owner,
						"cid":       manifestRoot.Canonical,
						"end_block": "1000",
					},
				})
				return
			case strings.HasPrefix(r.URL.Path, "/nilchain/nilchain/v1/retrieval-sessions/"):
				sid := strings.TrimPrefix(r.URL.Path, "/nilchain/nilchain/v1/retrieval-sessions/")
				if sid != sessionB64 {
					http.NotFound(w, r)
					return
				}
				_ = json.NewEncoder(w).Encode(map[string]any{
					"session": map[string]any{
						"session_id":       base64.URLEncoding.EncodeToString(sessionBytes),
						"deal_id":          "1",
						"owner":            owner,
						"provider":         "nil1testprovider",
						"manifest_root":    base64.StdEncoding.EncodeToString(manifestRoot.Bytes[:]),
						"start_mdu_index":  "2",
						"start_blob_index": fmt.Sprintf("%d", startBlob),
						"blob_count":       "1",
						"total_bytes":      "131072",
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
				return
			}
		}))
	}

	// Missing session header => rejected.
	lcdSrv := makeLCD(0)
	defer lcdSrv.Close()
	oldLCD := lcdBase
	lcdBase = lcdSrv.URL
	t.Cleanup(func() { lcdBase = oldLCD })

	r := testRouter()
	u := fmt.Sprintf("/gateway/fetch/%s?deal_id=%d&owner=%s&file_path=video.mp4", manifestRoot.Canonical, dealID, owner)
	req := httptest.NewRequest(http.MethodGet, u, nil)
	req.Header.Set("Range", fmt.Sprintf("bytes=0-%d", len(fileContent)-1))
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 missing session, got %d (%s)", w.Code, w.Body.String())
	}

	// Range outside session => rejected.
	lcdSrv.Close()
	lcdSrv = makeLCD(1) // blob 1, but request hits blob 0
	defer lcdSrv.Close()
	lcdBase = lcdSrv.URL

	req2 := httptest.NewRequest(http.MethodGet, u, nil)
	req2.Header.Set("Range", fmt.Sprintf("bytes=0-%d", len(fileContent)-1))
	req2.Header.Set("X-Nil-Session-Id", sessionHex)
	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, req2)
	if w2.Code != http.StatusForbidden {
		t.Fatalf("expected 403 outside session, got %d (%s)", w2.Code, w2.Body.String())
	}

	// Valid session => fetch succeeds.
	lcdSrv.Close()
	lcdSrv = makeLCD(0)
	defer lcdSrv.Close()
	lcdBase = lcdSrv.URL

	req3 := httptest.NewRequest(http.MethodGet, u, nil)
	req3.Header.Set("Range", fmt.Sprintf("bytes=0-%d", len(fileContent)-1))
	req3.Header.Set("X-Nil-Session-Id", sessionHex)
	w3 := httptest.NewRecorder()
	r.ServeHTTP(w3, req3)
	if w3.Code != http.StatusPartialContent {
		t.Fatalf("expected 206, got %d (%s)", w3.Code, w3.Body.String())
	}
	if got := w3.Body.String(); got != string(fileContent) {
		t.Fatalf("content mismatch: want %q got %q", string(fileContent), got)
	}
}

func TestSpFetchShard_RequiresOnchainSession_WhenEnabled(t *testing.T) {
	requireOnchainSessionForTest(t, true)

	r := testRouter()
	req := httptest.NewRequest(http.MethodGet, "/sp/shard?deal_id=1&mdu_index=2&slot=0&manifest_root=0x"+strings.Repeat("11", 48), nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 missing session, got %d (%s)", w.Code, w.Body.String())
	}
}

func TestGatewayDebugRawFetch_RequiresOnchainSession_WhenEnabled(t *testing.T) {
	requireOnchainSessionForTest(t, true)
	useTempUploadDir(t)

	if err := crypto_ffi.Init(trustedSetup); err != nil {
		t.Fatalf("crypto_ffi.Init failed: %v", err)
	}

	owner := testDealOwner(t)

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

	const dealID = uint64(1)
	sessionHex := "0x" + strings.Repeat("22", 32)
	sessionBytes, _ := hex.DecodeString(strings.Repeat("22", 32))
	sessionB64 := base64.URLEncoding.EncodeToString(sessionBytes)

	lcdSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/cosmos/base/tendermint/v1beta1/blocks/latest"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"block": map[string]any{
					"header": map[string]any{
						"height": "10",
					},
				},
			})
			return
		case strings.HasPrefix(r.URL.Path, "/nilchain/nilchain/v1/deals/"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"deal": map[string]any{
					"id":           "1",
					"owner":        owner,
					"cid":          manifestRoot.Canonical,
					"end_block":    "1000",
					"service_hint": "",
				},
			})
			return
		case strings.HasPrefix(r.URL.Path, "/nilchain/nilchain/v1/retrieval-sessions/"):
			sid := strings.TrimPrefix(r.URL.Path, "/nilchain/nilchain/v1/retrieval-sessions/")
			if sid != sessionB64 {
				http.NotFound(w, r)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"session": map[string]any{
					"session_id":       base64.URLEncoding.EncodeToString(sessionBytes),
					"deal_id":          "1",
					"owner":            owner,
					"provider":         "nil1testprovider",
					"manifest_root":    base64.StdEncoding.EncodeToString(manifestRoot.Bytes[:]),
					"start_mdu_index":  "1",
					"start_blob_index": "0",
					"blob_count":       "1",
					"total_bytes":      "131072",
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
			return
		}
	}))
	defer lcdSrv.Close()
	oldLCD := lcdBase
	lcdBase = lcdSrv.URL
	t.Cleanup(func() { lcdBase = oldLCD })

	r := testRouter()
	q := url.Values{}
	q.Set("deal_id", "1")
	q.Set("owner", owner)
	q.Set("file_path", filePath)
	q.Set("range_start", "0")
	q.Set("range_len", fmt.Sprintf("%d", len(fileContent)))

	req := httptest.NewRequest(http.MethodGet, "/gateway/debug/raw-fetch/"+manifestRoot.Canonical+"?"+q.Encode(), nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 missing session, got %d (%s)", w.Code, w.Body.String())
	}

	req2 := httptest.NewRequest(http.MethodGet, "/gateway/debug/raw-fetch/"+manifestRoot.Canonical+"?"+q.Encode(), nil)
	req2.Header.Set("X-Nil-Session-Id", sessionHex)
	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("expected 200 with session, got %d (%s)", w2.Code, w2.Body.String())
	}
	if got := w2.Body.String(); got != string(fileContent) {
		t.Fatalf("content mismatch: want %q got %q", string(fileContent), got)
	}
}

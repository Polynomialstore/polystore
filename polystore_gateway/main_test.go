package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	ethcrypto "github.com/ethereum/go-ethereum/crypto"
	"github.com/gorilla/mux"

	gnarkBls12381 "github.com/consensys/gnark-crypto/ecc/bls12-381"

	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/types"
)

func useTempUploadDir(t *testing.T) string {
	t.Helper()
	old := uploadDir
	dir := t.TempDir()
	uploadDir = dir
	t.Cleanup(func() { uploadDir = old })
	return dir
}

func TestCreateTempInUploadRoot_RetriesAfterCachedDirDisappears(t *testing.T) {
	rootDir := filepath.Join(t.TempDir(), "deal-root")

	oldCache := uploadRootDirCache
	uploadRootDirCache = sync.Map{}
	t.Cleanup(func() { uploadRootDirCache = oldCache })

	if err := ensureUploadRootDir(rootDir); err != nil {
		t.Fatalf("ensureUploadRootDir failed: %v", err)
	}
	if err := os.RemoveAll(rootDir); err != nil {
		t.Fatalf("RemoveAll failed: %v", err)
	}

	tmp, err := createTempInUploadRoot(rootDir, "upload-*.tmp")
	if err != nil {
		t.Fatalf("createTempInUploadRoot failed: %v", err)
	}
	tmpPath := tmp.Name()
	_ = tmp.Close()
	t.Cleanup(func() { _ = os.Remove(tmpPath) })

	if got := filepath.Dir(tmpPath); got != rootDir {
		t.Fatalf("temp file created in wrong dir: got %q want %q", got, rootDir)
	}
	if _, err := os.Stat(rootDir); err != nil {
		t.Fatalf("expected root dir to be recreated: %v", err)
	}
}

// setupMockCombinedOutput mocks the CombinedOutput of exec.CommandContext.
// It returns a cleanup function to restore the original behavior.
func setupMockCombinedOutput(t *testing.T, mockFn func(ctx context.Context, name string, args ...string) ([]byte, error)) {
	t.Helper()
	oldMock := mockCombinedOutput
	mockCombinedOutput = mockFn
	t.Cleanup(func() { mockCombinedOutput = oldMock })
}

func deterministicManifestRootHex(tag string) string {
	sum := sha256.Sum256([]byte(tag))
	scalar := new(big.Int).SetBytes(sum[:])
	scalar.Add(scalar, big.NewInt(1))
	var p gnarkBls12381.G1Affine
	p.ScalarMultiplicationBase(scalar)
	b := p.Bytes()
	return "0x" + hex.EncodeToString(b[:])
}

func mustTestManifestRoot(t *testing.T, tag string) ManifestRoot {
	t.Helper()
	rootHex := deterministicManifestRootHex(tag)
	root, err := parseManifestRoot(rootHex)
	if err != nil {
		t.Fatalf("parseManifestRoot(%s) failed: %v", tag, err)
	}
	return root
}

func encodeRawToMdu(raw []byte) []byte {
	if len(raw) > RawMduCapacity {
		raw = raw[:RawMduCapacity]
	}
	encoded := make([]byte, types.MDU_SIZE)
	scalarIdx := 0
	for i := 0; i < len(raw) && scalarIdx < polyfsScalarsPerMdu; i += polyfsScalarPayloadBytes {
		end := i + polyfsScalarPayloadBytes
		if end > len(raw) {
			end = len(raw)
		}
		chunk := raw[i:end]
		pad := polyfsScalarBytes - len(chunk)
		offset := scalarIdx*polyfsScalarBytes + pad
		copy(encoded[offset:offset+len(chunk)], chunk)
		scalarIdx++
	}
	return encoded
}

const testEvmPrivKeyHex = "0x4f3edf983ac636a65a842ce7c78d9aa706d3b113b37a2b2d6f6fcf7e9f59b5f1"

func testDealOwner(t *testing.T) string {
	t.Helper()
	key, err := ethcrypto.HexToECDSA(strings.TrimPrefix(testEvmPrivKeyHex, "0x"))
	if err != nil {
		t.Fatalf("HexToECDSA failed: %v", err)
	}
	nilAddr, err := evmHexToNilAddress(ethcrypto.PubkeyToAddress(key.PublicKey).Hex())
	if err != nil {
		t.Fatalf("evmHexToNilAddress failed: %v", err)
	}
	return nilAddr
}

func signRetrievalRequest(t *testing.T, dealID uint64, filePath string, rangeStart uint64, rangeLen uint64, nonce uint64, expiresAt uint64) string {
	t.Helper()
	key, err := ethcrypto.HexToECDSA(strings.TrimPrefix(testEvmPrivKeyHex, "0x"))
	if err != nil {
		t.Fatalf("HexToECDSA failed: %v", err)
	}
	domainSep := types.HashDomainSeparator(eip712ChainID())
	structHash := types.HashRetrievalRequest(dealID, filePath, rangeStart, rangeLen, nonce, expiresAt)
	digest := types.ComputeEIP712Digest(domainSep, structHash)
	sig, err := ethcrypto.Sign(digest, key)
	if err != nil {
		t.Fatalf("Sign failed: %v", err)
	}
	return "0x" + hex.EncodeToString(sig)
}

// helper to build a router with only the GatewayFetch endpoint wired.
func testRouter() *mux.Router {
	r := mux.NewRouter()
	r.HandleFunc("/gateway/fetch/{cid}", GatewayFetch).Methods("GET", "OPTIONS")
	r.HandleFunc("/gateway/plan-retrieval-session/{cid}", GatewayPlanRetrievalSession).Methods("GET", "OPTIONS")
	r.HandleFunc("/gateway/open-session/{cid}", GatewayOpenSession).Methods("POST", "OPTIONS")
	r.HandleFunc("/gateway/debug/raw-fetch/{cid}", GatewayDebugRawFetch).Methods("GET", "OPTIONS")
	r.HandleFunc("/gateway/list-files/{cid}", GatewayListFiles).Methods("GET", "OPTIONS")
	r.HandleFunc("/gateway/slab/{cid}", GatewaySlab).Methods("GET", "OPTIONS")
	r.HandleFunc("/gateway/manifest-info/{cid}", GatewayManifestInfo).Methods("GET", "OPTIONS")
	r.HandleFunc("/gateway/mdu/{cid}/{index}", GatewayMdu).Methods("GET", "OPTIONS")
	r.HandleFunc("/gateway/mdu-kzg/{cid}/{index}", GatewayMduKzg).Methods("GET", "OPTIONS")
	r.HandleFunc("/gateway/upload", GatewayUpload).Methods("POST", "OPTIONS")
	r.HandleFunc("/sp/shard", SpFetchShard).Methods("GET", "OPTIONS")
	r.HandleFunc("/sp/upload_mdu", SpUploadMdu).Methods("POST", "OPTIONS")
	r.HandleFunc("/sp/upload_manifest", SpUploadManifest).Methods("POST", "OPTIONS")
	r.HandleFunc("/sp/upload_shard", SpUploadShard).Methods("POST", "OPTIONS")
	r.HandleFunc("/sp/upload_bundle", SpUploadBundle).Methods("POST", "OPTIONS")
	return r
}

func csvHeaderContains(value string, token string) bool {
	want := strings.ToLower(strings.TrimSpace(token))
	for _, part := range strings.Split(value, ",") {
		if strings.ToLower(strings.TrimSpace(part)) == want {
			return true
		}
	}
	return false
}

func TestGlobalCORSPreflight_AllowsUnknownPathAndRequestedHeaders(t *testing.T) {
	h := withGlobalCORS(testRouter())

	req := httptest.NewRequest(http.MethodOptions, "/sp/not-registered", nil)
	req.Header.Set("Origin", "https://polynomialstore.com")
	req.Header.Set("Access-Control-Request-Method", "POST")
	req.Header.Set("Access-Control-Request-Headers", "x-nil-deal-id,x-nil-slot,x-nil-custom-header,content-type")
	w := httptest.NewRecorder()

	h.ServeHTTP(w, req)

	if w.Code != http.StatusNoContent {
		t.Fatalf("expected 204 preflight, got %d", w.Code)
	}
	if got := strings.TrimSpace(w.Header().Get("Access-Control-Allow-Origin")); got != "https://polynomialstore.com" {
		t.Fatalf("expected Access-Control-Allow-Origin to echo request origin, got %q", got)
	}
	allowHeaders := w.Header().Get("Access-Control-Allow-Headers")
	for _, needed := range []string{"x-nil-deal-id", "x-nil-slot", "x-nil-custom-header", "content-type"} {
		if !csvHeaderContains(allowHeaders, needed) {
			t.Fatalf("expected Access-Control-Allow-Headers to include %q, got %q", needed, allowHeaders)
		}
	}
	if got := strings.TrimSpace(w.Header().Get("Access-Control-Allow-Private-Network")); got != "true" {
		t.Fatalf("expected Access-Control-Allow-Private-Network=true, got %q", got)
	}
}

func TestGlobalCORS_MethodNotAllowedStillReturnsCORSHeaders(t *testing.T) {
	h := withGlobalCORS(testRouter())

	req := httptest.NewRequest(http.MethodPost, "/sp/shard?deal_id=1&mdu_index=0&slot=0&manifest_root=0x00", nil)
	req.Header.Set("Origin", "https://polynomialstore.com")
	w := httptest.NewRecorder()

	h.ServeHTTP(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405 for POST /sp/shard, got %d", w.Code)
	}
	if got := strings.TrimSpace(w.Header().Get("Access-Control-Allow-Origin")); got != "https://polynomialstore.com" {
		t.Fatalf("expected Access-Control-Allow-Origin to be present on 405, got %q", got)
	}
	if got := strings.TrimSpace(w.Header().Get("Access-Control-Allow-Methods")); got == "" {
		t.Fatalf("expected Access-Control-Allow-Methods on 405 response")
	}
}

func TestSpUploadMdu_PreflightReturnsCORSHeaders(t *testing.T) {
	h := withGlobalCORS(testRouter())

	req := httptest.NewRequest(http.MethodOptions, "/sp/upload_mdu", nil)
	req.Header.Set("Origin", "https://web.polynomialstore.com")
	req.Header.Set("Access-Control-Request-Method", http.MethodPost)
	req.Header.Set("Access-Control-Request-Headers", "x-nil-deal-id,x-nil-mdu-index,x-nil-manifest-root,x-nil-full-size,content-type")
	w := httptest.NewRecorder()

	h.ServeHTTP(w, req)

	if w.Code != http.StatusNoContent {
		t.Fatalf("expected 204 preflight for /sp/upload_mdu, got %d", w.Code)
	}
	if got := strings.TrimSpace(w.Header().Get("Access-Control-Allow-Origin")); got != "https://web.polynomialstore.com" {
		t.Fatalf("expected Access-Control-Allow-Origin to echo request origin, got %q", got)
	}
	if !csvHeaderContains(w.Header().Get("Access-Control-Allow-Methods"), http.MethodPost) {
		t.Fatalf("expected Access-Control-Allow-Methods to include POST, got %q", w.Header().Get("Access-Control-Allow-Methods"))
	}
	for _, needed := range []string{
		"x-nil-deal-id",
		"x-nil-mdu-index",
		"x-nil-manifest-root",
		"x-nil-full-size",
		"content-type",
	} {
		if !csvHeaderContains(w.Header().Get("Access-Control-Allow-Headers"), needed) {
			t.Fatalf("expected Access-Control-Allow-Headers to include %q, got %q", needed, w.Header().Get("Access-Control-Allow-Headers"))
		}
	}
}

func TestPanicRecovery_ReturnsJSONAndCORSHeaders(t *testing.T) {
	h := withPanicRecovery(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("upload worker crashed")
	}))
	req := httptest.NewRequest(http.MethodGet, "/panic", nil)
	req.Header.Set("Origin", "https://polynomialstore.com")
	w := httptest.NewRecorder()

	h.ServeHTTP(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 on panic, got %d", w.Code)
	}

	if got := strings.TrimSpace(w.Header().Get("Access-Control-Allow-Origin")); got != "https://polynomialstore.com" {
		t.Fatalf("expected Access-Control-Allow-Origin to mirror request origin, got %q", got)
	}

	var payload jsonErrorResponse
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatalf("expected JSON error response: %v", err)
	}
	if payload.Error != "internal server error" {
		t.Fatalf("expected internal server error message, got %q", payload.Error)
	}
	if payload.Hint != "upload worker crashed" {
		t.Fatalf("expected recovery hint, got %q", payload.Hint)
	}
}

func TestSpUploadMdu_DrainsBodyOnEarlyError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(SpUploadMdu))
	defer srv.Close()

	req, err := http.NewRequest(http.MethodPost, srv.URL, bytes.NewReader(make([]byte, types.MDU_SIZE)))
	if err != nil {
		t.Fatalf("NewRequest failed: %v", err)
	}

	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("expected status response, got error: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadRequest {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected 400, got %d (%s)", resp.StatusCode, string(body))
	}
}

func TestSpUploadMdu_AcceptsSparseBodyWithFullSizeHeader(t *testing.T) {
	useTempUploadDir(t)
	resetPolyfsCASStatusCountersForTest()
	resetPolyfsUploadRootPreflightCacheForTest()

	manifestRoot := mustTestManifestRoot(t, "sp-upload-mdu-sparse")
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

	body := bytes.Repeat([]byte{0xAB}, 2048)
	req := httptest.NewRequest(http.MethodPost, "/sp/upload_mdu", bytes.NewReader(body))
	req.Header.Set("X-Nil-Deal-ID", "1")
	req.Header.Set("X-Nil-Mdu-Index", "0")
	req.Header.Set("X-Nil-Manifest-Root", manifestRoot.Canonical)
	req.Header.Set(nilUploadPreviousManifestRootHeader, "")
	req.Header.Set("X-Nil-Full-Size", strconv.Itoa(types.MDU_SIZE))
	req.Header.Set("Content-Type", "application/octet-stream")

	w := httptest.NewRecorder()
	r := testRouter()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	path := filepath.Join(uploadDir, "deals", "1", manifestRoot.Key, "mdu_0.bin")
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read mdu_0.bin: %v", err)
	}
	if len(got) != types.MDU_SIZE {
		t.Fatalf("unexpected mdu size: got=%d want=%d", len(got), types.MDU_SIZE)
	}
	if !bytes.Equal(got[:len(body)], body) {
		t.Fatalf("stored MDU prefix mismatch")
	}
}

func TestSpUploadMdu_RejectsStalePreviousManifestRoot(t *testing.T) {
	useTempUploadDir(t)
	resetPolyfsCASStatusCountersForTest()
	resetPolyfsUploadRootPreflightCacheForTest()

	manifestRoot := mustTestManifestRoot(t, "sp-upload-mdu-stale")
	currentRoot := mustTestManifestRoot(t, "sp-upload-mdu-current")

	srv := dynamicMockDealServer(map[uint64]struct {
		Owner string
		CID   string
	}{
		1: {Owner: "nil1owner", CID: currentRoot.Canonical},
	})
	defer srv.Close()
	oldLCD := lcdBase
	lcdBase = srv.URL
	t.Cleanup(func() { lcdBase = oldLCD })

	req := httptest.NewRequest(http.MethodPost, "/sp/upload_mdu", bytes.NewReader(bytes.Repeat([]byte{0xAB}, 128)))
	req.Header.Set("X-Nil-Deal-ID", "1")
	req.Header.Set("X-Nil-Mdu-Index", "0")
	req.Header.Set("X-Nil-Manifest-Root", manifestRoot.Canonical)
	req.Header.Set(nilUploadPreviousManifestRootHeader, mustTestManifestRoot(t, "sp-upload-mdu-stale-prev").Canonical)
	req.Header.Set("X-Nil-Full-Size", strconv.Itoa(types.MDU_SIZE))

	w := httptest.NewRecorder()
	http.HandlerFunc(SpUploadMdu).ServeHTTP(w, req)

	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "stale previous_manifest_root") {
		t.Fatalf("expected stale previous_manifest_root error, got %q", w.Body.String())
	}
	if got := polyfsCASStatusSnapshotForStatus()["polyfs_cas_preflight_conflicts_upload"]; got != "1" {
		t.Fatalf("expected polyfs_cas_preflight_conflicts_upload=1, got %q", got)
	}
}

func TestSpUploadShard_AcceptsSparseBodyWithFullSizeHeader(t *testing.T) {
	useTempUploadDir(t)
	resetPolyfsCASStatusCountersForTest()
	resetPolyfsUploadRootPreflightCacheForTest()

	manifestRoot := mustTestManifestRoot(t, "sp-upload-shard-sparse")
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

	body := bytes.Repeat([]byte{0xCD}, 1024)
	fullSize := 4096
	req := httptest.NewRequest(http.MethodPost, "/sp/upload_shard", bytes.NewReader(body))
	req.Header.Set("X-Nil-Deal-ID", "1")
	req.Header.Set("X-Nil-Mdu-Index", "2")
	req.Header.Set("X-Nil-Slot", "1")
	req.Header.Set("X-Nil-Manifest-Root", manifestRoot.Canonical)
	req.Header.Set(nilUploadPreviousManifestRootHeader, "")
	req.Header.Set("X-Nil-Full-Size", strconv.Itoa(fullSize))
	req.Header.Set("Content-Type", "application/octet-stream")

	w := httptest.NewRecorder()
	handler := http.HandlerFunc(SpUploadShard)
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	path := filepath.Join(uploadDir, "deals", "1", manifestRoot.Key, "mdu_2_slot_1.bin")
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read shard: %v", err)
	}
	if len(got) != fullSize {
		t.Fatalf("unexpected shard size: got=%d want=%d", len(got), fullSize)
	}
	if !bytes.Equal(got[:len(body)], body) {
		t.Fatalf("stored shard prefix mismatch")
	}
}

func TestSpUploadShard_RejectsStalePreviousManifestRoot(t *testing.T) {
	useTempUploadDir(t)
	resetPolyfsCASStatusCountersForTest()
	resetPolyfsUploadRootPreflightCacheForTest()

	manifestRoot := mustTestManifestRoot(t, "sp-upload-shard-stale")
	currentRoot := mustTestManifestRoot(t, "sp-upload-shard-current")

	srv := dynamicMockDealServer(map[uint64]struct {
		Owner string
		CID   string
	}{
		1: {Owner: "nil1owner", CID: currentRoot.Canonical},
	})
	defer srv.Close()
	oldLCD := lcdBase
	lcdBase = srv.URL
	t.Cleanup(func() { lcdBase = oldLCD })

	req := httptest.NewRequest(http.MethodPost, "/sp/upload_shard", bytes.NewReader(bytes.Repeat([]byte{0xCD}, 128)))
	req.Header.Set("X-Nil-Deal-ID", "1")
	req.Header.Set("X-Nil-Mdu-Index", "2")
	req.Header.Set("X-Nil-Slot", "1")
	req.Header.Set("X-Nil-Manifest-Root", manifestRoot.Canonical)
	req.Header.Set(nilUploadPreviousManifestRootHeader, mustTestManifestRoot(t, "sp-upload-shard-stale-prev").Canonical)
	req.Header.Set("X-Nil-Full-Size", "4096")

	w := httptest.NewRecorder()
	http.HandlerFunc(SpUploadShard).ServeHTTP(w, req)

	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "stale previous_manifest_root") {
		t.Fatalf("expected stale previous_manifest_root error, got %q", w.Body.String())
	}
	if got := polyfsCASStatusSnapshotForStatus()["polyfs_cas_preflight_conflicts_upload"]; got != "1" {
		t.Fatalf("expected polyfs_cas_preflight_conflicts_upload=1, got %q", got)
	}
}

func TestGatewayFetch_MissingParams(t *testing.T) {
	requireOnchainSessionForTest(t, false)
	r := testRouter()

	root := mustTestManifestRoot(t, "missing-params")
	req := httptest.NewRequest("GET", "/gateway/fetch/"+root.Canonical, nil)
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

func TestGatewayFetch_UnsignedMissingRangeRejected(t *testing.T) {
	requireOnchainSessionForTest(t, false)
	useTempUploadDir(t)

	oldRequireSig := requireRetrievalReqSig
	requireRetrievalReqSig = false
	t.Cleanup(func() { requireRetrievalReqSig = oldRequireSig })

	manifestRoot := mustTestManifestRoot(t, "unsigned-missing-range")
	dealDir := filepath.Join(uploadDir, manifestRoot.Key)
	if err := os.MkdirAll(dealDir, 0o755); err != nil {
		t.Fatalf("mkdir deal dir: %v", err)
	}
	b := crypto_ffi.NewMdu0Builder(1)
	defer b.Free()
	mdu0Data, err := b.Bytes()
	if err != nil {
		t.Fatalf("build mdu0: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_0.bin"), mdu0Data, 0o644); err != nil {
		t.Fatalf("write mdu_0.bin: %v", err)
	}

	owner := testDealOwner(t)
	dealID := uint64(7)
	srv := dynamicMockDealServer(map[uint64]struct {
		Owner string
		CID   string
	}{
		dealID: {Owner: owner, CID: manifestRoot.Canonical},
	})
	defer srv.Close()
	oldLCD := lcdBase
	lcdBase = srv.URL
	t.Cleanup(func() { lcdBase = oldLCD })

	q := url.Values{}
	q.Set("deal_id", strconv.FormatUint(dealID, 10))
	q.Set("owner", owner)
	q.Set("file_path", "note.txt")

	req := httptest.NewRequest(http.MethodGet, "/gateway/fetch/"+manifestRoot.Canonical+"?"+q.Encode(), nil)
	w := httptest.NewRecorder()

	testRouter().ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for unsigned fetch without Range, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "Range header is required") {
		t.Fatalf("expected Range header error, got: %s", w.Body.String())
	}
}

func TestGatewayFetch_OwnerMismatch(t *testing.T) {
	requireOnchainSessionForTest(t, false)
	r := testRouter()

	// Stub LCD so fetchDealOwnerAndCID returns a specific owner/cid.
	root := mustTestManifestRoot(t, "owner-mismatch")
	realOwner := testDealOwner(t)
	dealStates := map[uint64]struct {
		Owner string
		CID   string
	}{
		1: {Owner: realOwner, CID: root.Canonical},
	}
	srv := dynamicMockDealServer(dealStates)
	defer srv.Close()
	oldLCD := lcdBase
	lcdBase = srv.URL
	defer func() { lcdBase = oldLCD }()

	q := url.Values{}
	q.Set("deal_id", "1")
	q.Set("owner", "nil1otherowner")
	q.Set("file_path", "video.mp4")
	req := httptest.NewRequest("GET", "/gateway/fetch/"+root.Canonical+"?"+q.Encode(), nil)
	req.Header.Set("X-Nil-Req-Sig", "0x"+strings.Repeat("11", 65))
	req.Header.Set("X-Nil-Req-Nonce", "1")
	req.Header.Set("X-Nil-Req-Expires-At", strconv.FormatUint(uint64(time.Now().Unix())+120, 10))
	req.Header.Set("X-Nil-Req-Range-Start", "0")
	req.Header.Set("X-Nil-Req-Range-Len", "0")
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for owner mismatch, got %d", w.Code)
	}
}

func TestGatewayFetch_CIDMismatch(t *testing.T) {
	requireOnchainSessionForTest(t, false)
	r := testRouter()

	// Stub LCD: owner matches, cid does not.
	rootReq := mustTestManifestRoot(t, "cid-mismatch-req")
	rootChain := mustTestManifestRoot(t, "cid-mismatch-chain")
	owner := testDealOwner(t)
	dealStates := map[uint64]struct {
		Owner string
		CID   string
	}{
		2: {Owner: owner, CID: rootChain.Canonical},
	}
	srv := dynamicMockDealServer(dealStates)
	defer srv.Close()
	oldLCD := lcdBase
	lcdBase = srv.URL
	defer func() { lcdBase = oldLCD }()

	q := url.Values{}
	q.Set("deal_id", "2")
	q.Set("owner", owner)
	q.Set("file_path", "video.mp4")
	nonce := uint64(1)
	expiresAt := uint64(time.Now().Unix()) + 120
	req := httptest.NewRequest("GET", "/gateway/fetch/"+rootReq.Canonical+"?"+q.Encode(), nil)
	req.Header.Set("X-Nil-Req-Sig", signRetrievalRequest(t, 2, "video.mp4", 0, 0, nonce, expiresAt))
	req.Header.Set("X-Nil-Req-Nonce", strconv.FormatUint(nonce, 10))
	req.Header.Set("X-Nil-Req-Expires-At", strconv.FormatUint(expiresAt, 10))
	req.Header.Set("X-Nil-Req-Range-Start", "0")
	req.Header.Set("X-Nil-Req-Range-Len", "0")
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409 for cid mismatch, got %d", w.Code)
	}
	if got := strings.TrimSpace(w.Header().Get("X-Nil-Cache-Freshness")); got != "stale" {
		t.Fatalf("expected stale cache freshness header, got %q", got)
	}
	if got := strings.TrimSpace(w.Header().Get("X-Nil-Cache-Freshness-Reason")); got != "stale_manifest_mismatch" {
		t.Fatalf("expected stale_manifest_mismatch reason, got %q", got)
	}
}

func TestGatewayFetch_ChainLookupFailureSetsFreshnessReason(t *testing.T) {
	requireOnchainSessionForTest(t, false)
	oldRequireSig := requireRetrievalReqSig
	requireRetrievalReqSig = false
	t.Cleanup(func() { requireRetrievalReqSig = oldRequireSig })
	clearDealMetaCache()
	t.Cleanup(clearDealMetaCache)
	r := testRouter()

	owner := testDealOwner(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer srv.Close()
	oldLCD := lcdBase
	lcdBase = srv.URL
	defer func() { lcdBase = oldLCD }()

	manifestRoot := mustTestManifestRoot(t, "chain-lookup-failure")
	q := url.Values{}
	q.Set("deal_id", "7")
	q.Set("owner", owner)
	q.Set("file_path", "missing.txt")
	req := httptest.NewRequest("GET", "/gateway/fetch/"+manifestRoot.Canonical+"?"+q.Encode(), nil)
	req.Header.Set("Range", "bytes=0-127")
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 for chain lookup failure, got %d", w.Code)
	}
	if got := strings.TrimSpace(w.Header().Get("X-Nil-Cache-Freshness")); got != "unknown" {
		t.Fatalf("expected unknown cache freshness header, got %q", got)
	}
	if got := strings.TrimSpace(w.Header().Get("X-Nil-Cache-Freshness-Reason")); got != "chain_lookup_failed" {
		t.Fatalf("expected chain_lookup_failed reason, got %q", got)
	}
}

func TestFetchDealMeta_UsesShortTTLCache(t *testing.T) {
	clearDealMetaCache()
	origTTL := dealMetaCacheTTL
	origFreshnessTTL := freshnessMemoTTL
	dealMetaCacheTTL = 30 * time.Millisecond
	freshnessMemoTTL = 30 * time.Millisecond
	t.Cleanup(func() {
		dealMetaCacheTTL = origTTL
		freshnessMemoTTL = origFreshnessTTL
		clearDealMetaCache()
	})

	requestCount := 0
	owner := testDealOwner(t)
	manifestRoot := mustTestManifestRoot(t, "deal-meta-cache").Canonical
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"deal":{"id":"11","owner":"` + owner + `","cid":"` + manifestRoot + `","end_block":"100"}}`))
	}))
	defer srv.Close()
	oldLCD := lcdBase
	lcdBase = srv.URL
	defer func() { lcdBase = oldLCD }()

	meta1, err := fetchDealMeta(11)
	if err != nil {
		t.Fatalf("first fetchDealMeta failed: %v", err)
	}
	meta2, err := fetchDealMeta(11)
	if err != nil {
		t.Fatalf("second fetchDealMeta failed: %v", err)
	}
	if requestCount != 1 {
		t.Fatalf("expected one LCD request within TTL, got %d", requestCount)
	}
	if meta1.ManifestRoot != manifestRoot || meta2.ManifestRoot != manifestRoot {
		t.Fatalf("unexpected manifest roots: %q / %q", meta1.ManifestRoot, meta2.ManifestRoot)
	}

	time.Sleep(40 * time.Millisecond)
	if _, err := fetchDealMeta(11); err != nil {
		t.Fatalf("third fetchDealMeta after TTL failed: %v", err)
	}
	if requestCount < 2 {
		t.Fatalf("expected cache expiry to trigger a new LCD request, got %d", requestCount)
	}
}

func TestFetchDealMetaFresh_SingleflightsConcurrentRequests(t *testing.T) {
	clearDealMetaCache()
	t.Cleanup(clearDealMetaCache)

	var requestCount atomic.Int32
	owner := testDealOwner(t)
	manifestRoot := mustTestManifestRoot(t, "deal-meta-fresh-singleflight").Canonical
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount.Add(1)
		time.Sleep(25 * time.Millisecond)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"deal":{"id":"12","owner":"` + owner + `","cid":"` + manifestRoot + `","end_block":"100"}}`))
	}))
	defer srv.Close()
	oldLCD := lcdBase
	lcdBase = srv.URL
	defer func() { lcdBase = oldLCD }()

	const workers = 8
	errs := make(chan error, workers)
	var wg sync.WaitGroup
	wg.Add(workers)
	for i := 0; i < workers; i += 1 {
		go func() {
			defer wg.Done()
			meta, err := fetchDealMetaFresh(12)
			if err == nil && meta.ManifestRoot != manifestRoot {
				err = fmt.Errorf("unexpected manifest root: %q", meta.ManifestRoot)
			}
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)

	for err := range errs {
		if err != nil {
			t.Fatalf("fetchDealMetaFresh failed: %v", err)
		}
	}

	if got := requestCount.Load(); got != 1 {
		t.Fatalf("expected fresh singleflight to collapse to 1 LCD request, got %d", got)
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
			ManifestRootHex: deterministicManifestRootHex("user-root"),
			ManifestBlobHex: "0xdeadbeef",
			FileSize:        100,
			Mdus: []MduData{
				{Index: 0, RootHex: "0x1111", Blobs: []string{"0xaaaa"}},
			},
		}
		switch {
		case strings.Contains(inputBase, "witness"):
			output.ManifestRootHex = deterministicManifestRootHex("witness-root")
		case strings.Contains(inputBase, "mdu0"):
			output.ManifestRootHex = deterministicManifestRootHex("mdu0-root")
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
			ManifestRootHex: deterministicManifestRootHex("aggregate-root"),
			ManifestBlobHex: "0xfeedface",
		}
		data, _ := json.Marshal(res)
		if err := os.WriteFile(outPath, data, 0o644); err != nil {
			fmt.Fprintf(os.Stderr, "write aggregate output: %v\n", err)
			os.Exit(1)
		}
	}
}

// handleSavePrefix mimics polystore_cli behavior by creating dummy MDU files if --save-mdu-prefix is set.
func handleSavePrefix(args []string) error {
	savePrefix := ""
	for i, arg := range args {
		if arg == "--save-mdu-prefix" && i+1 < len(args) {
			savePrefix = args[i+1]
			break
		}
	}
	if savePrefix != "" {
		if err := os.MkdirAll(filepath.Dir(savePrefix), 0o755); err != nil {
			return err
		}
		// Create a dummy mdu.0.bin file
		if err := os.WriteFile(fmt.Sprintf("%s.mdu.0.bin", savePrefix), []byte("dummy"), 0o644); err != nil {
			return err
		}
	}
	return nil
}

func TestGatewayUpload_NewDealLifecycle(t *testing.T) {
	useTempUploadDir(t)
	setupMockCombinedOutput(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if name == nilCliPath {
			if hasArg(args, "shard") {
				if err := handleSavePrefix(args); err != nil {
					return nil, err
				}
				output := NilCliOutput{
					ManifestRootHex: deterministicManifestRootHex("new-deal-lifecycle"),
					ManifestBlobHex: "0xdeadbeef",
					FileSize:        100,
					Mdus:            []MduData{{Index: 0, RootHex: "0x1111", Blobs: []string{"0xaaaa"}}},
				}
				data, _ := json.Marshal(output)
				return data, nil
			}
			if hasArg(args, "aggregate") {
				outPath := ""
				for i, arg := range args {
					if arg == "--out" && i+1 < len(args) {
						outPath = args[i+1]
						break
					}
				}
				if outPath != "" {
					res := NilCliAggregateOutput{
						ManifestRootHex: deterministicManifestRootHex("new-deal-lifecycle"),
						ManifestBlobHex: "0xfeedface",
					}
					data, _ := json.Marshal(res)
					_ = os.WriteFile(outPath, data, 0o644)
				}
				return []byte{}, nil
			}
		}
		return []byte{}, nil
	})

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
	setupMockCombinedOutput(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if name == nilCliPath && hasArg(args, "shard") {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(200 * time.Millisecond): // Simulate long running command
				output := NilCliOutput{ManifestRootHex: deterministicManifestRootHex("timeout-shard")}
				data, _ := json.Marshal(output)
				return data, nil
			}
		}
		return []byte{}, nil
	})

	input := filepath.Join(uploadDir, "input.bin")
	if err := os.WriteFile(input, []byte("hi"), 0o644); err != nil {
		t.Fatalf("write input: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	_, err := shardFile(ctx, input, false, "")
	if err == nil {
		t.Fatalf("expected timeout error, got nil")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected DeadlineExceeded, got %v", err)
	}
}

func TestGatewayUpload_TimeoutReturns408AndNoDealDir(t *testing.T) {
	useTempUploadDir(t)
	setupMockCombinedOutput(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if name == nilCliPath && hasArg(args, "shard") {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(200 * time.Millisecond): // Simulate long running command
				// Even on timeout, sometimes partial files are written, but here we assume not?
				// Actually, if it times out, we return error.
				return nil, context.DeadlineExceeded
			}
		}
		return []byte{}, nil
	})

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
	setupMockCombinedOutput(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if name == nilCliPath {
			if hasArg(args, "shard") {
				output := NilCliOutput{
					ManifestRootHex: deterministicManifestRootHex("ingest-raw"),
					ManifestBlobHex: "0xdeadbeef",
					FileSize:        100,
					Mdus:            []MduData{{Index: 0, RootHex: "0x1111", Blobs: []string{"0xaaaa"}}},
				}
				// Check for EXPECT_MDU0_RAW behavior, as it implies mocking mdu0 specifically.
				if os.Getenv("EXPECT_MDU0_RAW") == "1" && strings.Contains(args[1], "mdu0") && !hasArg(args, "--raw") {
					return nil, fmt.Errorf("expected --raw for mdu0 sharding")
				}
				if err := handleSavePrefix(args); err != nil {
					return nil, err
				}
				data, _ := json.Marshal(output)
				return data, nil
			}
			if hasArg(args, "aggregate") {
				outPath := ""
				for i, arg := range args {
					if arg == "--out" && i+1 < len(args) {
						outPath = args[i+1]
						break
					}
				}
				if outPath != "" {
					res := NilCliAggregateOutput{
						ManifestRootHex: deterministicManifestRootHex("ingest-raw"),
						ManifestBlobHex: "0xfeedface",
					}
					data, _ := json.Marshal(res)
					_ = os.WriteFile(outPath, data, 0o644)
				}
				return []byte{}, nil
			}
		}
		return []byte{}, nil
	})
	t.Setenv("EXPECT_MDU0_RAW", "1")

	input := filepath.Join(uploadDir, "file.txt")
	if err := os.WriteFile(input, []byte("hi"), 0o644); err != nil {
		t.Fatalf("write input: %v", err)
	}

	_, manifestRoot, _, err := IngestNewDeal(context.Background(), input, 256, "", 0)
	if err != nil {
		t.Fatalf("IngestNewDeal failed: %v", err)
	}
	parsed, err := parseManifestRoot(manifestRoot)
	if err != nil {
		t.Fatalf("parseManifestRoot failed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(uploadDir, parsed.Key)); err != nil {
		t.Fatalf("expected deal dir to exist: %v", err)
	}
}

// hasArg checks if a string slice contains a specific argument.
func hasArg(args []string, target string) bool {
	for _, arg := range args {
		if arg == target {
			return true
		}
	}
	return false
}

func TestGatewayFetch_DealIDZero(t *testing.T) {
	requireOnchainSessionForTest(t, false)
	useTempUploadDir(t)
	t.Setenv("NIL_PROVIDER_ADDRESS", "nil1testprovider")
	owner := testDealOwner(t)
	oldRequireSig := requireRetrievalReqSig
	requireRetrievalReqSig = true
	t.Cleanup(func() { requireRetrievalReqSig = oldRequireSig })

	// 1. Build a minimal slab manually
	fileContent := []byte("This is some test data for Deal ID 0.")

	// Create dummy witness data (doesn't need to be valid for this test if we mock the proof generation or if generateProofHeaderJSON handles dummy data gracefully,
	// but generateProofHeaderJSON checks valid lengths. So we need valid length witness).
	commitmentBytes := 48
	witnessPlain := make([]byte, 64*commitmentBytes) // Full MDU of commitments
	// Fill with something
	for i := 0; i < len(witnessPlain); i++ {
		witnessPlain[i] = 0xaa
	}

	// We need a manifest root. We can compute a dummy one or use deterministic.
	// But GatewayFetch checks chain root matches.
	// We'll use a deterministic one and assume it matches the slab we build.
	manifestRoot := mustTestManifestRoot(t, "deal0-manual")
	dealDir := filepath.Join(uploadDir, manifestRoot.Key)
	if err := os.MkdirAll(dealDir, 0o755); err != nil {
		t.Fatalf("mkdir deal dir: %v", err)
	}

	// Create MDU #0 (File Table)
	b := crypto_ffi.NewMdu0Builder(1)
	defer b.Free()
	b.AppendFile("deal0_test.txt", uint64(len(fileContent)), 0)

	mdu0Bytes, _ := b.Bytes()
	os.WriteFile(filepath.Join(dealDir, "mdu_0.bin"), mdu0Bytes, 0o644)

	// Create manifest.bin (128KB dummy)
	manifestBlob := make([]byte, 128*1024)
	os.WriteFile(filepath.Join(dealDir, "manifest.bin"), manifestBlob, 0o644)

	// Create Witness MDU #1
	os.WriteFile(filepath.Join(dealDir, "mdu_1.bin"), encodeRawToMdu(witnessPlain), 0o644)

	// Create User MDU #2
	os.WriteFile(filepath.Join(dealDir, "mdu_2.bin"), encodeRawToMdu(fileContent), 0o644)

	// 2. Mock LCD to serve Deal ID 0
	dealID := uint64(0)
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

	// 3. Fetch
	fetchURL := fmt.Sprintf("/gateway/fetch/%s?deal_id=%d&owner=%s&file_path=deal0_test.txt", manifestRoot.Canonical, dealID, owner)
	nonce := uint64(1)
	expiresAt := uint64(time.Now().Unix()) + 120
	fetchReq := httptest.NewRequest("GET", fetchURL, nil)
	fetchReq.Header.Set("X-Nil-Req-Sig", signRetrievalRequest(t, dealID, "deal0_test.txt", 0, 0, nonce, expiresAt))
	fetchReq.Header.Set("X-Nil-Req-Nonce", strconv.FormatUint(nonce, 10))
	fetchReq.Header.Set("X-Nil-Req-Expires-At", strconv.FormatUint(expiresAt, 10))
	fetchReq.Header.Set("X-Nil-Req-Range-Start", "0")
	fetchReq.Header.Set("X-Nil-Req-Range-Len", "0")
	fetchW := httptest.NewRecorder()

	r.ServeHTTP(fetchW, fetchReq)

	if fetchW.Code != http.StatusOK {
		t.Fatalf("GatewayFetch for Deal 0 failed: %d, body: %s", fetchW.Code, fetchW.Body.String())
	}

	fetchedContent, _ := io.ReadAll(fetchW.Body)
	if string(fetchedContent) != string(fileContent) {
		t.Fatalf("Fetched content mismatch. Expected: %q, Got: %q", string(fileContent), string(fetchedContent))
	}
}

func TestGatewayOpenSession_UnsignedDoesNotRequireNonce(t *testing.T) {
	useTempUploadDir(t)
	t.Setenv("NIL_PROVIDER_ADDRESS", "nil1testprovider")
	owner := testDealOwner(t)

	oldRequireSig := requireRetrievalReqSig
	requireRetrievalReqSig = false
	t.Cleanup(func() { requireRetrievalReqSig = oldRequireSig })

	// Minimal PolyFS slab with a single small file.
	fileContent := []byte("hello from open-session")
	manifestRoot := mustTestManifestRoot(t, "open-session-unsigned")
	dealDir := filepath.Join(uploadDir, manifestRoot.Key)
	if err := os.MkdirAll(dealDir, 0o755); err != nil {
		t.Fatalf("mkdir deal dir: %v", err)
	}

	b := crypto_ffi.NewMdu0Builder(1)
	defer b.Free()
	b.AppendFile("note.txt", uint64(len(fileContent)), 0)

	mdu0Bytes, _ := b.Bytes()
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_0.bin"), mdu0Bytes, 0o644); err != nil {
		t.Fatalf("write mdu_0.bin: %v", err)
	}
	manifestBlob := make([]byte, 128*1024)
	if err := os.WriteFile(filepath.Join(dealDir, "manifest.bin"), manifestBlob, 0o644); err != nil {
		t.Fatalf("write manifest.bin: %v", err)
	}

	witnessPlain := make([]byte, 64*48)
	for i := 0; i < len(witnessPlain); i++ {
		witnessPlain[i] = 0xaa
	}
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_1.bin"), encodeRawToMdu(witnessPlain), 0o644); err != nil {
		t.Fatalf("write mdu_1.bin: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_2.bin"), encodeRawToMdu(fileContent), 0o644); err != nil {
		t.Fatalf("write mdu_2.bin: %v", err)
	}

	// Stub LCD to serve Deal ID 0 owner/cid.
	dealID := uint64(0)
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

	openURL := fmt.Sprintf("/gateway/open-session/%s?deal_id=%d&owner=%s&file_path=note.txt", manifestRoot.Canonical, dealID, owner)
	req := httptest.NewRequest(http.MethodPost, openURL, nil)
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("GatewayOpenSession failed: %d, body: %s", w.Code, w.Body.String())
	}

	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("expected json response: %v", err)
	}
	if strings.TrimSpace(fmt.Sprint(out["download_session"])) == "" {
		t.Fatalf("expected download_session in response, got: %v", out)
	}
}

func resetProviderAddressCacheForTest(t *testing.T) {
	t.Helper()
	providerAddrMu.Lock()
	prevCached := providerAddrCached
	prevLastAttempt := providerAddrLastAttempt
	providerAddrCached = ""
	providerAddrLastAttempt = time.Time{}
	providerAddrMu.Unlock()

	t.Cleanup(func() {
		providerAddrMu.Lock()
		providerAddrCached = prevCached
		providerAddrLastAttempt = prevLastAttempt
		providerAddrMu.Unlock()
	})
}

func preparePlanRetrievalTestSlab(t *testing.T, dealID uint64, root ManifestRoot, filePath string, fileLen uint64) {
	t.Helper()
	dealDir := dealScopedDir(dealID, root)
	if err := os.MkdirAll(dealDir, 0o755); err != nil {
		t.Fatalf("mkdir deal dir: %v", err)
	}

	builder := crypto_ffi.NewMdu0Builder(1)
	defer builder.Free()
	builder.AppendFile(filePath, fileLen, 0)
	mdu0, err := builder.Bytes()
	if err != nil {
		t.Fatalf("serialize mdu0: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_0.bin"), mdu0, 0o644); err != nil {
		t.Fatalf("write mdu_0.bin: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_1.bin"), make([]byte, types.MDU_SIZE), 0o644); err != nil {
		t.Fatalf("write mdu_1.bin: %v", err)
	}
}

func TestGatewayPlanRetrievalSession_UsesMetadataProviderWithoutLocalProvider(t *testing.T) {
	useTempUploadDir(t)
	resetProviderAddressCacheForTest(t)
	t.Setenv("NIL_PROVIDER_ADDRESS", "")
	t.Setenv("NIL_PROVIDER_KEY", "missing-provider-key")

	dealID := uint64(11)
	owner := testDealOwner(t)
	manifestRoot := mustTestManifestRoot(t, "plan-metadata-no-local-provider")
	preparePlanRetrievalTestSlab(t, dealID, manifestRoot, "plan.txt", 512)

	metadataProvider := "nil1metadataprovider"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/polystorechain/polystorechain/v1/deals/11" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"deal": map[string]any{
				"id":           "11",
				"owner":        owner,
				"cid":          manifestRoot.Canonical,
				"service_hint": "",
				"providers":    []string{metadataProvider, "nil1backupprovider"},
			},
		})
	}))
	defer srv.Close()

	oldLCD := lcdBase
	lcdBase = srv.URL
	defer func() { lcdBase = oldLCD }()

	dealProviderCache.Delete(dealID)
	dealProvidersCache.Delete(dealID)
	dealMode2SlotsCache.Delete(dealID)
	dealHintCache.Delete(dealID)

	r := testRouter()
	q := url.Values{}
	q.Set("deal_id", "11")
	q.Set("owner", owner)
	q.Set("file_path", "plan.txt")

	req := httptest.NewRequest(http.MethodGet, "/gateway/plan-retrieval-session/"+manifestRoot.Canonical+"?"+q.Encode(), nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("GatewayPlanRetrievalSession failed: %d, body: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Provider string `json:"provider"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Provider != metadataProvider {
		t.Fatalf("expected metadata provider %q, got %q", metadataProvider, resp.Provider)
	}
}

func TestGatewayPlanRetrievalSession_PrefersMetadataProviderOverLocalEnv(t *testing.T) {
	useTempUploadDir(t)
	resetProviderAddressCacheForTest(t)
	t.Setenv("NIL_PROVIDER_ADDRESS", "nil1localprovideroverride")

	dealID := uint64(12)
	owner := testDealOwner(t)
	manifestRoot := mustTestManifestRoot(t, "plan-metadata-over-local")
	preparePlanRetrievalTestSlab(t, dealID, manifestRoot, "plan.txt", 256)

	metadataProvider := "nil1metadataproviderx"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/polystorechain/polystorechain/v1/deals/12" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"deal": map[string]any{
				"id":           "12",
				"owner":        owner,
				"cid":          manifestRoot.Canonical,
				"service_hint": "",
				"providers":    []string{metadataProvider},
			},
		})
	}))
	defer srv.Close()

	oldLCD := lcdBase
	lcdBase = srv.URL
	defer func() { lcdBase = oldLCD }()

	dealProviderCache.Delete(dealID)
	dealProvidersCache.Delete(dealID)
	dealMode2SlotsCache.Delete(dealID)
	dealHintCache.Delete(dealID)

	r := testRouter()
	q := url.Values{}
	q.Set("deal_id", "12")
	q.Set("owner", owner)
	q.Set("file_path", "plan.txt")

	req := httptest.NewRequest(http.MethodGet, "/gateway/plan-retrieval-session/"+manifestRoot.Canonical+"?"+q.Encode(), nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("GatewayPlanRetrievalSession failed: %d, body: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Provider string `json:"provider"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Provider != metadataProvider {
		t.Fatalf("expected metadata provider %q, got %q", metadataProvider, resp.Provider)
	}
	if resp.Provider == "nil1localprovideroverride" {
		t.Fatalf("expected planner to ignore local provider override when deal metadata is available")
	}
}

func setPlanResolverForTest(t *testing.T, resolver func(context.Context, uint64, stripeParams, uint64) (retrievalProviderResolution, error)) {
	t.Helper()
	prev := resolveProviderForRetrievalPlanFn
	resolveProviderForRetrievalPlanFn = resolver
	t.Cleanup(func() { resolveProviderForRetrievalPlanFn = prev })
}

func TestGatewayPlanRetrievalSession_ProviderResolutionStatusMapping(t *testing.T) {
	useTempUploadDir(t)
	resetProviderAddressCacheForTest(t)
	t.Setenv("NIL_PROVIDER_ADDRESS", "")

	dealID := uint64(13)
	owner := testDealOwner(t)
	manifestRoot := mustTestManifestRoot(t, "plan-provider-status-map")
	preparePlanRetrievalTestSlab(t, dealID, manifestRoot, "plan.txt", 1024)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/polystorechain/polystorechain/v1/deals/13" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"deal": map[string]any{
				"id":           "13",
				"owner":        owner,
				"cid":          manifestRoot.Canonical,
				"service_hint": "",
				"providers":    []string{"nil1providerforstatus"},
			},
		})
	}))
	defer srv.Close()

	oldLCD := lcdBase
	lcdBase = srv.URL
	defer func() { lcdBase = oldLCD }()

	tests := []struct {
		name       string
		resolver   func(context.Context, uint64, stripeParams, uint64) (retrievalProviderResolution, error)
		wantStatus int
	}{
		{
			name: "slot out of range maps to 400",
			resolver: func(context.Context, uint64, stripeParams, uint64) (retrievalProviderResolution, error) {
				return retrievalProviderResolution{}, fmt.Errorf("%w: test", ErrProviderResolutionSlotOutOfRange)
			},
			wantStatus: http.StatusBadRequest,
		},
		{
			name: "metadata unavailable maps to 502",
			resolver: func(context.Context, uint64, stripeParams, uint64) (retrievalProviderResolution, error) {
				return retrievalProviderResolution{}, fmt.Errorf("%w: test", ErrProviderResolutionMetadataUnavailable)
			},
			wantStatus: http.StatusBadGateway,
		},
		{
			name: "metadata invalid maps to 409",
			resolver: func(context.Context, uint64, stripeParams, uint64) (retrievalProviderResolution, error) {
				return retrievalProviderResolution{}, fmt.Errorf("%w: test", ErrProviderResolutionMetadataInvalid)
			},
			wantStatus: http.StatusConflict,
		},
	}

	r := testRouter()
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			setPlanResolverForTest(t, tc.resolver)

			q := url.Values{}
			q.Set("deal_id", "13")
			q.Set("owner", owner)
			q.Set("file_path", "plan.txt")

			req := httptest.NewRequest(http.MethodGet, "/gateway/plan-retrieval-session/"+manifestRoot.Canonical+"?"+q.Encode(), nil)
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)

			if w.Code != tc.wantStatus {
				t.Fatalf("expected status %d, got %d: %s", tc.wantStatus, w.Code, w.Body.String())
			}

			var payload jsonErrorResponse
			if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
				t.Fatalf("expected json error response: %v", err)
			}
			if payload.Error != "failed to resolve provider for retrieval session" {
				t.Fatalf("unexpected error message: %q", payload.Error)
			}
			if payload.Hint == "" {
				t.Fatalf("expected non-empty hint")
			}
		})
	}
}

package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/blake2s"
	"polystorechain/x/crypto_ffi"
	niltypes "polystorechain/x/polystorechain/types"
)

func TestGatewayFetch_ByPath(t *testing.T) {
	requireOnchainSessionForTest(t, false)
	useTempUploadDir(t)
	t.Setenv("POLYSTORE_PROVIDER_ADDRESS", "nil1testprovider")
	owner := testDealOwner(t)

	if err := crypto_ffi.Init(trustedSetup); err != nil {
		t.Fatalf("crypto_ffi.Init failed: %v", err)
	}

	// Build a minimal, internally consistent slab:
	// - mdu_0.bin: file table
	// - mdu_1.bin: witness commitments for user MDU ordinal 0
	// - mdu_2.bin: user data MDU containing the file bytes
	// - manifest.bin: 128 KiB manifest blob
	// - manifest_root: computed from roots so Hop1 proof generation succeeds
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
	os.MkdirAll(dealDir, 0755)
	defer os.RemoveAll(dealDir)

	// Create MDU #0
	b := crypto_ffi.NewMdu0Builder(1)
	defer b.Free()

	// Add File Record
	b.AppendFile("video.mp4", uint64(len(fileContent)), 0)

	mdu0Data, _ := b.Bytes()
	os.WriteFile(filepath.Join(dealDir, "mdu_0.bin"), mdu0Data, 0644)

	// manifest.bin must exist for proof generation.
	os.WriteFile(filepath.Join(dealDir, "manifest.bin"), manifestBlob, 0644)

	// Witness MDU #1 holds blob commitments for user ordinal 0 (first 3072 bytes).
	os.WriteFile(filepath.Join(dealDir, "mdu_1.bin"), encodeRawToMdu(witnessPlain), 0644)

	// User data MDU #2 holds the file bytes.
	os.WriteFile(filepath.Join(dealDir, "mdu_2.bin"), encodeRawToMdu(fileContent), 0644)

	// Mock LCD for owner check
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

	// Request
	reqRangeStart := uint64(0)
	reqRangeLen := uint64(len(fileContent))
	nonce := uint64(1)
	expiresAt := uint64(time.Now().Unix()) + 120
	reqSig := signRetrievalRequest(t, dealID, "video.mp4", reqRangeStart, reqRangeLen, nonce, expiresAt)
	u := fmt.Sprintf("/gateway/fetch/%s?deal_id=%d&owner=%s&file_path=video.mp4", manifestRoot.Canonical, dealID, owner)
	req := httptest.NewRequest("GET", u, nil)
	req.Header.Set("X-PolyStore-Req-Sig", reqSig)
	req.Header.Set("X-PolyStore-Req-Nonce", fmt.Sprintf("%d", nonce))
	req.Header.Set("X-PolyStore-Req-Expires-At", fmt.Sprintf("%d", expiresAt))
	req.Header.Set("X-PolyStore-Req-Range-Start", fmt.Sprintf("%d", reqRangeStart))
	req.Header.Set("X-PolyStore-Req-Range-Len", fmt.Sprintf("%d", reqRangeLen))
	req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", reqRangeStart, reqRangeStart+reqRangeLen-1))
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusPartialContent {
		t.Fatalf("Fetch failed: %d, body: %s", w.Code, w.Body.String())
	}

	if w.Body.String() != string(fileContent) {
		t.Errorf("Content mismatch. Want %q, got %q", string(fileContent), w.Body.String())
	}
}

func TestGatewayFetch_DeputyUsesDealProviderWhenLocalProviderMissing(t *testing.T) {
	requireOnchainSessionForTest(t, false)
	useTempUploadDir(t)
	resetProviderAddressCacheForTest(t)
	t.Setenv("POLYSTORE_PROVIDER_ADDRESS", "")
	t.Setenv("POLYSTORE_PROVIDER_KEY", "")
	oldRequireSig := requireRetrievalReqSig
	requireRetrievalReqSig = false
	t.Cleanup(func() { requireRetrievalReqSig = oldRequireSig })
	owner := testDealOwner(t)

	if err := crypto_ffi.Init(trustedSetup); err != nil {
		t.Fatalf("crypto_ffi.Init failed: %v", err)
	}

	fileContent := []byte("Hello World from Deputy")
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
	os.MkdirAll(dealDir, 0o755)
	defer os.RemoveAll(dealDir)

	b := crypto_ffi.NewMdu0Builder(1)
	defer b.Free()
	b.AppendFile("video.mp4", uint64(len(fileContent)), 0)

	mdu0Data, _ := b.Bytes()
	os.WriteFile(filepath.Join(dealDir, "mdu_0.bin"), mdu0Data, 0o644)
	os.WriteFile(filepath.Join(dealDir, "manifest.bin"), manifestBlob, 0o644)
	os.WriteFile(filepath.Join(dealDir, "mdu_1.bin"), encodeRawToMdu(witnessPlain), 0o644)
	os.WriteFile(filepath.Join(dealDir, "mdu_2.bin"), encodeRawToMdu(fileContent), 0o644)

	const (
		dealID           = 2
		metadataProvider = "nil1metadataproviderfetch"
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/polystorechain/polystorechain/v1/deals/2" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"deal": map[string]any{
				"id":           "2",
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

	dealProviderCache.Delete(uint64(dealID))
	dealProvidersCache.Delete(uint64(dealID))
	dealMode2SlotsCache.Delete(uint64(dealID))
	dealHintCache.Delete(uint64(dealID))

	r := testRouter()

	reqRangeStart := uint64(0)
	reqRangeLen := uint64(len(fileContent))
	nonce := uint64(2)
	expiresAt := uint64(time.Now().Unix()) + 120
	reqSig := signRetrievalRequest(t, dealID, "video.mp4", reqRangeStart, reqRangeLen, nonce, expiresAt)
	u := fmt.Sprintf(
		"/gateway/fetch/%s?deal_id=%d&owner=%s&file_path=video.mp4&deputy=1",
		manifestRoot.Canonical,
		dealID,
		owner,
	)
	req := httptest.NewRequest(http.MethodGet, u, nil)
	req.Header.Set("X-PolyStore-Req-Sig", reqSig)
	req.Header.Set("X-PolyStore-Req-Nonce", fmt.Sprintf("%d", nonce))
	req.Header.Set("X-PolyStore-Req-Expires-At", fmt.Sprintf("%d", expiresAt))
	req.Header.Set("X-PolyStore-Req-Range-Start", fmt.Sprintf("%d", reqRangeStart))
	req.Header.Set("X-PolyStore-Req-Range-Len", fmt.Sprintf("%d", reqRangeLen))
	req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", reqRangeStart, reqRangeStart+reqRangeLen-1))
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusPartialContent {
		t.Fatalf("Fetch failed: %d, body: %s", w.Code, w.Body.String())
	}
	if got := strings.TrimSpace(w.Header().Get("X-PolyStore-Provider")); got != metadataProvider {
		t.Fatalf("expected X-PolyStore-Provider=%q, got %q", metadataProvider, got)
	}
	if got := strings.TrimSpace(w.Header().Get("X-PolyStore-Deputy")); got != "1" {
		t.Fatalf("expected X-PolyStore-Deputy=1, got %q", got)
	}
	if w.Body.String() != string(fileContent) {
		t.Errorf("Content mismatch. Want %q, got %q", string(fileContent), w.Body.String())
	}
}

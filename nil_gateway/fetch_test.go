package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/crypto/blake2s"
	"nil_gateway/pkg/builder"
	"nil_gateway/pkg/layout"
	"nilchain/x/crypto_ffi"
	niltypes "nilchain/x/nilchain/types"
)

func TestGatewayFetch_ByPath(t *testing.T) {
	useTempUploadDir(t)
	t.Setenv("NIL_PROVIDER_ADDRESS", "nil1testprovider")
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
	b, _ := builder.NewMdu0Builder(1)

	// Add File Record
	rec := layout.FileRecordV1{
		StartOffset:    0,
		LengthAndFlags: layout.PackLengthAndFlags(uint64(len(fileContent)), 0),
	}
	copy(rec.Path[:], "video.mp4")
	b.AppendFileRecord(rec)

	mdu0Data := b.Bytes()
	os.WriteFile(filepath.Join(dealDir, "mdu_0.bin"), mdu0Data, 0644)

	// manifest.bin must exist for proof generation.
	os.WriteFile(filepath.Join(dealDir, "manifest.bin"), manifestBlob, 0644)

	// Witness MDU #1 holds blob commitments for user ordinal 0 (first 3072 bytes).
	os.WriteFile(filepath.Join(dealDir, "mdu_1.bin"), encodeRawToMdu(witnessPlain), 0644)

	// User data MDU #2 holds the file bytes.
	os.WriteFile(filepath.Join(dealDir, "mdu_2.bin"), encodeRawToMdu(fileContent), 0644)

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
	reqSig := signRetrievalRequest(t, dealID, "video.mp4", 0, 0, nonce, expiresAt)
	u := fmt.Sprintf("/gateway/fetch/%s?deal_id=%d&owner=%s&file_path=video.mp4", manifestRoot.Canonical, dealID, owner)
	req := httptest.NewRequest("GET", u, nil)
	req.Header.Set("X-Nil-Req-Sig", reqSig)
	req.Header.Set("X-Nil-Req-Nonce", fmt.Sprintf("%d", nonce))
	req.Header.Set("X-Nil-Req-Expires-At", fmt.Sprintf("%d", expiresAt))
	req.Header.Set("X-Nil-Req-Range-Start", "0")
	req.Header.Set("X-Nil-Req-Range-Len", "0")
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Fetch failed: %d, body: %s", w.Code, w.Body.String())
	}

	if w.Body.String() != string(fileContent) {
		t.Errorf("Content mismatch. Want %q, got %q", string(fileContent), w.Body.String())
	}
}

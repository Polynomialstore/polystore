package main

import (
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"nil_s3/pkg/builder"
	"nil_s3/pkg/layout"
)

func TestGatewayManifestInfo_Basic(t *testing.T) {
	useTempUploadDir(t)
	mockExecCommandContext(t)

	cid := mustTestManifestRoot(t, "manifest-info-basic")
	dealDir := filepath.Join(uploadDir, cid.Key)
	if err := os.MkdirAll(dealDir, 0o755); err != nil {
		t.Fatalf("mkdir deal dir: %v", err)
	}

	if err := os.WriteFile(filepath.Join(dealDir, "manifest.bin"), []byte{0x01, 0x02}, 0o644); err != nil {
		t.Fatalf("write manifest.bin: %v", err)
	}

	b, err := builder.NewMdu0Builder(256)
	if err != nil {
		t.Fatalf("NewMdu0Builder: %v", err)
	}

	var root1, root2 [32]byte
	for i := 0; i < 32; i++ {
		root1[i] = 0x11
		root2[i] = 0x22
	}
	if err := b.SetRoot(0, root1); err != nil {
		t.Fatalf("SetRoot 0: %v", err)
	}
	if err := b.SetRoot(1, root2); err != nil {
		t.Fatalf("SetRoot 1: %v", err)
	}

	rec := layout.FileRecordV1{
		StartOffset:    0,
		LengthAndFlags: layout.PackLengthAndFlags(100, 0),
	}
	copy(rec.Path[:], []byte("file.txt"))
	if err := b.AppendFileRecord(rec); err != nil {
		t.Fatalf("AppendFileRecord: %v", err)
	}

	if err := os.WriteFile(filepath.Join(dealDir, "mdu_0.bin"), b.Bytes(), 0o644); err != nil {
		t.Fatalf("write mdu_0.bin: %v", err)
	}

	zeros := make([]byte, builder.MduSize)
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
	// The mocked nil_cli helper returns root_hex=0x1111 for raw sharding.
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
	mockExecCommandContext(t)

	cid := mustTestManifestRoot(t, "mdu-kzg-basic")
	dealDir := filepath.Join(uploadDir, cid.Key)
	if err := os.MkdirAll(dealDir, 0o755); err != nil {
		t.Fatalf("mkdir deal dir: %v", err)
	}

	if err := os.WriteFile(filepath.Join(dealDir, "manifest.bin"), []byte{0x01}, 0o644); err != nil {
		t.Fatalf("write manifest.bin: %v", err)
	}

	b, err := builder.NewMdu0Builder(256)
	if err != nil {
		t.Fatalf("NewMdu0Builder: %v", err)
	}
	rec := layout.FileRecordV1{
		StartOffset:    0,
		LengthAndFlags: layout.PackLengthAndFlags(100, 0),
	}
	copy(rec.Path[:], []byte("file.txt"))
	if err := b.AppendFileRecord(rec); err != nil {
		t.Fatalf("AppendFileRecord: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_0.bin"), b.Bytes(), 0o644); err != nil {
		t.Fatalf("write mdu_0.bin: %v", err)
	}

	zeros := make([]byte, builder.MduSize)
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

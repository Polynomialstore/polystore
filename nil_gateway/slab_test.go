package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"nilchain/x/crypto_ffi"
)

func TestGatewaySlab_Basic(t *testing.T) {
	useTempUploadDir(t)

	manifestRoot := mustTestManifestRoot(t, "slab-basic")
	dealDir := filepath.Join(uploadDir, manifestRoot.Key)
	if err := os.MkdirAll(dealDir, 0o755); err != nil {
		t.Fatalf("mkdir deal dir: %v", err)
	}
	defer os.RemoveAll(dealDir)

	b := crypto_ffi.NewMdu0Builder(1)
	defer b.Free()

	if err := b.AppendFile("a.txt", 5, 0); err != nil {
		t.Fatalf("AppendFileRecord: %v", err)
	}

	mdu0Bytes, _ := b.Bytes()
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_0.bin"), mdu0Bytes, 0o644); err != nil {
		t.Fatalf("write mdu_0.bin: %v", err)
	}

	// Create contiguous MDU files so the slab layout can be inferred:
	// 0 = MDU #0, 1-2 = witness, 3 = first user data MDU.
	for _, idx := range []int{1, 2, 3} {
		if err := os.WriteFile(filepath.Join(dealDir, fmt.Sprintf("mdu_%d.bin", idx)), []byte{0}, 0o644); err != nil {
			t.Fatalf("write mdu_%d.bin: %v", idx, err)
		}
	}

	r := testRouter()
	req := httptest.NewRequest("GET", fmt.Sprintf("/gateway/slab/%s", manifestRoot.Canonical), nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var payload slabLayoutResponse
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.ManifestRoot != manifestRoot.Canonical {
		t.Fatalf("unexpected manifest_root: %q", payload.ManifestRoot)
	}
	if payload.TotalMdus != 4 {
		t.Fatalf("unexpected total_mdus: %d", payload.TotalMdus)
	}
	if payload.WitnessMdus != 2 {
		t.Fatalf("unexpected witness_mdus: %d", payload.WitnessMdus)
	}
	if payload.UserMdus != 1 {
		t.Fatalf("unexpected user_mdus: %d", payload.UserMdus)
	}
	if payload.FileRecords != 1 || payload.FileCount != 1 {
		t.Fatalf("unexpected file counters: records=%d files=%d", payload.FileRecords, payload.FileCount)
	}
	if payload.TotalSizeBytes != 5 {
		t.Fatalf("unexpected total_size_bytes: %d", payload.TotalSizeBytes)
	}
	if len(payload.Segments) != 3 {
		t.Fatalf("expected 3 segments, got %d", len(payload.Segments))
	}
	if payload.Segments[0].Kind != "mdu0" || payload.Segments[0].StartIndex != 0 || payload.Segments[0].Count != 1 {
		t.Fatalf("unexpected mdu0 segment: %+v", payload.Segments[0])
	}
	if payload.Segments[1].Kind != "witness" || payload.Segments[1].StartIndex != 1 || payload.Segments[1].Count != 2 {
		t.Fatalf("unexpected witness segment: %+v", payload.Segments[1])
	}
	if payload.Segments[2].Kind != "user" || payload.Segments[2].StartIndex != 3 || payload.Segments[2].Count != 1 {
		t.Fatalf("unexpected user segment: %+v", payload.Segments[2])
	}
}

func TestGatewaySlab_WithOwnerCheck(t *testing.T) {
	useTempUploadDir(t)

	manifestRoot := mustTestManifestRoot(t, "slab-authz")
	dealDir := filepath.Join(uploadDir, manifestRoot.Key)
	if err := os.MkdirAll(dealDir, 0o755); err != nil {
		t.Fatalf("mkdir deal dir: %v", err)
	}
	defer os.RemoveAll(dealDir)

	b := crypto_ffi.NewMdu0Builder(1)
	defer b.Free()
	mdu0Bytes, _ := b.Bytes()
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_0.bin"), mdu0Bytes, 0o644); err != nil {
		t.Fatalf("write mdu_0.bin: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_1.bin"), []byte{0}, 0o644); err != nil {
		t.Fatalf("write mdu_1.bin: %v", err)
	}

	srv := dynamicMockDealServer(map[uint64]struct {
		Owner string
		CID   string
	}{
		1: {Owner: "nil1owner", CID: manifestRoot.Canonical},
	})
	defer srv.Close()
	oldLCD := lcdBase
	lcdBase = srv.URL
	defer func() { lcdBase = oldLCD }()

	q := url.Values{}
	q.Set("deal_id", "1")
	q.Set("owner", "nil1owner")

	r := testRouter()
	req := httptest.NewRequest("GET", fmt.Sprintf("/gateway/slab/%s?%s", manifestRoot.Canonical, q.Encode()), nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

func TestGatewaySlab_Mode2ShardsOnly(t *testing.T) {
	useTempUploadDir(t)

	manifestRoot := mustTestManifestRoot(t, "slab-mode2-shards")
	dealID := uint64(42)
	dealDir := dealScopedDir(dealID, manifestRoot)
	if err := os.MkdirAll(dealDir, 0o755); err != nil {
		t.Fatalf("mkdir deal dir: %v", err)
	}
	defer os.RemoveAll(filepath.Join(uploadDir, "deals"))

	userMdus := uint64(2)
	b := crypto_ffi.NewMdu0Builder(userMdus)
	defer b.Free()

	if err := b.AppendFile("big.bin", RawMduCapacity+1, 0); err != nil {
		t.Fatalf("AppendFile: %v", err)
	}

	// Mode 2 stores user MDUs as RS shards (mdu_<idx>_slot_<slot>.bin), but still populates
	// the root table with witness + user roots.
	// totalRoots = witness(1) + user(2) = 3
	for i := uint64(0); i < 3; i++ {
		root := make([]byte, 32)
		for j := range root {
			root[j] = byte(i + 1)
		}
		if err := b.SetRoot(i, root); err != nil {
			t.Fatalf("SetRoot(%d): %v", i, err)
		}
	}

	mdu0Bytes, _ := b.Bytes()
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_0.bin"), mdu0Bytes, 0o644); err != nil {
		t.Fatalf("write mdu_0.bin: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dealDir, "mdu_1.bin"), []byte{0}, 0o644); err != nil {
		t.Fatalf("write mdu_1.bin: %v", err)
	}

	// Slot shards for user slab indices 2..3.
	for slabIdx := uint64(2); slabIdx < 2+userMdus; slabIdx++ {
		if err := os.WriteFile(filepath.Join(dealDir, fmt.Sprintf("mdu_%d_slot_0.bin", slabIdx)), []byte{0}, 0o644); err != nil {
			t.Fatalf("write shard: %v", err)
		}
	}

	srv := dynamicMockDealServer(map[uint64]struct {
		Owner string
		CID   string
	}{
		dealID: {Owner: "nil1owner", CID: manifestRoot.Canonical},
	})
	defer srv.Close()
	oldLCD := lcdBase
	lcdBase = srv.URL
	defer func() { lcdBase = oldLCD }()

	q := url.Values{}
	q.Set("deal_id", fmt.Sprintf("%d", dealID))
	q.Set("owner", "nil1owner")

	r := testRouter()
	req := httptest.NewRequest("GET", fmt.Sprintf("/gateway/slab/%s?%s", manifestRoot.Canonical, q.Encode()), nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var payload slabLayoutResponse
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.UserMdus != userMdus {
		t.Fatalf("unexpected user_mdus: %d", payload.UserMdus)
	}
	if payload.WitnessMdus != 1 {
		t.Fatalf("unexpected witness_mdus: %d", payload.WitnessMdus)
	}
	if payload.TotalMdus != 1+payload.WitnessMdus+payload.UserMdus {
		t.Fatalf("unexpected total_mdus: %d", payload.TotalMdus)
	}
}

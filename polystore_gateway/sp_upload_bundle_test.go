package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"polystorechain/x/polystorechain/types"
)

func TestSpUploadBundle_AcceptsSparseArtifacts(t *testing.T) {
	useTempUploadDir(t)
	resetNilfsCASStatusCountersForTest()
	resetNilfsUploadRootPreflightCacheForTest()

	manifestRoot := mustTestManifestRoot(t, "sp-upload-bundle")
	dealID := uint64(0)

	srv := dynamicMockDealServer(map[uint64]struct {
		Owner string
		CID   string
	}{
		dealID: {Owner: "nil1owner", CID: ""},
	})
	defer srv.Close()
	oldLCD := lcdBase
	lcdBase = srv.URL
	t.Cleanup(func() { lcdBase = oldLCD })

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)

	metaBytes, err := json.Marshal(spUploadBundleRequest{
		DealID:               ptrUint64(dealID),
		ManifestRoot:         manifestRoot.Canonical,
		PreviousManifestRoot: "",
		Artifacts: []spUploadBundleArtifact{
			{
				Part:     "mdu0",
				Kind:     spUploadBundleKindMDU,
				MduIndex: ptrUint64(0),
				FullSize: int64(types.MDU_SIZE),
				SendSize: 1024,
			},
			{
				Part:     "shard2",
				Kind:     spUploadBundleKindShard,
				MduIndex: ptrUint64(2),
				Slot:     ptrUint64(1),
				FullSize: 4096,
				SendSize: 512,
			},
			{
				Part:     "manifest",
				Kind:     spUploadBundleKindManifest,
				FullSize: int64(types.BLOB_SIZE),
				SendSize: 288,
			},
		},
	})
	if err != nil {
		t.Fatalf("marshal meta: %v", err)
	}

	metaPart, err := mw.CreateFormField("meta")
	if err != nil {
		t.Fatalf("create meta part: %v", err)
	}
	if _, err := metaPart.Write(metaBytes); err != nil {
		t.Fatalf("write meta part: %v", err)
	}

	mduBody := bytes.Repeat([]byte{0xA1}, 1024)
	mduPart, err := mw.CreateFormFile("mdu0", "mdu_0.bin")
	if err != nil {
		t.Fatalf("create mdu part: %v", err)
	}
	if _, err := mduPart.Write(mduBody); err != nil {
		t.Fatalf("write mdu part: %v", err)
	}

	shardBody := bytes.Repeat([]byte{0xB2}, 512)
	shardPart, err := mw.CreateFormFile("shard2", "mdu_2_slot_1.bin")
	if err != nil {
		t.Fatalf("create shard part: %v", err)
	}
	if _, err := shardPart.Write(shardBody); err != nil {
		t.Fatalf("write shard part: %v", err)
	}

	manifestBody := bytes.Repeat([]byte{0xC3}, 288)
	manifestPart, err := mw.CreateFormFile("manifest", "manifest.bin")
	if err != nil {
		t.Fatalf("create manifest part: %v", err)
	}
	if _, err := manifestPart.Write(manifestBody); err != nil {
		t.Fatalf("write manifest part: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/sp/upload_bundle", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Content-Length", strconv.Itoa(body.Len()))

	w := httptest.NewRecorder()
	testRouter().ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	rootDir := filepath.Join(uploadDir, "deals", "0", manifestRoot.Key)
	gotMdu, err := os.ReadFile(filepath.Join(rootDir, "mdu_0.bin"))
	if err != nil {
		t.Fatalf("read mdu_0.bin: %v", err)
	}
	if len(gotMdu) != types.MDU_SIZE {
		t.Fatalf("unexpected mdu size: got=%d want=%d", len(gotMdu), types.MDU_SIZE)
	}
	if !bytes.Equal(gotMdu[:len(mduBody)], mduBody) {
		t.Fatalf("stored mdu prefix mismatch")
	}

	gotShard, err := os.ReadFile(filepath.Join(rootDir, "mdu_2_slot_1.bin"))
	if err != nil {
		t.Fatalf("read shard: %v", err)
	}
	if len(gotShard) != 4096 {
		t.Fatalf("unexpected shard size: got=%d want=%d", len(gotShard), 4096)
	}
	if !bytes.Equal(gotShard[:len(shardBody)], shardBody) {
		t.Fatalf("stored shard prefix mismatch")
	}

	gotManifest, err := os.ReadFile(filepath.Join(rootDir, "manifest.bin"))
	if err != nil {
		t.Fatalf("read manifest: %v", err)
	}
	if len(gotManifest) != types.BLOB_SIZE {
		t.Fatalf("unexpected manifest size: got=%d want=%d", len(gotManifest), types.BLOB_SIZE)
	}
	if !bytes.Equal(gotManifest[:len(manifestBody)], manifestBody) {
		t.Fatalf("stored manifest prefix mismatch")
	}
}

func TestSpUploadBundle_AcceptsBinaryBundleV2(t *testing.T) {
	useTempUploadDir(t)
	resetNilfsCASStatusCountersForTest()
	resetNilfsUploadRootPreflightCacheForTest()

	manifestRoot := mustTestManifestRoot(t, "sp-upload-bundle-v2")
	dealID := uint64(2)

	srv := dynamicMockDealServer(map[uint64]struct {
		Owner string
		CID   string
	}{
		dealID: {Owner: "nil1owner", CID: ""},
	})
	defer srv.Close()
	oldLCD := lcdBase
	lcdBase = srv.URL
	t.Cleanup(func() { lcdBase = oldLCD })

	reqMeta := spUploadBundleRequest{
		DealID:               ptrUint64(dealID),
		ManifestRoot:         manifestRoot.Canonical,
		PreviousManifestRoot: "",
		Artifacts: []spUploadBundleArtifact{
			{
				Part:     "artifact_00",
				Kind:     spUploadBundleKindMDU,
				MduIndex: ptrUint64(0),
				FullSize: int64(types.MDU_SIZE),
				SendSize: 1024,
			},
			{
				Part:     "artifact_01",
				Kind:     spUploadBundleKindShard,
				MduIndex: ptrUint64(2),
				Slot:     ptrUint64(1),
				FullSize: 4096,
				SendSize: 512,
			},
			{
				Part:     "artifact_02",
				Kind:     spUploadBundleKindManifest,
				FullSize: int64(types.BLOB_SIZE),
				SendSize: 288,
			},
		},
	}
	metaBytes, err := json.Marshal(reqMeta)
	if err != nil {
		t.Fatalf("marshal meta: %v", err)
	}

	var body bytes.Buffer
	var header [8]byte
	copy(header[:4], []byte(spUploadBundleV2Magic))
	binary.LittleEndian.PutUint32(header[4:], uint32(len(metaBytes)))
	body.Write(header[:])
	body.Write(metaBytes)
	mduBody := bytes.Repeat([]byte{0xA1}, 1024)
	shardBody := bytes.Repeat([]byte{0xB2}, 512)
	manifestBody := bytes.Repeat([]byte{0xC3}, 288)
	body.Write(mduBody)
	body.Write(shardBody)
	body.Write(manifestBody)

	req := httptest.NewRequest(http.MethodPost, "/sp/upload_bundle", &body)
	req.Header.Set("Content-Type", spUploadBundleV2MediaType)
	req.Header.Set("Content-Length", strconv.Itoa(body.Len()))

	w := httptest.NewRecorder()
	testRouter().ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	rootDir := filepath.Join(uploadDir, "deals", "2", manifestRoot.Key)
	gotMdu, err := os.ReadFile(filepath.Join(rootDir, "mdu_0.bin"))
	if err != nil {
		t.Fatalf("read mdu_0.bin: %v", err)
	}
	if len(gotMdu) != types.MDU_SIZE {
		t.Fatalf("unexpected mdu size: got=%d want=%d", len(gotMdu), types.MDU_SIZE)
	}
	if !bytes.Equal(gotMdu[:len(mduBody)], mduBody) {
		t.Fatalf("stored mdu prefix mismatch")
	}

	gotShard, err := os.ReadFile(filepath.Join(rootDir, "mdu_2_slot_1.bin"))
	if err != nil {
		t.Fatalf("read shard: %v", err)
	}
	if len(gotShard) != 4096 {
		t.Fatalf("unexpected shard size: got=%d want=%d", len(gotShard), 4096)
	}
	if !bytes.Equal(gotShard[:len(shardBody)], shardBody) {
		t.Fatalf("stored shard prefix mismatch")
	}

	gotManifest, err := os.ReadFile(filepath.Join(rootDir, "manifest.bin"))
	if err != nil {
		t.Fatalf("read manifest: %v", err)
	}
	if len(gotManifest) != types.BLOB_SIZE {
		t.Fatalf("unexpected manifest size: got=%d want=%d", len(gotManifest), types.BLOB_SIZE)
	}
	if !bytes.Equal(gotManifest[:len(manifestBody)], manifestBody) {
		t.Fatalf("stored manifest prefix mismatch")
	}
}

func ptrUint64(v uint64) *uint64 {
	return &v
}

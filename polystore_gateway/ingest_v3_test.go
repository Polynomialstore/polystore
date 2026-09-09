package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/gogoproto/jsonpb"
	"io"
	"math/rand"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"polystorechain/pkg/retrievalchallenge"
	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/types"
)

func TestMode2BuildArtifactsV3ProducesCanonicalIntegrityMetadata(t *testing.T) {
	useTempUploadDir(t)
	initCryptoForTest(t)
	payload := filepath.Join(t.TempDir(), "payload.bin")
	if err := os.WriteFile(payload, bytes.Repeat([]byte{0x5a}, RawMduCapacity+4097), 0o600); err != nil {
		t.Fatal(err)
	}

	result, dir, err := mode2BuildArtifactsWithOptions(t.Context(), payload, 0, "General:rs=8+4", "payload.bin", 0, mode2BuildOptions{fatVersion: 3})
	if err != nil {
		t.Fatal(err)
	}
	if result.userMdus != 2 || result.integrityLeaves != 192 {
		t.Fatalf("unexpected v3 geometry: users=%d leaves=%d", result.userMdus, result.integrityLeaves)
	}

	mdu0, err := os.ReadFile(filepath.Join(dir, "mdu_0.bin"))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := fatV3HeaderFromEncodedMDU0(mdu0)
	if err != nil {
		t.Fatal(err)
	}
	header, err := retrievalchallenge.ParseFATV3Header(raw[:])
	if err != nil {
		t.Fatal(err)
	}
	if header.RecordCount != 1 || header.LeafCount != 192 || header.IntegrityRoot != result.integrityRoot {
		t.Fatalf("unexpected FAT v3 header: %+v", header)
	}
	root, err := crypto_ffi.ComputeMduMerkleRoot(mdu0)
	if err != nil {
		t.Fatal(err)
	}
	if got := "0x" + hex.EncodeToString(root); got != result.manifestRoot.Canonical {
		t.Fatalf("MDU0 root mismatch: got %s want %s", got, result.manifestRoot.Canonical)
	}

	vector, err := os.ReadFile(filepath.Join(dir, integrityLeavesV3File))
	if err != nil {
		t.Fatal(err)
	}
	if len(vector) != 192*32 {
		t.Fatalf("integrity vector length=%d", len(vector))
	}
	for user := uint64(0); user < result.userMdus; user++ {
		slabIndex := uint64(1) + result.witnessMdus + user
		for slot := uint64(0); slot < 12; slot++ {
			shard, err := os.ReadFile(filepath.Join(dir, "mdu_"+strconv.FormatUint(slabIndex, 10)+"_slot_"+strconv.FormatUint(slot, 10)+".bin"))
			if err != nil {
				t.Fatal(err)
			}
			if len(shard) != 8*types.BLOB_SIZE {
				t.Fatalf("user %d slot %d shard length=%d", user, slot, len(shard))
			}
			for row := uint64(0); row < 8; row++ {
				leaf := slot*8 + row
				want, err := retrievalchallenge.IntegrityLeafV3(slabIndex, uint32(leaf), shard[row*types.BLOB_SIZE:(row+1)*types.BLOB_SIZE])
				if err != nil {
					t.Fatal(err)
				}
				position := user*retrievalchallenge.IntegrityLeavesPerUserMDU + leaf
				if !bytes.Equal(vector[position*32:(position+1)*32], want[:]) {
					t.Fatalf("integrity leaf mismatch at %d", position)
				}
			}
		}
	}
	if got, err := retrievalchallenge.IntegrityRootV3Reader(bytes.NewReader(vector), 192); err != nil || got != header.IntegrityRoot {
		t.Fatalf("integrity root mismatch: got=%x err=%v", got, err)
	}
}

func emptyUploadDealV3() *types.Deal {
	d := &types.Deal{EndBlock: 10000, RedundancyMode: 2, Mode2Profile: &types.StripeReplicaProfile{K: 8, M: 4}}
	for i := 0; i < 12; i++ {
		raw := make([]byte, 20)
		raw[19] = byte(i + 1)
		d.Mode2Slots = append(d.Mode2Slots, &types.DealSlot{Slot: uint32(i), Provider: sdk.AccAddress(raw).String(), Status: types.SlotStatus_SLOT_STATUS_ACTIVE})
	}
	d.Owner = d.Mode2Slots[0].Provider
	return d
}

func TestV3UploadRejectsInvalidAdmissionAndConcurrentVersionReuse(t *testing.T) {
	for _, mutate := range []func(*types.Deal){
		func(d *types.Deal) { d.CurrentGen = 1 },
		func(d *types.Deal) { d.ManifestRoot = make([]byte, 32) },
		func(d *types.Deal) { d.Mode2Profile.K = 4 },
		func(d *types.Deal) { d.Mode2Slots[0].Status = types.SlotStatus_SLOT_STATUS_REPAIRING },
		func(d *types.Deal) { d.Mode2Slots[0].PendingProvider = d.Owner },
		func(d *types.Deal) { d.Mode2Slots[1].Provider = d.Owner },
		func(d *types.Deal) { d.Mode2Slots[0].Slot = 1 },
	} {
		d := emptyUploadDealV3()
		mutate(d)
		if _, err := validateUploadDealV3(d, 5); err == nil {
			t.Fatal("accepted invalid admission")
		}
	}
	for _, query := range []string{"fat_version=", "fat_version=03", "fat_version=4", "fat_version=2&fat_version=3", "fat_version=3"} {
		w := httptest.NewRecorder()
		GatewayUpload(w, httptest.NewRequest(http.MethodPost, "/gateway/upload?"+query, nil))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("query %q: status=%d", query, w.Code)
		}
	}
	const id = "v3-version-race"
	uploadJobsMu.Lock()
	delete(uploadJobs, uploadJobKey{0, id})
	uploadJobsMu.Unlock()
	t.Cleanup(func() { uploadJobsMu.Lock(); delete(uploadJobs, uploadJobKey{0, id}); uploadJobsMu.Unlock() })
	var wg sync.WaitGroup
	var winners atomic.Int32
	start := make(chan struct{})
	for _, version := range []uint16{2, 3} {
		wg.Add(1)
		go func(v uint16) {
			defer wg.Done()
			<-start
			if _, _, err := claimUploadJob(0, id, v); err == nil {
				winners.Add(1)
			}
		}(version)
	}
	close(start)
	wg.Wait()
	if winners.Load() != 1 {
		t.Fatalf("version claims=%d", winners.Load())
	}
}

func TestGatewayUploadV3UsesRealBundlesAndCandidateOnlyResponse(t *testing.T) {
	useTempUploadDir(t)
	initCryptoForTest(t)
	oldPolyce := polyceEnabled
	polyceEnabled = false
	t.Cleanup(func() { polyceEnabled = oldPolyce })
	t.Setenv("POLYSTORE_FAKE_INGEST", "0")
	t.Setenv("POLYSTORE_FAST_INGEST", "0")
	clearDealMetaCache()
	resetPolyfsUploadRootPreflightCacheForTest()
	t.Cleanup(clearDealMetaCache)
	t.Cleanup(resetPolyfsUploadRootPreflightCacheForTest)
	d := emptyUploadDealV3()
	body, err := (&jsonpb.Marshaler{OrigName: true}).MarshalToString(&types.QueryGetDealResponse{Deal: d})
	if err != nil {
		t.Fatal(err)
	}
	lcd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(committedHeightHeader, "5")
		_, _ = io.WriteString(w, body)
	}))
	defer lcd.Close()
	oldLCD := lcdBase
	lcdBase = lcd.URL
	t.Cleanup(func() { lcdBase = oldLCD })
	var fail atomic.Bool
	var mu sync.Mutex
	seen := make(map[string]bool)
	sp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		provider := strings.Split(strings.TrimPrefix(r.URL.Path, "/"), "/")[0]
		if fail.Load() && provider == "11" {
			http.Error(w, "unsupported", http.StatusNotFound)
			return
		}
		if !strings.HasSuffix(r.URL.Path, "/sp/upload_bundle") {
			http.Error(w, "unexpected fallback", http.StatusBadRequest)
			return
		}
		rec := httptest.NewRecorder()
		SpUploadBundle(rec, r)
		if rec.Code == http.StatusOK {
			mu.Lock()
			seen[provider] = true
			mu.Unlock()
		}
		w.WriteHeader(rec.Code)
		_, _ = w.Write(rec.Body.Bytes())
	}))
	defer sp.Close()
	for i, slot := range d.Mode2Slots {
		providerBaseCache.Store(slot.Provider, &providerBaseCacheEntry{baseURL: sp.URL + "/" + strconv.Itoa(i), expires: time.Now().Add(time.Minute)})
		address := slot.Provider
		t.Cleanup(func() { providerBaseCache.Delete(address) })
	}
	request := func(query string) *httptest.ResponseRecorder {
		var buf bytes.Buffer
		mw := multipart.NewWriter(&buf)
		part, err := mw.CreateFormFile("file", "payload.bin")
		if err != nil {
			t.Fatal(err)
		}
		_, _ = part.Write(bytes.Repeat([]byte{0x5a}, 1024))
		_ = mw.Close()
		r := httptest.NewRequest(http.MethodPost, "/gateway/upload?deal_id=0&fat_version=3"+query, &buf)
		r.Header.Set("Content-Type", mw.FormDataContentType())
		w := httptest.NewRecorder()
		GatewayUpload(w, r)
		return w
	}
	w := request("")
	if w.Code != http.StatusOK {
		t.Fatalf("upload status=%d: %s", w.Code, w.Body.String())
	}
	var result struct {
		Candidate *generationCandidateV3 `json:"generation_candidate"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || result.Candidate == nil {
		t.Fatalf("invalid result: %s (%v)", w.Body.String(), err)
	}
	if strings.Contains(w.Body.String(), `"manifest_root"`) || strings.Contains(w.Body.String(), `"cid"`) {
		t.Fatal("legacy commit shape exposed")
	}
	mu.Lock()
	count := len(seen)
	mu.Unlock()
	if count != 12 {
		t.Fatalf("successful providers=%d", count)
	}
	c := result.Candidate
	if c.DealID != 0 || c.ExpectedCurrentGeneration != d.CurrentGen || c.SizeBytes != 1024 || c.IntegrityLeafCount != 96 || c.RequiredAcceptances != 12 || c.CommitAction != "propose-deal-generation-v3" {
		t.Fatalf("wrong candidate: %+v", c)
	}
	if err := rejectLegacyV3Commit(0, c.PolyfsRoot); err == nil {
		t.Fatal("legacy relay accepted v3 root")
	}
	// Asynchronous status and replay must retain the same safe proposal shape.
	job, _, err := claimUploadJob(0, "v3-cached-candidate", 3)
	if err != nil {
		t.Fatal(err)
	}
	job.setResult(uploadJobResult{GenerationCandidate: c})
	t.Cleanup(func() {
		uploadJobsMu.Lock()
		delete(uploadJobs, uploadJobKey{0, "v3-cached-candidate"})
		uploadJobsMu.Unlock()
	})
	encoded, err := json.Marshal(job.snapshot())
	if err != nil || strings.Contains(string(encoded), `"manifest_root"`) || !strings.Contains(string(encoded), `"generation_candidate"`) {
		t.Fatalf("bad status: %s %v", encoded, err)
	}
	w = request("&upload_id=v3-cached-candidate")
	if w.Code != http.StatusOK || strings.Contains(w.Body.String(), `"manifest_root"`) || !strings.Contains(w.Body.String(), `"generation_candidate"`) {
		t.Fatalf("bad replay: %d %s", w.Code, w.Body.String())
	}
	fail.Store(true)
	w = request("")
	if w.Code == http.StatusOK || strings.Contains(w.Body.String(), `"generation_candidate"`) {
		t.Fatalf("partial fanout returned candidate: %d %s", w.Code, w.Body.String())
	}
}

func BenchmarkMode2BuildArtifactsFATVersion(b *testing.B) {
	if err := crypto_ffi.Init(trustedSetup); err != nil {
		b.Fatal(err)
	}
	old := uploadDir
	uploadDir = b.TempDir()
	b.Cleanup(func() { uploadDir = old })
	data := make([]byte, 16<<20)
	_, _ = rand.New(rand.NewSource(291)).Read(data)
	path := filepath.Join(b.TempDir(), "dense.bin")
	if err := os.WriteFile(path, data, 0600); err != nil {
		b.Fatal(err)
	}
	for _, version := range []uint16{2, 3} {
		b.Run(strconv.Itoa(int(version)), func(b *testing.B) {
			b.SetBytes(int64(len(data)))
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				_, dir, err := mode2BuildArtifactsWithOptions(b.Context(), path, uint64(i), "General:rs=8+4", "dense.bin", 0, mode2BuildOptions{fatVersion: version})
				if err != nil {
					b.Fatal(err)
				}
				b.StopTimer()
				if err := os.RemoveAll(dir); err != nil {
					b.Fatal(err)
				}
				b.StartTimer()
			}
		})
	}
}

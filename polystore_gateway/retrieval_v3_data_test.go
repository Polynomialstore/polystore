package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cosmos/gogoproto/jsonpb"
	"github.com/gorilla/mux"
	"polystorechain/pkg/retrievalchallenge"
	"polystorechain/x/polystorechain/types"
)

type retrievalV3DeadlineTransport func(*http.Request) (*http.Response, error)

func (f retrievalV3DeadlineTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func responseFromFrozenV3(f *frozenRetrievalSessionV3) types.QueryGetRetrievalSessionV3Response {
	anchor := make([]byte, 32)
	anchor[0] = 42
	return types.QueryGetRetrievalSessionV3Response{Session: f.Session, AnchorSeed: anchor}
}

func initRetrievalDataTestDB(t *testing.T) {
	t.Helper()
	previous := sessionDB
	sessionDB = nil
	if err := initSessionDB(filepath.Join(t.TempDir(), "sessions.db")); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = closeSessionDB(); sessionDB = previous })
}

func decodeRetrievalDataResponseV3(t *testing.T, response *httptest.ResponseRecorder) (retrievalDataMetadataV3, []byte) {
	t.Helper()
	media, params, err := mime.ParseMediaType(response.Header().Get("Content-Type"))
	if err != nil || media != "multipart/form-data" || params["version"] != "3" {
		t.Fatalf("unexpected v3 content type %q: %v", response.Header().Get("Content-Type"), err)
	}
	reader := multipart.NewReader(bytes.NewReader(response.Body.Bytes()), params["boundary"])
	part, err := reader.NextPart()
	if err != nil || part.FormName() != "metadata" {
		t.Fatalf("missing metadata part: %v", err)
	}
	var metadata retrievalDataMetadataV3
	if err := json.NewDecoder(part).Decode(&metadata); err != nil {
		t.Fatal(err)
	}
	part, err = reader.NextPart()
	if err != nil || part.FormName() != "bytes" {
		t.Fatalf("missing bytes part: %v", err)
	}
	payload, err := io.ReadAll(part)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := reader.NextPart(); err != io.EOF {
		t.Fatalf("unexpected trailing multipart data: %v", err)
	}
	return metadata, payload
}

func TestGatewayMduV3ServesOnlyVerifiedRequestedBytes(t *testing.T) {
	// Population 133 leaves exactly one data coordinate outside the 132 sampled
	// proof ordinals. Deliver that coordinate's slot chunk and then corrupt that
	// exact stored blob to prove the data path authenticates bytes independently.
	size := uint64(132*retrievalchallenge.DataBlobPayloadBytes + 1)
	frozen, key, dir := buildProviderV3ArtifactFixtureSize(t, size)
	response := responseFromFrozenV3(frozen)
	sampled := make(map[uint64]struct{}, len(frozen.Challenges))
	for _, challenge := range frozen.Challenges {
		sampled[challenge.T] = struct{}{}
	}
	var target uint64
	found := false
	for candidate := frozen.Plan.First; candidate <= frozen.Plan.Last; candidate++ {
		if _, ok := sampled[candidate]; !ok {
			target, found = candidate, true
			break
		}
	}
	if !found {
		t.Fatal("fixture has no unsampled data coordinate")
	}
	mdu, leaf, slot, err := retrievalchallenge.SystematicCoordinateV3(target, key.Metadata, key.Users)
	if err != nil {
		t.Fatal(err)
	}
	chunk, err := frozenRetrievalDataChunkV3(frozen, ManifestRoot{Bytes: key.Root}, mdu, key.Deal, frozen.Session.Owner, slot)
	if err != nil {
		t.Fatal(err)
	}
	signer := chunk.payee
	setupMockCombinedOutput(t, func(_ context.Context, _ string, args ...string) ([]byte, error) {
		if len(args) >= 2 && args[0] == "keys" && args[1] == "show" {
			return []byte(signer), nil
		}
		return nil, fmt.Errorf("unexpected command")
	})
	t.Setenv("POLYSTORE_PROVIDER_ADDRESS", signer)
	initRetrievalDataTestDB(t)
	lcd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/retrieval-sessions-v3/"):
			w.Header().Set(committedHeightHeader, strconv.FormatUint(frozen.Height, 10))
			if err := (&jsonpb.Marshaler{OrigName: true}).Marshal(w, &response); err != nil {
				t.Error(err)
			}
		case strings.Contains(r.URL.Path, "/retrieval-sessions/"):
			http.NotFound(w, r)
		default:
			t.Errorf("unexpected LCD query %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer lcd.Close()
	oldLCD := lcdBase
	lcdBase = lcd.URL
	defer func() { lcdBase = oldLCD }()
	root := "0x" + hex.EncodeToString(key.Root[:])
	session := "0x" + hex.EncodeToString(frozen.Session.SessionId)
	invoke := func() *httptest.ResponseRecorder {
		q := url.Values{"deal_id": {strconv.FormatUint(key.Deal, 10)}, "owner": {frozen.Session.Owner}}
		r := httptest.NewRequest(http.MethodGet, "/sp/retrieval/mdu/"+root+"/"+strconv.FormatUint(mdu, 10)+"?"+q.Encode(), nil)
		r = mux.SetURLVars(r, map[string]string{"cid": root, "index": strconv.FormatUint(mdu, 10)})
		r.Header.Set("X-PolyStore-Session-Id", session)
		r.Header.Set("Accept", "multipart/form-data; version=3")
		r.Header.Set("X-PolyStore-Slot", strconv.FormatUint(uint64(slot), 10))
		w := httptest.NewRecorder()
		GatewayMdu(w, r)
		return w
	}
	first := invoke()
	if first.Code != http.StatusOK {
		t.Fatalf("v3 data delivery failed: %d %s", first.Code, first.Body.String())
	}
	metadata, payload := decodeRetrievalDataResponseV3(t, first)
	if metadata.Version != 3 || metadata.IntegrityRoot != "0x"+hex.EncodeToString(key.Integrity[:]) || len(metadata.Entries) != len(chunk.t) || len(payload) != len(chunk.t)*types.BLOB_SIZE || len(payload) > 1<<20 {
		t.Fatalf("unexpected bounded v3 response: metadata=%+v bytes=%d", metadata, len(payload))
	}
	if metadata.SessionID != session || metadata.ContextHash != "0x"+hex.EncodeToString(frozen.Hash[:]) || metadata.PolyFSRoot != root || metadata.Slot != slot || metadata.MDUIndex != strconv.FormatUint(mdu, 10) || metadata.StartBlob != chunk.startLeaf {
		t.Fatalf("v3 metadata does not match frozen authority: %+v", metadata)
	}
	leafCount := key.Users * retrievalchallenge.IntegrityLeavesPerUserMDU
	for i, entry := range metadata.Entries {
		ordinal, err := strconv.ParseUint(entry.T, 10, 64)
		if err != nil || ordinal != chunk.t[i] {
			t.Fatalf("entry %d has invalid ordinal %q", i, entry.T)
		}
		entryMDU, entryLeaf, entrySlot, err := retrievalchallenge.SystematicCoordinateV3(ordinal, key.Metadata, key.Users)
		if err != nil || entryMDU != mdu || entrySlot != slot || entry.MDUIndex != strconv.FormatUint(entryMDU, 10) || entry.LeafIndex != entryLeaf {
			t.Fatalf("entry %d has noncanonical coordinate: %+v", i, entry)
		}
		position, err := strconv.ParseUint(entry.IntegrityPosition, 10, 64)
		wantPosition := (entryMDU-key.Metadata)*retrievalchallenge.IntegrityLeavesPerUserMDU + uint64(entryLeaf)
		if err != nil || position != wantPosition {
			t.Fatalf("entry %d has invalid integrity position %q", i, entry.IntegrityPosition)
		}
		path := make([][32]byte, len(entry.IntegrityPath))
		for j, encoded := range entry.IntegrityPath {
			raw, err := hex.DecodeString(strings.TrimPrefix(encoded, "0x"))
			if err != nil || !strings.HasPrefix(encoded, "0x") || len(raw) != 32 {
				t.Fatalf("entry %d has invalid integrity path element %d", i, j)
			}
			copy(path[j][:], raw)
		}
		blob := payload[i*types.BLOB_SIZE : (i+1)*types.BLOB_SIZE]
		leafValue, err := retrievalchallenge.IntegrityLeafV3(entryMDU, entryLeaf, blob)
		if err != nil || !retrievalchallenge.VerifyIntegrityPathV3(leafValue, position, leafCount, path, key.Integrity) {
			t.Fatalf("entry %d payload does not verify against the frozen integrity root: %v", i, err)
		}
	}
	if err := validateIntegrityIndexV3(filepath.Join(dir, integrityIndexV3File), key.Users*retrievalchallenge.IntegrityLeavesPerUserMDU); err != nil {
		t.Fatalf("legacy generation did not retain its cold-built index: %v", err)
	}

	shardPath := filepath.Join(dir, fmt.Sprintf("mdu_%d_slot_%d.bin", mdu, slot))
	shard, err := os.OpenFile(shardPath, os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := shard.WriteAt([]byte{0xff}, int64(uint64(leaf%8)*types.BLOB_SIZE+17)); err != nil {
		_ = shard.Close()
		t.Fatal(err)
	}
	if err := shard.Close(); err != nil {
		t.Fatal(err)
	}
	corrupt := invoke()
	if corrupt.Code == http.StatusOK || strings.HasPrefix(corrupt.Header().Get("Content-Type"), "multipart/form-data") {
		t.Fatalf("served a corrupted requested blob: %d %s", corrupt.Code, corrupt.Body.String())
	}
}

func TestGatewayMduV3AllowsConcurrentChunksForOneSession(t *testing.T) {
	frozen, key, _ := buildProviderV3ArtifactFixtureSize(t, RawMduCapacity+1024)
	response := responseFromFrozenV3(frozen)
	var chunks []retrievalDataChunkV3
	for _, obligation := range frozen.Session.Obligations {
		chunks = chunks[:0]
		for mdu := key.Metadata; mdu < key.Metadata+key.Users; mdu++ {
			chunk, err := frozenRetrievalDataChunkV3(frozen, ManifestRoot{Bytes: key.Root}, mdu, key.Deal, frozen.Session.Owner, obligation.Slot)
			if err == nil {
				chunks = append(chunks, chunk)
			}
		}
		if len(chunks) >= 2 {
			break
		}
	}
	if len(chunks) < 2 || chunks[0].mdu == chunks[1].mdu || chunks[0].slot != chunks[1].slot {
		t.Fatalf("fixture did not produce two distinct chunks for one provider: %+v", chunks)
	}
	signer := chunks[0].payee
	setupMockCombinedOutput(t, func(_ context.Context, _ string, args ...string) ([]byte, error) {
		if len(args) >= 2 && args[0] == "keys" && args[1] == "show" {
			return []byte(signer), nil
		}
		return nil, fmt.Errorf("unexpected command")
	})
	t.Setenv("POLYSTORE_PROVIDER_ADDRESS", signer)
	initRetrievalDataTestDB(t)

	firstQuery := make(chan struct{})
	secondQuery := make(chan struct{})
	releaseQueries := make(chan struct{})
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(releaseQueries) }) }
	var queryMu sync.Mutex
	v3Queries := 0
	lcd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/retrieval-sessions-v3/"):
			queryMu.Lock()
			v3Queries++
			queryNumber := v3Queries
			queryMu.Unlock()
			if queryNumber == 1 {
				close(firstQuery)
			} else if queryNumber == 2 {
				close(secondQuery)
			}
			select {
			case <-releaseQueries:
			case <-r.Context().Done():
				return
			}
			w.Header().Set(committedHeightHeader, strconv.FormatUint(frozen.Height, 10))
			if err := (&jsonpb.Marshaler{OrigName: true}).Marshal(w, &response); err != nil {
				t.Error(err)
			}
		case strings.Contains(r.URL.Path, "/retrieval-sessions/"):
			http.NotFound(w, r)
		default:
			t.Errorf("unexpected LCD query %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	oldLCD := lcdBase
	lcdBase = lcd.URL
	testCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	var requests sync.WaitGroup
	defer func() {
		release()
		cancel()
		requests.Wait()
		lcd.Close()
		lcdBase = oldLCD
	}()
	root := "0x" + hex.EncodeToString(key.Root[:])
	session := "0x" + hex.EncodeToString(frozen.Session.SessionId)
	request := func(chunk retrievalDataChunkV3) *httptest.ResponseRecorder {
		q := url.Values{"deal_id": {strconv.FormatUint(key.Deal, 10)}, "owner": {frozen.Session.Owner}}
		r := httptest.NewRequest(http.MethodGet, "/sp/retrieval/mdu/"+root+"/"+strconv.FormatUint(chunk.mdu, 10)+"?"+q.Encode(), nil).WithContext(testCtx)
		r = mux.SetURLVars(r, map[string]string{"cid": root, "index": strconv.FormatUint(chunk.mdu, 10)})
		r.Header.Set("X-PolyStore-Session-Id", session)
		r.Header.Set("Accept", "multipart/form-data; version=3")
		r.Header.Set("X-PolyStore-Slot", strconv.FormatUint(uint64(chunk.slot), 10))
		w := httptest.NewRecorder()
		GatewayMdu(w, r)
		return w
	}
	results := []chan *httptest.ResponseRecorder{make(chan *httptest.ResponseRecorder, 1), make(chan *httptest.ResponseRecorder, 1)}
	start := func(i int) {
		requests.Add(1)
		go func() {
			defer requests.Done()
			results[i] <- request(chunks[i])
		}()
	}
	start(0)
	select {
	case <-firstQuery:
	case <-time.After(2 * time.Second):
		t.Fatal("first chunk did not reach the v3 authority query")
	}
	start(1)
	select {
	case <-secondQuery:
		release()
	case response := <-results[1]:
		release()
		t.Fatalf("second chunk was rejected before its v3 authority query: %d %s", response.Code, response.Body.String())
	case <-time.After(2 * time.Second):
		release()
		t.Fatal("second chunk did not reach the v3 authority query")
	}
	for i, result := range results {
		select {
		case response := <-result:
			if response.Code != http.StatusOK {
				t.Fatalf("concurrent chunk %d failed: %d %s", i, response.Code, response.Body.String())
			}
			metadata, payload := decodeRetrievalDataResponseV3(t, response)
			if metadata.MDUIndex != strconv.FormatUint(chunks[i].mdu, 10) || metadata.Slot != chunks[i].slot || len(payload) != len(chunks[i].t)*types.BLOB_SIZE {
				t.Fatalf("concurrent chunk %d returned the wrong authenticated bytes: metadata=%+v bytes=%d", i, metadata, len(payload))
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("concurrent chunk %d did not complete", i)
		}
	}
}

func TestGatewayMduV3RejectsOlderSessionWithoutPersistence(t *testing.T) {
	initRetrievalDataTestDB(t)
	var id, root [32]byte
	id[0], root[0] = 0x33, 0x44
	response := types.QueryGetRetrievalSessionResponse{Session: types.RetrievalSession{
		SessionId: id[:], ManifestRoot: root[:], OpenedHeight: 1, UpdatedHeight: 1, ExpiresAt: 100,
		Status: types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_OPEN, BlobCount: 1, TotalBytes: types.BlobSizeBytes,
	}}
	lcd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/retrieval-sessions/") {
			t.Errorf("unexpected LCD query %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		if err := (&jsonpb.Marshaler{OrigName: true}).Marshal(w, &response); err != nil {
			t.Error(err)
		}
	}))
	defer lcd.Close()
	oldLCD := lcdBase
	lcdBase = lcd.URL
	defer func() { lcdBase = oldLCD }()
	rootHex := "0x" + hex.EncodeToString(root[:])
	r := httptest.NewRequest(http.MethodGet, "/sp/retrieval/mdu/"+rootHex+"/0?deal_id=0&owner=owner", nil)
	r = mux.SetURLVars(r, map[string]string{"cid": rootHex, "index": "0"})
	r.Header.Set("X-PolyStore-Session-Id", "0x"+hex.EncodeToString(id[:]))
	r.Header.Set("Accept", "multipart/form-data; version=3")
	r.Header.Set("X-PolyStore-Slot", "0")
	w := httptest.NewRecorder()
	GatewayMdu(w, r)
	if w.Code != http.StatusNotAcceptable || !strings.Contains(w.Body.String(), "session does not support retrieval version 3") {
		t.Fatalf("older session was not rejected at the version boundary: %d %s", w.Code, w.Body.String())
	}
	if frozenProofExists(t, frozenProofKey(id)) {
		t.Fatal("version mismatch persisted a v2 proof")
	}
}

func TestGatewayMduV2RetainsExclusiveSessionClaim(t *testing.T) {
	id := strings.Repeat("55", 32)
	release, err := claimRetrievalOperations([]string{"0x" + id}, "")
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	queries := 0
	lcd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		queries++
		http.NotFound(w, r)
	}))
	defer lcd.Close()
	oldLCD := lcdBase
	lcdBase = lcd.URL
	defer func() { lcdBase = oldLCD }()
	root := "0x" + strings.Repeat("00", 32)
	r := httptest.NewRequest(http.MethodGet, "/sp/retrieval/mdu/"+root+"/0", nil)
	r = mux.SetURLVars(r, map[string]string{"cid": root, "index": "0"})
	r.Header.Set("X-PolyStore-Session-Id", "0x"+id)
	r.Header.Set("Accept", "multipart/form-data; version=2")
	w := httptest.NewRecorder()
	GatewayMdu(w, r)
	if w.Code != http.StatusServiceUnavailable || queries != 0 {
		t.Fatalf("v2 request escaped its exclusive claim: status=%d queries=%d body=%s", w.Code, queries, w.Body.String())
	}
}

func TestFrozenRetrievalDataChunksCoverExactRange(t *testing.T) {
	for _, tc := range []struct {
		name               string
		rangeStart, length uint64
	}{
		{"1 KiB", 0, 1024},
		{"unaligned MDU boundary", RawMduCapacity - 17, 1024},
		{"1 GiB", 0, 1 << 30},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fileLength := tc.rangeStart + tc.length
			users := 1 + (fileLength-1)/RawMduCapacity
			response, height := frozenSessionV3FixtureRange(t, tc.rangeStart, tc.length, users)
			frozen, err := freezeRetrievalSessionV3Response(response, height)
			if err != nil {
				t.Fatal(err)
			}
			root := ManifestRoot{Bytes: frozen.Context.PolyFSRoot}
			seen := make(map[uint64]int, frozen.Plan.Population)
			for mdu := frozen.Context.MetadataMDUs; mdu < frozen.Context.MetadataMDUs+frozen.Context.UserMDUs; mdu++ {
				for _, obligation := range frozen.Session.Obligations {
					chunk, err := frozenRetrievalDataChunkV3(frozen, root, mdu, frozen.Context.DealID, frozen.Session.Owner, obligation.Slot)
					if err != nil {
						continue
					}
					if chunk.mdu != mdu || chunk.slot != obligation.Slot || len(chunk.t) == 0 || len(chunk.t) > 8 || len(chunk.t)*types.BLOB_SIZE > 1<<20 {
						t.Fatalf("invalid bounded chunk: %+v", chunk)
					}
					for _, ordinal := range chunk.t {
						actualMDU, _, actualSlot, err := retrievalchallenge.SystematicCoordinateV3(ordinal, frozen.Context.MetadataMDUs, frozen.Context.UserMDUs)
						if err != nil || actualMDU != mdu || actualSlot != obligation.Slot || ordinal < frozen.Plan.First || ordinal > frozen.Plan.Last {
							t.Fatalf("noncanonical chunk coordinate t=%d mdu=%d slot=%d: %v", ordinal, mdu, obligation.Slot, err)
						}
						seen[ordinal]++
					}
				}
			}
			if uint64(len(seen)) != frozen.Plan.Population {
				t.Fatalf("covered %d ordinals, want %d", len(seen), frozen.Plan.Population)
			}
			for ordinal := frozen.Plan.First; ordinal <= frozen.Plan.Last; ordinal++ {
				if seen[ordinal] != 1 {
					t.Fatalf("ordinal %d covered %d times", ordinal, seen[ordinal])
				}
			}
		})
	}
}

func BenchmarkRetrievalDataV3Hot1MiB(b *testing.B) {
	frozen, key, dir := buildProviderV3ArtifactFixtureSize(b, RawMduCapacity)
	chunk, err := frozenRetrievalDataChunkV3(frozen, ManifestRoot{Bytes: key.Root}, key.Metadata, key.Deal, frozen.Session.Owner, 0)
	if err != nil || len(chunk.t) != 8 {
		b.Fatalf("invalid full-MDU benchmark chunk: %+v %v", chunk, err)
	}
	indexPath := filepath.Join(dir, integrityIndexV3File)
	if err := os.Remove(indexPath); err != nil && !os.IsNotExist(err) {
		b.Fatal(err)
	}
	coldStart := time.Now()
	if _, err := ensureIntegrityIndexV3(b.Context(), dir, key); err != nil {
		b.Fatal(err)
	}
	coldElapsed := time.Since(coldStart)
	info, err := os.Stat(indexPath)
	if err != nil {
		b.Fatal(err)
	}
	if metadata, payload, err := prepareRetrievalDataV3(b.Context(), dir, frozen, chunk); err != nil || len(metadata) == 0 || len(payload) != 1<<20 {
		b.Fatalf("cannot warm 1 MiB retrieval: metadata=%d payload=%d err=%v", len(metadata), len(payload), err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		metadata, payload, err := prepareRetrievalDataV3(b.Context(), dir, frozen, chunk)
		if err != nil || len(metadata) == 0 || len(payload) != 1<<20 {
			b.Fatalf("hot 1 MiB retrieval failed: metadata=%d payload=%d err=%v", len(metadata), len(payload), err)
		}
	}
	b.StopTimer()
	b.ReportMetric(float64(coldElapsed.Nanoseconds()), "cold-ns")
	b.ReportMetric(float64(info.Size()), "index-bytes")
}

func TestGatewayMduDoesNotTreatV2AuthorityFailureAsV3(t *testing.T) {
	initRetrievalDataTestDB(t)
	v3Queries := 0
	lcd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/retrieval-sessions-v3/") {
			v3Queries++
		}
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer lcd.Close()
	oldLCD := lcdBase
	lcdBase = lcd.URL
	defer func() { lcdBase = oldLCD }()
	root := strings.Repeat("00", 32)
	r := httptest.NewRequest(http.MethodGet, "/sp/retrieval/mdu/0x"+root+"/4?deal_id=0&owner=owner", nil)
	r = mux.SetURLVars(r, map[string]string{"cid": "0x" + root, "index": "4"})
	r.Header.Set("X-PolyStore-Session-Id", "0x"+strings.Repeat("11", 32))
	r.Header.Set("Accept", "multipart/form-data; version=3")
	r.Header.Set("X-PolyStore-Slot", "0")
	w := httptest.NewRecorder()
	GatewayMdu(w, r)
	if w.Code != http.StatusBadGateway || v3Queries != 0 {
		t.Fatalf("v2 authority failure fell through to v3: status=%d v3_queries=%d", w.Code, v3Queries)
	}
}

func TestGatewayMduRejectsDuplicateSessionAuthority(t *testing.T) {
	root := strings.Repeat("00", 32)
	r := httptest.NewRequest(http.MethodGet, "/sp/retrieval/mdu/0x"+root+"/4", nil)
	r = mux.SetURLVars(r, map[string]string{"cid": "0x" + root, "index": "4"})
	r.Header.Add("X-PolyStore-Session-Id", "0x"+strings.Repeat("11", 32))
	r.Header.Add("X-PolyStore-Session-Id", "0x"+strings.Repeat("22", 32))
	w := httptest.NewRecorder()
	GatewayMdu(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("accepted duplicate session authority: %d %s", w.Code, w.Body.String())
	}
}

func TestRouterGatewayMduV3PinsFrozenPayeeAndChunk(t *testing.T) {
	t.Setenv("POLYSTORE_RETRIEVAL_DIAGNOSTICS", "1")
	response, height := frozenSessionV3Fixture(t, retrievalchallenge.DataBlobPayloadBytes+1, 1)
	frozen, err := freezeRetrievalSessionV3Response(response, height)
	if err != nil {
		t.Fatal(err)
	}
	query := responseFromFrozenV3(frozen)
	obligation := frozen.Session.Obligations[0]
	root := "0x" + hex.EncodeToString(frozen.Context.PolyFSRoot[:])
	session := "0x" + hex.EncodeToString(frozen.Session.SessionId)
	chunk, err := frozenRetrievalDataChunkV3(frozen, ManifestRoot{Bytes: frozen.Context.PolyFSRoot}, frozen.Context.MetadataMDUs, frozen.Context.DealID, frozen.Session.Owner, obligation.Slot)
	if err != nil {
		t.Fatal(err)
	}
	providerHits := 0
	var proxyDeadlines []time.Duration
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		providerHits++
		if r.Header.Get("X-PolyStore-Session-Id") != session || r.Header.Get("X-PolyStore-Slot") != strconv.FormatUint(uint64(obligation.Slot), 10) || r.URL.Query().Has("provider") || r.URL.Query().Has("deputy") {
			t.Errorf("router changed frozen v3 request authority: %s", r.URL)
		}
		w.Header().Set("Content-Type", "multipart/form-data; boundary=frozen; version=3")
		w.Header().Set("Server-Timing", `ps3p_lcd;dur=4.000;desc="2"`)
		_, _ = w.Write([]byte("verified provider response"))
	}))
	defer upstream.Close()
	originalV3Client := routerRetrievalV3HTTPClient
	v3Transport, ok := originalV3Client.Transport.(*http.Transport)
	if !ok || v3Transport.ResponseHeaderTimeout != retrievalV3DataRouteTimeout {
		t.Fatalf("v3 proxy response-header timeout does not cover the cold route: %#v", originalV3Client.Transport)
	}
	routerRetrievalV3HTTPClient = &http.Client{Transport: retrievalV3DeadlineTransport(func(r *http.Request) (*http.Response, error) {
		deadline, ok := r.Context().Deadline()
		if !ok {
			t.Error("v3 proxy request has no deadline")
		} else {
			proxyDeadlines = append(proxyDeadlines, time.Until(deadline))
		}
		return originalV3Client.Transport.RoundTrip(r)
	})}
	t.Cleanup(func() { routerRetrievalV3HTTPClient = originalV3Client })
	lcd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/retrieval-sessions-v3/"):
			w.Header().Set(committedHeightHeader, strconv.FormatUint(height, 10))
			_ = (&jsonpb.Marshaler{OrigName: true}).Marshal(w, &query)
		case strings.Contains(r.URL.Path, "/retrieval-sessions/"):
			http.NotFound(w, r)
		case strings.Contains(r.URL.Path, "/providers/"):
			if !strings.HasSuffix(r.URL.Path, obligation.Payee) {
				t.Errorf("resolved a provider other than the frozen payee: %s", r.URL.Path)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"provider": map[string]any{"endpoints": []string{mustHTTPMultiaddr(t, upstream.URL)}}})
		default:
			t.Errorf("unexpected LCD query %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer lcd.Close()
	oldLCD := lcdBase
	lcdBase = lcd.URL
	defer func() { lcdBase = oldLCD }()
	providerBaseCache = sync.Map{}
	providerBaseCache.Store(obligation.Payee, &providerBaseCacheEntry{baseURL: upstream.URL, expires: time.Now().Add(time.Hour)})
	q := url.Values{"deal_id": {"0"}, "owner": {frozen.Session.Owner}, "provider": {frozen.Session.Owner}, "deputy": {"1"}}
	request := func(ctx context.Context) *http.Request {
		r := httptest.NewRequest(http.MethodGet, "/gateway/mdu/"+root+"/"+strconv.FormatUint(chunk.mdu, 10)+"?"+q.Encode(), nil).WithContext(ctx)
		r = mux.SetURLVars(r, map[string]string{"cid": root, "index": strconv.FormatUint(chunk.mdu, 10)})
		r.Header.Set("X-PolyStore-Session-Id", session)
		r.Header.Set("Accept", "multipart/form-data; version=3")
		r.Header.Set("X-PolyStore-Slot", strconv.FormatUint(uint64(obligation.Slot), 10))
		return r
	}
	w := httptest.NewRecorder()
	RouterGatewayMdu(w, request(context.Background()))
	if w.Code != http.StatusOK || w.Body.String() != "verified provider response" {
		t.Fatalf("v3 user-gateway routing failed: status=%d body=%q", w.Code, w.Body.String())
	}
	timing := strings.Join(w.Header().Values("Server-Timing"), ", ")
	if !strings.Contains(timing, "ps3p_lcd") || !strings.Contains(timing, "ps3g_lcd") || !strings.Contains(timing, "ps3g_endpoint") || strings.Contains(timing, "ps3g_proxy") || strings.Contains(timing, "keys") {
		t.Fatalf("proxy lost or misattributed phase headers: %s", timing)
	}
	if !w.Flushed {
		t.Fatal("instrumented public proxy did not flush the upstream response")
	}
	shortCtx, cancelShort := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelShort()
	w = httptest.NewRecorder()
	RouterGatewayMdu(w, request(shortCtx))
	if w.Code != http.StatusOK || w.Body.String() != "verified provider response" {
		t.Fatalf("v3 user-gateway routing with caller deadline failed: status=%d body=%q", w.Code, w.Body.String())
	}
	if providerHits != 2 || len(proxyDeadlines) != 2 || proxyDeadlines[0] <= 60*time.Second || proxyDeadlines[0] > retrievalV3DataRouteTimeout || proxyDeadlines[1] <= 0 || proxyDeadlines[1] > 10*time.Second {
		t.Fatalf("v3 proxy deadlines did not preserve route and caller bounds: hits=%d deadlines=%v", providerHits, proxyDeadlines)
	}
}

func TestRetrievalDataV3RejectsAuthorityBoundsAndTerminalSlot(t *testing.T) {
	response, height := frozenSessionV3Fixture(t, retrievalchallenge.DataBlobPayloadBytes+1, 1)
	frozen, err := freezeRetrievalSessionV3Response(response, height)
	if err != nil {
		t.Fatal(err)
	}
	root := ManifestRoot{Bytes: frozen.Context.PolyFSRoot}
	wrongRoot := root
	wrongRoot.Bytes[0] ^= 1
	slot := frozen.Session.Obligations[0].Slot
	validMDU := frozen.Context.MetadataMDUs
	for _, tc := range []struct {
		name   string
		root   ManifestRoot
		mdu    uint64
		deal   uint64
		owner  string
		slot   uint32
		mutate func(*frozenRetrievalSessionV3)
	}{
		{"metadata MDU", root, validMDU - 1, frozen.Context.DealID, frozen.Session.Owner, slot, nil},
		{"wrong root", wrongRoot, validMDU, frozen.Context.DealID, frozen.Session.Owner, slot, nil},
		{"wrong deal", root, validMDU, frozen.Context.DealID + 1, frozen.Session.Owner, slot, nil},
		{"wrong owner", root, validMDU, frozen.Context.DealID, frozen.Session.Owner + "x", slot, nil},
		{"invalid slot", root, validMDU, frozen.Context.DealID, frozen.Session.Owner, 8, nil},
		{"acked slot", root, validMDU, frozen.Context.DealID, frozen.Session.Owner, slot, func(f *frozenRetrievalSessionV3) { f.Session.AckedSlotsMask = 1 << slot }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			copy := *frozen
			if tc.mutate != nil {
				tc.mutate(&copy)
			}
			if _, err := frozenRetrievalDataChunkV3(&copy, tc.root, tc.mdu, tc.deal, tc.owner, tc.slot); err == nil {
				t.Fatal("accepted mismatched or terminal v3 data authority")
			}
		})
	}
}

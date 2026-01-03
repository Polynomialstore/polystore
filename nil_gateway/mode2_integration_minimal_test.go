package main

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"

	"nilchain/x/crypto_ffi"
)

type mode2DealState struct {
	mu         sync.RWMutex
	owner      string
	cid        string
	serviceHint string
	providers  []string
	endpoints  map[string]string // providerAddr -> baseURL
}

func (s *mode2DealState) getDeal() (owner, cid, hint string, providers []string) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]string, len(s.providers))
	copy(out, s.providers)
	return s.owner, s.cid, s.serviceHint, out
}

func (s *mode2DealState) setCID(cid string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cid = cid
}

func (s *mode2DealState) baseURLFor(provider string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.endpoints[provider]
}

func newMode2LCDServer(t *testing.T, dealID uint64, state *mode2DealState) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/nilchain/nilchain/v1/deals/"):
			owner, cid, hint, providers := state.getDeal()
			_ = json.NewEncoder(w).Encode(map[string]any{
				"deal": map[string]any{
					"id":           dealID,
					"owner":        owner,
					"cid":          cid,
					"service_hint": hint,
					"providers":    providers,
				},
			})
		case strings.HasPrefix(r.URL.Path, "/nilchain/nilchain/v1/providers/"):
			providerAddr := strings.TrimPrefix(r.URL.Path, "/nilchain/nilchain/v1/providers/")
			baseURL := state.baseURLFor(providerAddr)
			if strings.TrimSpace(baseURL) == "" {
				http.NotFound(w, r)
				return
			}
			maddr := mustHTTPMultiaddr(t, baseURL)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"provider": map[string]any{
					"endpoints": []string{maddr},
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))
}

func newProviderServer(t *testing.T) (*httptest.Server, *sync.Map) {
	t.Helper()
	// key: "<manifest_root>|<mdu_index>|<slot>" -> []byte
	shards := &sync.Map{}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/sp/upload_shard":
			if got := strings.TrimSpace(r.Header.Get("Expect")); got != "100-continue" {
				t.Errorf("missing Expect: 100-continue header (got %q) on %s", got, r.URL.Path)
				http.Error(w, "missing Expect header", http.StatusBadRequest)
				return
			}
			manifest := strings.TrimSpace(r.Header.Get("X-Nil-Manifest-Root"))
			mduIdx := strings.TrimSpace(r.Header.Get("X-Nil-Mdu-Index"))
			slot := strings.TrimSpace(r.Header.Get("X-Nil-Slot"))
			body, _ := ioReadAllLimit(r, 12<<20)
			shards.Store(manifest+"|"+mduIdx+"|"+slot, body)
			w.WriteHeader(http.StatusOK)
			return
		case "/sp/shard":
			q := r.URL.Query()
			manifest := strings.TrimSpace(q.Get("manifest_root"))
			mduIdx := strings.TrimSpace(q.Get("mdu_index"))
			slot := strings.TrimSpace(q.Get("slot"))
			if v, ok := shards.Load(manifest + "|" + mduIdx + "|" + slot); ok {
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write(v.([]byte))
				return
			}
			http.NotFound(w, r)
			return
		case "/sp/upload_mdu", "/sp/upload_manifest":
			if got := strings.TrimSpace(r.Header.Get("Expect")); got != "100-continue" {
				t.Errorf("missing Expect: 100-continue header (got %q) on %s", got, r.URL.Path)
				http.Error(w, "missing Expect header", http.StatusBadRequest)
				return
			}
			_ = r.Body.Close()
			// Dumb pipe: accept and discard (fetch path uses local disk).
			w.WriteHeader(http.StatusOK)
			return
		default:
			http.NotFound(w, r)
			return
		}
	}))
	t.Cleanup(srv.Close)
	return srv, shards
}

func ioReadAllLimit(r *http.Request, limit int64) ([]byte, error) {
	defer r.Body.Close()
	return io.ReadAll(io.LimitReader(r.Body, limit))
}

func TestGateway_Mode2_UploadThenFetch_WithMissingLocalShard(t *testing.T) {
	dealProviderCache = sync.Map{}
	providerBaseCache = sync.Map{}

	useTempUploadDir(t)
	if err := crypto_ffi.Init(trustedSetup); err != nil {
		t.Fatalf("crypto_ffi.Init failed: %v", err)
	}

	oldReqSig := requireRetrievalReqSig
	requireRetrievalReqSig = false
	t.Cleanup(func() { requireRetrievalReqSig = oldReqSig })

	dealID := uint64(42)
	owner := testDealOwner(t)

	fx := readMode2Fixture(t)
	payload := decodeHex0x(t, fx.PayloadHex)

	// 12 providers: slot 0..11
	providers := make([]string, 0, 12)
	endpoints := map[string]string{}
	for i := 0; i < 12; i++ {
		addr := "nil1provider" + strconv.Itoa(i)
		providers = append(providers, addr)
		srv, _ := newProviderServer(t)
		endpoints[addr] = srv.URL
	}

	state := &mode2DealState{
		owner:       owner,
		cid:         "",
		serviceHint: "General:replicas=12:rs=8+4",
		providers:   providers,
		endpoints:   endpoints,
	}

	lcdSrv := newMode2LCDServer(t, dealID, state)
	defer lcdSrv.Close()
	oldLCD := lcdBase
	lcdBase = lcdSrv.URL
	t.Cleanup(func() { lcdBase = oldLCD })

	// Gateway acts as the slot 0 provider for proof headers.
	t.Setenv("NIL_PROVIDER_ADDRESS", providers[0])

	// Upload via gateway (Mode 2 ingest), then "commit" by updating mock LCD cid.
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, _ := writer.CreateFormFile("file", "fixture.bin")
	_, _ = part.Write(payload)
	_ = writer.WriteField("deal_id", strconv.FormatUint(dealID, 10))
	_ = writer.WriteField("file_path", "fixture.bin")
	_ = writer.Close()

	uploadReq := httptest.NewRequest(http.MethodPost, "/gateway/upload?deal_id="+strconv.FormatUint(dealID, 10), body)
	uploadReq.Header.Set("Content-Type", writer.FormDataContentType())
	uploadW := httptest.NewRecorder()
	testRouter().ServeHTTP(uploadW, uploadReq)
	if uploadW.Code != http.StatusOK {
		t.Fatalf("GatewayUpload failed: %d %s", uploadW.Code, uploadW.Body.String())
	}

	var uploadResp struct {
		ManifestRoot string `json:"manifest_root"`
		CID          string `json:"cid"`
	}
	_ = json.Unmarshal(uploadW.Body.Bytes(), &uploadResp)
	cid := strings.TrimSpace(uploadResp.ManifestRoot)
	if cid == "" {
		cid = strings.TrimSpace(uploadResp.CID)
	}
	if cid == "" {
		t.Fatalf("missing manifest_root in upload response: %s", uploadW.Body.String())
	}
	state.setCID(cid)

	root, err := parseManifestRoot(cid)
	if err != nil {
		t.Fatalf("parseManifestRoot: %v", err)
	}
	gotOwner, gotCID, err := fetchDealOwnerAndCID(dealID)
	if err != nil {
		t.Fatalf("fetchDealOwnerAndCID failed: %v", err)
	}
	if strings.TrimSpace(gotOwner) != owner {
		t.Fatalf("deal owner mismatch: got %s want %s", gotOwner, owner)
	}
	if strings.TrimSpace(gotCID) != root.Canonical {
		t.Fatalf("deal cid mismatch: got %s want %s", gotCID, root.Canonical)
	}
	root2, err := parseManifestRoot(gotCID)
	if err != nil {
		t.Fatalf("parseManifestRoot(deal cid): %v", err)
	}
	if root2.Key != root.Key {
		t.Fatalf("manifest_root key mismatch: got %s want %s", root2.Key, root.Key)
	}
	dealDir := dealScopedDir(dealID, root)
	if info, err := os.Stat(dealDir); err != nil || !info.IsDir() {
		entries, _ := os.ReadDir(uploadDir)
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("expected dealDir to exist (%s); uploadDir entries=%v err=%v", dealDir, names, err)
	}
	if resolved, err := resolveDealDirForDeal(dealID, root, root.Canonical); err != nil {
		t.Fatalf("resolveDealDirForDeal failed unexpectedly: dir=%s err=%v", resolved, err)
	} else if resolved != dealDir {
		t.Fatalf("resolveDealDirForDeal mismatch: got %s want %s", resolved, dealDir)
	}
	// Remove one local shard to force remote fetch on reconstruction.
	_ = os.Remove(filepath.Join(dealDir, "mdu_2_slot_0.bin"))

	fetchReq := httptest.NewRequest(http.MethodGet, "/gateway/fetch/"+root.Canonical+"?deal_id="+strconv.FormatUint(dealID, 10)+"&owner="+owner+"&file_path=fixture.bin", nil)
	fetchW := httptest.NewRecorder()
	testRouter().ServeHTTP(fetchW, fetchReq)
	if fetchW.Code != http.StatusOK {
		t.Fatalf("GatewayFetch failed: %d %s", fetchW.Code, fetchW.Body.String())
	}

	if !bytes.Equal(fetchW.Body.Bytes(), payload) {
		t.Fatalf("fetched bytes mismatch")
	}
}

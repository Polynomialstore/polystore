package main

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/types"
)

// Each provider has only its assigned shard. The deputy has replicated metadata
// and slot 11, while both the original data and parity targets are unavailable.
func TestFrozenDeputyReconstructsSeparateProviderShards(t *testing.T) {
	useTempUploadDir(t)
	if err := crypto_ffi.Init(trustedSetup); err != nil {
		t.Fatal(err)
	}
	payload := make([]byte, 12*126976)
	for i := range payload {
		payload[i] = byte(i*37 + i/97)
	}
	source := filepath.Join(t.TempDir(), "payload.bin")
	if err := os.WriteFile(source, payload, 0600); err != nil {
		t.Fatal(err)
	}
	result, _, err := mode2BuildArtifacts(context.Background(), source, 9007199254740993, "General:rs=8+4", "payload.bin", 0)
	if err != nil {
		t.Fatal(err)
	}
	dir := dealScopedDir(9007199254740993, result.manifestRoot)
	r := testFrozenSession(t)
	r.Session.ManifestRoot = bytes.Clone(result.manifestRoot.Bytes[:])
	r.Session.StartMduIndex = 1 + result.witnessMdus
	r.Session.ChallengeSnapshot.MetadataMdus = 1 + result.witnessMdus
	r.Session.ChallengeSnapshot.UserMdus = result.userMdus
	// Providers do not receive the producer's full encoded data MDU.
	if err := os.Remove(filepath.Join(dir, fmt.Sprintf("mdu_%d.bin", r.Session.StartMduIndex))); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	var requests atomic.Int32
	var corrupt atomic.Int32
	slots := make([]mode2SlotAssignment, 12)
	expected := make(map[int][]byte)
	for slot := 0; slot < 12; slot++ {
		name := fmt.Sprintf("mdu_%d_slot_%d.bin", r.Session.StartMduIndex, slot)
		shard, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		expected[slot] = shard
		providerDir := t.TempDir()
		if err := os.WriteFile(filepath.Join(providerDir, name), shard, 0600); err != nil {
			t.Fatal(err)
		}
		if slot != 11 {
			if err := os.Remove(filepath.Join(dir, name)); err != nil {
				t.Fatal(err)
			}
		}
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			requests.Add(1)
			q := req.URL.Query()
			if req.URL.Path != "/sp/shard" || q.Get("manifest_root") != result.manifestRoot.Canonical || q.Get("deal_id") != strconv.FormatUint(r.Session.DealId, 10) || q.Get("mdu_index") != strconv.FormatUint(r.Session.StartMduIndex, 10) || q.Get("slot") != strconv.Itoa(slot) || req.Header.Get("X-PolyStore-Session-Id") == "" {
				http.Error(w, "wrong frozen request", 400)
				return
			}
			if slot == 1 || slot == 9 {
				http.NotFound(w, req)
				return
			}
			data, err := os.ReadFile(filepath.Join(providerDir, name))
			if err != nil {
				t.Error(err)
				http.Error(w, "missing", 500)
				return
			}
			if corrupt.Load() == 2 || (corrupt.Load() == 1 && slot == 0) {
				data[31] ^= 1
			}
			_, _ = w.Write(data)
		}))
		t.Cleanup(server.Close)
		provider := fmt.Sprintf("deputy-test-provider-%d", slot)
		slots[slot] = mode2SlotAssignment{Provider: provider, Status: 1}
		providerBaseCache.Store(provider, &providerBaseCacheEntry{baseURL: server.URL, expires: time.Now().Add(time.Hour)})
		t.Cleanup(func() { providerBaseCache.Delete(provider) })
	}
	dealMode2SlotsCache.Store(r.Session.DealId, &dealMode2SlotsCacheEntry{slots: slots, expires: time.Now().Add(time.Hour)})
	t.Cleanup(func() { dealMode2SlotsCache.Delete(r.Session.DealId) })
	for _, slot := range []int{1, 9} {
		t.Run(fmt.Sprintf("slot_%d", slot), func(t *testing.T) {
			r.Session.ChallengeSnapshot.Slot = uint32(slot)
			r.Session.StartBlobIndex = uint32(slot * 8)
			c, err := types.RetrievalChallengeContext(r.Session)
			if err != nil {
				t.Fatal(err)
			}
			hash, _ := c.Hash()
			f := &frozenRetrievalSession{Session: r.Session, Context: c, Hash: hash, Seed: [32]byte(r.ChallengeSeed), Height: 12}
			before := requests.Load()
			proofs, window, err := generateFrozenSessionProof(context.Background(), dir, f)
			if err != nil {
				t.Fatal(err)
			}
			if requests.Load()-before > 24 {
				t.Fatal("unbounded source requests")
			}
			if !bytes.Equal(window, expected[slot][:2*types.BLOB_SIZE]) || len(proofs) != 2 {
				t.Fatal("reconstructed window differs")
			}
			if slot == 1 {
				r.ChallengeContext, _ = c.Bytes()
				r.ChallengeContextHash = hash[:]
				exerciseFrozenSessionDelivery(t, r, window)
			}

			if f.Context != c || f.Hash != hash {
				t.Fatal("reconstruction changed frozen authority")
			}
			if _, err := os.Stat(filepath.Join(dir, fmt.Sprintf("mdu_%d_slot_%d.bin", c.StartMDU, slot))); !os.IsNotExist(err) {
				t.Fatal("reconstruction persisted a new shard")
			}
		})
	}
	if requests.Load() == 0 {
		t.Fatal("did not use separate provider storage")
	}
	corrupt.Store(2)
	c, err := types.RetrievalChallengeContext(r.Session)
	if err != nil {
		t.Fatal(err)
	}
	hash, _ := c.Hash()
	f := &frozenRetrievalSession{Session: r.Session, Context: c, Hash: hash, Seed: [32]byte(r.ChallengeSeed), Height: 12}
	corrupt.Store(1)
	if _, window, err := generateFrozenSessionProof(context.Background(), dir, f); err != nil || !bytes.Equal(window, expected[9][:2*types.BLOB_SIZE]) {
		t.Fatalf("failed to recover past a corrupt source: %v", err)
	}
	corrupt.Store(2)
	if _, _, err := generateFrozenSessionProof(context.Background(), dir, f); err == nil {
		t.Fatal("accepted corrupt reconstruction inputs")
	}
	before := requests.Load()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := generateFrozenSessionProof(ctx, dir, f); err == nil {
		t.Fatal("ignored cancellation")
	}
	if requests.Load() != before {
		t.Fatal("dispatched after cancellation")
	}
}

func TestFrozenShardFetchBoundsAndCancellation(t *testing.T) {
	t.Run("oversized", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(make([]byte, types.MDU_SIZE+1)) }))
		defer server.Close()
		if _, err := fetchShardFromProvider(context.Background(), server.URL, 1, "root", 2, 1, "session"); err == nil {
			t.Fatal("accepted oversized shard")
		}
	})
	t.Run("redirect", func(t *testing.T) {
		var forwarded atomic.Bool
		target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { forwarded.Store(true) }))
		defer target.Close()
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 302) }))
		defer server.Close()
		if _, err := fetchShardFromProvider(context.Background(), server.URL, 1, "root", 2, 1, "session"); err == nil {
			t.Fatal("accepted redirect")
		}
		if forwarded.Load() {
			t.Fatal("forwarded provider credentials")
		}
	})
	t.Run("cancel_inflight", func(t *testing.T) {
		started := make(chan struct{})
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(started); <-r.Context().Done() }))
		defer server.Close()
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		done := make(chan error, 1)
		go func() { _, err := fetchShardFromProvider(ctx, server.URL, 1, "root", 2, 1, "session"); done <- err }()
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("request did not start")
		}
		cancel()
		select {
		case err := <-done:
			if err == nil {
				t.Fatal("ignored cancellation")
			}
		case <-time.After(time.Second):
			t.Fatal("request did not cancel")
		}
	})
}

// Exercise the production provider handler and recovery HTTP client together.
// uploadDir is fixed before serving; the deputy's separate store is never
// substituted into the provider process, and no per-request global is changed.
func TestFrozenShardFetchRealProviderHandler(t *testing.T) {
	useTempUploadDir(t)
	deputyDir := t.TempDir()
	const deal = uint64(9007199254740993)
	root := mustTestManifestRoot(t, "frozen-repair-provider")
	newer := mustTestManifestRoot(t, "newer-repair-provider")
	data := make([]byte, types.BLOB_SIZE)
	for i := range data {
		data[i] = byte(i*37 + i/97)
	}
	providerDir := dealScopedDir(deal, root)
	if err := os.MkdirAll(providerDir, 0700); err != nil {
		t.Fatal(err)
	}
	filename := "mdu_2_slot_0.bin"
	if err := os.WriteFile(filepath.Join(providerDir, filename), data, 0600); err != nil {
		t.Fatal(err)
	}
	// A mutable active pointer must never redirect the frozen root's request.
	if err := writeActiveDealGeneration(deal, newer); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(SpFetchShard))
	defer server.Close()
	session := "0x" + fmt.Sprintf("%064x", 1)
	got, err := fetchShardFromProvider(context.Background(), server.URL, deal, root.Canonical, 2, 0, session)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("real provider fetch: %v", err)
	}
	if _, err := os.Stat(filepath.Join(deputyDir, filename)); !os.IsNotExist(err) {
		t.Fatal("provider fetch wrote deputy artifacts")
	}
	if _, err := fetchShardFromProvider(context.Background(), server.URL, deal, newer.Canonical, 2, 0, session); err == nil {
		t.Fatal("substituted another generation")
	}
	if _, err := fetchShardFromProvider(context.Background(), server.URL, deal, root.Canonical, 2, 1, session); err == nil {
		t.Fatal("served an unowned slot")
	}
	for _, token := range []string{"", "wrong-token"} {
		req, err := http.NewRequest(http.MethodGet, fmt.Sprintf("%s/sp/shard?deal_id=%d&mdu_index=2&slot=0&manifest_root=%s", server.URL, deal, root.Canonical), nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set(gatewayAuthHeader, token)
		req.Header.Set("X-PolyStore-Session-Id", session)
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		if response.StatusCode != http.StatusForbidden {
			t.Fatalf("session header bypassed bearer auth: %d", response.StatusCode)
		}
	}
}

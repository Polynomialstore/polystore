package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
)

type retentionTestAuthority struct {
	sync.Mutex
	retained []ManifestRoot
	badBody  string
	before   func()
}

func useRetentionAuthority(t *testing.T, deal uint64, current ManifestRoot, retained ...ManifestRoot) *retentionTestAuthority {
	t.Helper()
	a := &retentionTestAuthority{retained: retained}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(committedHeightHeader, "20")
		if strings.HasSuffix(r.URL.Path, "retained-generations") {
			a.Lock()
			before, bad := a.before, a.badBody
			roots := append([]ManifestRoot(nil), a.retained...)
			a.Unlock()
			if before != nil {
				before()
			}
			if bad != "" {
				_, _ = w.Write([]byte(bad))
				return
			}
			list := make([]map[string]any, 0, len(roots))
			for i, root := range roots {
				list = append(list, map[string]any{"deal_id": fmt.Sprint(deal), "generation": fmt.Sprint(i + 1), "manifest_root": root.Bytes[:]})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"committed_height": "20", "generations": list})
			return
		}
		if r.URL.Path != fmt.Sprintf("/polystorechain/polystorechain/v1/deals/%d", deal) || r.Header.Get(committedHeightHeader) != "20" {
			t.Error("retention current query must match deal and committed height")
			http.Error(w, "bad query", 400)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"deal": map[string]any{"id": fmt.Sprint(deal), "current_gen": "99", "manifest_root": current.Bytes[:], "total_mdus": "2"}})
	}))
	old := lcdBase
	lcdBase = srv.URL
	t.Cleanup(func() { srv.Close(); lcdBase = old })
	return a
}

func TestGenerationRetentionKeepsChainReferencesAndLiveReaders(t *testing.T) {
	useTempUploadDir(t)
	const deal = 201
	a, b := mustTestManifestRoot(t, "retained-A"), mustTestManifestRoot(t, "current-B")
	oldDir := writeTestDealGeneration(t, deal, a, 2, false)
	writeTestDealGeneration(t, deal, b, 2, false)
	authority := useRetentionAuthority(t, deal, b, a)
	// A completed session remains in the chain inventory until expiry, and an
	// audit may retain that same root after the session reference is released.
	for range 2 {
		recoverDealGenerationStateOnStartup()
		if _, err := os.Stat(oldDir); err != nil {
			t.Fatal("restart discarded retained generation", err)
		}
	}
	_, release, err := openDealGeneration(deal, a, a.Canonical)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	active, err := readActiveDealGeneration(deal)
	if err != nil || active != b {
		t.Fatal("historical read promoted A over committed B", err)
	}
	authority.Lock()
	authority.retained = nil
	authority.Unlock()
	cleanupStaleDealGenerations(deal, a) // Even this stale hint cannot promote A.
	if _, err := os.Stat(oldDir); err != nil {
		t.Fatal("removed generation during active read", err)
	}
	release()
	cleanupInterruptedDealGenerations(deal)
	if _, err := os.Stat(oldDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("unreferenced generation was not collected", err)
	}
	active, err = readActiveDealGeneration(deal)
	if err != nil || active != b {
		t.Fatal("cleanup promoted caller hint", err)
	}
}

func TestGenerationRetentionAbstainsOnMalformedAuthority(t *testing.T) {
	useTempUploadDir(t)
	const deal = 202
	a, b := mustTestManifestRoot(t, "unknown-A"), mustTestManifestRoot(t, "unknown-B")
	oldDir := writeTestDealGeneration(t, deal, a, 2, false)
	writeTestDealGeneration(t, deal, b, 2, false)
	if err := writeActiveDealGeneration(deal, a); err != nil {
		t.Fatal(err)
	}
	authority := useRetentionAuthority(t, deal, b)
	for _, bad := range []string{`{}`, `null`, `{"committed_height":"20","generations":null}`, `{"committed_height":"20","generations":[]`, `{"committed_height":"19","generations":[]}`} {
		authority.Lock()
		authority.badBody = bad
		authority.Unlock()
		for _, cleanup := range []func(){func() { cleanupInterruptedDealGenerations(deal) }, func() { cleanupStaleDealGenerations(deal, b) }, recoverDealGenerationStateOnStartup} {
			cleanup()
			if _, err := os.Stat(oldDir); err != nil {
				t.Fatal("bad snapshot authorized deletion", bad, err)
			}
			active, err := readActiveDealGeneration(deal)
			if err != nil || active != a {
				t.Fatal("bad snapshot authorized promotion", bad, err)
			}
		}
	}
}

func TestGenerationRetentionInvalidatesReadAndRecreationDuringQuery(t *testing.T) {
	for _, recreate := range []bool{false, true} {
		t.Run(fmt.Sprint(recreate), func(t *testing.T) {
			useTempUploadDir(t)
			const deal = 203
			a, b := mustTestManifestRoot(t, "racing-A"), mustTestManifestRoot(t, "racing-B")
			dir := writeTestDealGeneration(t, deal, a, 2, false)
			writeTestDealGeneration(t, deal, b, 2, false)
			authority := useRetentionAuthority(t, deal, b)
			started, proceed := make(chan struct{}), make(chan struct{})
			authority.before = func() { close(started); <-proceed }
			done := make(chan error, 1)
			go func() { done <- reconcileDealGenerations(context.Background(), []uint64{deal}) }()
			<-started
			release, err := leaseGenerationPaths(dir)
			if err != nil {
				t.Fatal(err)
			}
			if recreate {
				if err := os.Rename(dir, dir+".saved"); err != nil {
					t.Fatal(err)
				}
				writeTestDealGeneration(t, deal, a, 2, false)
			}
			release() // Also invalidate a read that ended before the query returned.
			close(proceed)
			if err := <-done; err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(dir); err != nil {
				t.Fatal("stale collection decision removed live/recreated root", err)
			}
		})
	}
}

func TestImmutableArtifactRetryAndHardlinkPreservation(t *testing.T) {
	dir := t.TempDir()
	source, stored, linked := filepath.Join(dir, "source"), filepath.Join(dir, "stored"), filepath.Join(dir, "linked")
	if err := os.WriteFile(source, []byte("original"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := copyFile(source, linked); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(stored, []byte("conflict"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := copyFile(stored, linked); !errors.Is(err, os.ErrExist) {
		t.Fatal("copy truncated a shared inode", err)
	}
	if err := publishImmutableArtifact(stored, linked); !errors.Is(err, errGenerationConflict) {
		t.Fatal("accepted same-size corrupt retry", err)
	}
	if got, err := os.ReadFile(source); err != nil || !bytes.Equal(got, []byte("original")) {
		t.Fatal("old generation mutated", err)
	}
	if err := os.WriteFile(stored, []byte("original"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := publishImmutableArtifact(stored, linked); err != nil {
		t.Fatal("exact retry rejected", err)
	}
	if _, err := os.Stat(stored); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("retry temporary file leaked", err)
	}
}

func TestProviderUploadRetriesAuthenticateBytes(t *testing.T) {
	for _, tc := range []struct {
		name, path string
		size       int
		handler    http.HandlerFunc
	}{
		{"mdu", "mdu_0.bin", 8388608, SpUploadMdu},
		{"shard", "mdu_0_slot_0.bin", 4096, SpUploadShard},
		{"manifest", "manifest.bin", 131072, SpUploadManifest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			useTempUploadDir(t)
			resetPolyfsUploadRootPreflightCacheForTest()
			root := mustTestManifestRoot(t, "immutable-"+tc.name)
			srv := dynamicMockDealServer(map[uint64]struct{ Owner, CID string }{1: {Owner: "nil1owner", CID: ""}})
			old := lcdBase
			lcdBase = srv.URL
			t.Cleanup(func() { srv.Close(); lcdBase = old })
			for i, body := range [][]byte{{1, 2, 3}, {1, 2, 3}, {1, 2, 4}} {
				req := httptest.NewRequest(http.MethodPost, "/sp/upload_"+tc.name, bytes.NewReader(body))
				req.Header.Set("X-PolyStore-Deal-ID", "1")
				req.Header.Set("X-PolyStore-Mdu-Index", "0")
				req.Header.Set("X-PolyStore-Slot", "0")
				req.Header.Set("X-PolyStore-Manifest-Root", root.Canonical)
				req.Header.Set("X-PolyStore-Full-Size", strconv.Itoa(tc.size))
				w := httptest.NewRecorder()
				tc.handler(w, req)
				want := http.StatusOK
				if i == 2 {
					want = http.StatusConflict
				}
				if w.Code != want {
					t.Fatalf("retry %d: HTTP %d: %s", i, w.Code, w.Body.String())
				}
			}
			got, err := os.ReadFile(filepath.Join(dealScopedDir(1, root), tc.path))
			if err != nil || len(got) != tc.size || !bytes.Equal(got[:3], []byte{1, 2, 3}) {
				t.Fatal("conflicting retry changed stored bytes", err)
			}
		})
	}
}

func TestGenerationPublicationRejectsConcurrentStagedWriter(t *testing.T) {
	dir := t.TempDir()
	stage, final := filepath.Join(dir, "staging"), filepath.Join(dir, "final")
	if err := os.Mkdir(stage, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stage, "manifest.bin"), []byte("data"), 0o644); err != nil {
		t.Fatal(err)
	}
	release, err := leaseGenerationPaths(stage)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if err := publishImmutableGeneration(stage, final); err == nil {
		t.Fatal("published while an upload still owned its stage")
	}
	if _, err := os.Stat(stage); err != nil {
		t.Fatal("lost active stage", err)
	}
	release()
	if err := publishImmutableGeneration(stage, final); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(final, "manifest.bin")); err != nil {
		t.Fatal(err)
	}
}

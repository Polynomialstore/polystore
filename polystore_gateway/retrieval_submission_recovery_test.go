package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/cosmos/gogoproto/jsonpb"
	bolt "go.etcd.io/bbolt"
	"polystorechain/x/polystorechain/types"
)

func TestFrozenCommittedFailureRecovery(t *testing.T) {
	for _, mode := range []string{"immediate-single", "immediate-batch", "restart-batch", "legacy-unmarked-batch", "expired-batch"} {
		t.Run(mode, func(t *testing.T) {
			path := submissionTestDB(t)
			entries := []*frozenSubmission{}
			ids := []string{}
			responses := map[string]*types.QueryGetRetrievalSessionResponse{}
			original := map[string][]byte{}
			count := 2
			if mode == "immediate-single" {
				count = 1
			}
			for i := 1; i <= count; i++ {
				response, f, proofs := submissionFixture(t, byte(i))
				if err := storeFrozenSessionProof(f, proofs); err != nil {
					t.Fatal(err)
				}
				entry, err := loadFrozenSubmission(f)
				if err != nil {
					t.Fatal(err)
				}
				id := fmt.Sprintf("0x%x", f.Context.ID)
				entries, ids = append(entries, entry), append(ids, id)
				responses[id], original[id] = response, bytes.Clone(entry.raw)
			}
			signer := entries[0].frozen.Session.AuthorizedProofProvider
			failedHash := strings.Repeat("A", 64)
			restart := !strings.HasPrefix(mode, "immediate-")
			if restart {
				if err := changeFrozenSubmissions(entries, func(r *storedFrozenProof) {
					r.Submitting, r.TxHash = true, failedHash
				}, false, func(tx *bolt.Tx) error {
					if mode == "legacy-unmarked-batch" {
						return nil // Old committed-failure cleanup removed only the marker.
					}
					return claimPendingSigner(tx, signer, pendingSignerOperation{Kind: "retrieval", IDs: ids, TxHash: failedHash})
				}); err != nil {
					t.Fatal(err)
				}
			}
			reopen := func() {
				t.Helper()
				if err := closeSessionDB(); err != nil {
					t.Fatal(err)
				}
				if err := initSessionDB(path); err != nil {
					t.Fatal(err)
				}
			}
			reopen()
			var failed, expired atomic.Bool
			failed.Store(true)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.Contains(r.URL.Path, "retrieval-sessions/") {
					for _, id := range ids {
						if strings.HasSuffix(r.URL.Path, base64.URLEncoding.EncodeToString(responses[id].Session.SessionId)) {
							response := *responses[id]
							height := "12"
							if expired.Load() {
								response.Session.Status = types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_EXPIRED
								response.ChallengeSeed, height = nil, "100"
							}
							w.Header().Set(committedHeightHeader, height)
							_ = (&jsonpb.Marshaler{OrigName: true}).Marshal(w, &response)
							return
						}
					}
					http.Error(w, "unexpected session", 404)
					return
				}
				code := 0
				if failed.Load() {
					code = 9
				}
				hash := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
				fmt.Fprintf(w, `{"tx_response":{"txhash":%q,"height":"13","code":%d}}`, hash, code)
			}))
			defer server.Close()
			previous := lcdBase
			lcdBase = server.URL
			defer func() { lcdBase = previous }()
			commands := 0
			setupMockCombinedOutput(t, func(_ context.Context, _ string, args ...string) ([]byte, error) {
				if args[0] == "keys" {
					return []byte(signer), nil
				}
				commands++
				hash := failedHash
				if !failed.Load() {
					hash = strings.Repeat("B", 64)
				}
				return []byte(fmt.Sprintf(`{"txhash":%q,"code":0}`, hash)), nil
			})
			request := sessionProofRequest{SessionIDs: ids}
			if count == 1 {
				request = sessionProofRequest{SessionID: ids[0]}
			}
			body, _ := json.Marshal(request)
			got := invokeSubmission(string(body))
			wantCommands := 1
			if restart {
				wantCommands = 0
			}
			if got.Code != http.StatusConflict || commands != wantCommands || !strings.Contains(got.Body.String(), failedHash) {
				t.Fatal("failed transaction did not reconcile without retry", got.Code, got.Body.String(), commands)
			}
			reopen()
			for i, entry := range entries {
				stored, err := loadFrozenSubmission(entry.frozen)
				if err != nil || !bytes.Equal(stored.raw, original[ids[i]]) {
					t.Fatalf("resolved failure must restore only submission fields, preserving exact proof authority: %v", err)
				}
			}
			if marker, err := loadPendingSigner(signer); err != nil || marker != nil {
				t.Fatal("resolved failure retained signer quarantine", marker, err)
			}
			if mode == "expired-batch" {
				expired.Store(true)
				for _, entry := range entries {
					if err := cleanupFrozenSessionProof(context.Background(), frozenProofKey(entry.frozen.Context.ID)); err != nil {
						t.Fatal("resolved record remained ineligible for terminal cleanup", err)
					}
				}
			} else {
				failed.Store(false)
				got = invokeSubmission(string(body))
				if got.Code != http.StatusOK || commands != wantCommands+1 {
					t.Fatal("caller could not retry the same sessions", got.Code, got.Body.String(), commands)
				}
			}
			for _, entry := range entries {
				if _, err := loadFrozenSubmission(entry.frozen); !errors.Is(err, os.ErrNotExist) {
					t.Fatal("resolved proof not cleaned", err)
				}
			}
		})
	}
}

func TestFrozenCommittedFailureRecoveryAtomicity(t *testing.T) {
	for _, mode := range []string{"different-marker-hash", "unknown-marker-hash", "different-marker-ids", "audit-marker", "malformed-marker", "unknown-record-hash", "different-record-hash", "changed-second-record"} {
		t.Run(mode, func(t *testing.T) {
			submissionTestDB(t)
			var entries []*frozenSubmission
			var ids []string
			hash := strings.Repeat("A", 64)
			for i := 1; i <= 2; i++ {
				_, f, proofs := submissionFixture(t, byte(i))
				if err := storeFrozenSessionProof(f, proofs); err != nil {
					t.Fatal(err)
				}
				entry, err := loadFrozenSubmission(f)
				if err != nil {
					t.Fatal(err)
				}
				entries = append(entries, entry)
				ids = append(ids, fmt.Sprintf("0x%x", f.Context.ID))
			}
			signer := entries[0].frozen.Session.AuthorizedProofProvider
			marker := pendingSignerOperation{Kind: "retrieval", IDs: ids, TxHash: hash}
			switch mode {
			case "different-marker-hash":
				marker.TxHash = strings.Repeat("B", 64)
			case "unknown-marker-hash":
				marker.TxHash = ""
			case "different-marker-ids":
				marker.IDs = []string{ids[1], ids[0]}
			case "audit-marker":
				marker.Kind = "audit"
			}
			markerRaw, _ := json.Marshal(marker)
			if mode == "malformed-marker" {
				markerRaw = []byte(`{"kind":`)
			}
			if err := changeFrozenSubmissions(entries, func(r *storedFrozenProof) {
				r.Submitting, r.TxHash = true, hash
				if mode == "unknown-record-hash" {
					r.TxHash = ""
				} else if mode == "different-record-hash" {
					r.TxHash = strings.Repeat("B", 64)
				}
			}, false, func(tx *bolt.Tx) error {
				return tx.Bucket(onChainSessionProofsBucket).Put(pendingSignerKey(signer), markerRaw)
			}); err != nil {
				t.Fatal(err)
			}
			if mode == "changed-second-record" {
				// A concurrent durable change after the caller loaded its batch must
				// roll back the first record's reset, too.
				fresh, err := loadFrozenSubmission(entries[1].frozen)
				if err != nil {
					t.Fatal(err)
				}
				if err := changeFrozenSubmissions([]*frozenSubmission{fresh}, func(r *storedFrozenProof) {
					r.TxHash = strings.Repeat("B", 64)
				}, false); err != nil {
					t.Fatal(err)
				}
			}
			var before [][]byte
			for _, entry := range entries {
				stored, err := loadFrozenSubmission(entry.frozen)
				if err != nil {
					t.Fatal(err)
				}
				before = append(before, bytes.Clone(stored.raw))
			}
			if err := resetFailedFrozenSubmissions(entries, signer, ids, hash); err == nil {
				t.Fatal("uncertain or inconsistent submission was reset")
			}
			for i, entry := range entries {
				stored, err := loadFrozenSubmission(entry.frozen)
				if err != nil || !bytes.Equal(stored.raw, before[i]) {
					t.Fatal("failed recovery partially reset batch", i, err)
				}
			}
			if err := sessionDB.View(func(tx *bolt.Tx) error {
				if !bytes.Equal(tx.Bucket(onChainSessionProofsBucket).Get(pendingSignerKey(signer)), markerRaw) {
					return errors.New("failed recovery changed signer marker")
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
		})
	}
}

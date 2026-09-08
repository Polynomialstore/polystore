package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/cosmos/gogoproto/jsonpb"
	bolt "go.etcd.io/bbolt"
	"polystorechain/x/polystorechain/types"
)

type proofCleanupTransport func(*http.Request) (*http.Response, error)

func (f proofCleanupTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func cleanupTestAuthority(t *testing.T, response *types.QueryGetRetrievalSessionResponse, height string, before func()) {
	t.Helper()
	oldClient, oldChain := lcdHTTPClient, chainID
	chainID = response.Session.ChallengeSnapshot.ChainId
	lcdHTTPClient = &http.Client{Transport: proofCleanupTransport(func(r *http.Request) (*http.Response, error) {
		if before != nil {
			before()
		}
		var body bytes.Buffer
		if err := (&jsonpb.Marshaler{OrigName: true}).Marshal(&body, response); err != nil {
			t.Fatal(err)
		}
		header := make(http.Header)
		if height != "" {
			header.Set(committedHeightHeader, height)
		}
		return &http.Response{StatusCode: 200, Header: header, Body: io.NopCloser(&body), Request: r}, nil
	})}
	t.Cleanup(func() { lcdHTTPClient, chainID = oldClient, oldChain })
}

func frozenProofExists(t *testing.T, key []byte) bool {
	t.Helper()
	var exists bool
	if err := sessionDB.View(func(tx *bolt.Tx) error { exists = tx.Bucket(onChainSessionProofsBucket).Get(key) != nil; return nil }); err != nil {
		t.Fatal(err)
	}
	return exists
}

func TestFrozenProofCleanupAdmissionBound(t *testing.T) {
	submissionTestDB(t)
	_, f, proofs := submissionFixture(t, 1)
	if err := storeFrozenSessionProof(f, proofs); err != nil {
		t.Fatal(err)
	}
	// Even corrupt/uncertain records occupy capacity until safe cleanup; no
	// authority outage can allow new sessions to grow the bucket indefinitely.
	if err := sessionDB.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(onChainSessionProofsBucket)
		for i := uint64(0); i < types.MaxLiveRetrievalSessionContexts-1; i++ {
			if err := b.Put([]byte(fmt.Sprintf("v2:%064x", i)), []byte("{bad")); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := storeFrozenSessionProof(f, proofs); err != nil {
		t.Fatalf("existing proof retry blocked at capacity: %v", err)
	}
	next := *f
	next.Context.ID[0]++
	if err := storeFrozenSessionProof(&next, proofs); err == nil || !strings.Contains(err.Error(), "capacity reached") {
		t.Fatalf("new record escaped capacity bound: %v", err)
	}
	if frozenProofExists(t, frozenProofKey(next.Context.ID)) {
		t.Fatal("rejected insertion mutated the bucket")
	}
	if err := sessionDB.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(onChainSessionProofsBucket).Delete(frozenProofKey(f.Context.ID))
	}); err != nil {
		t.Fatal(err)
	}
	if err := storeFrozenSessionProof(&next, proofs); err != nil {
		t.Fatalf("reclaimed capacity remained blocked: %v", err)
	}
}

func TestFrozenProofCleanupAbandonedAfterRestart(t *testing.T) {
	for _, state := range []types.RetrievalSessionStatus{
		types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_COMPLETED,
		types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_CANCELED,
		types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_EXPIRED,
		types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_OPEN,
	} {
		t.Run(state.String(), func(t *testing.T) {
			path := submissionTestDB(t)
			response, f, proofs := submissionFixture(t, 1)
			if err := storeFrozenSessionProof(f, proofs); err != nil {
				t.Fatal(err)
			}
			if err := closeSessionDB(); err != nil {
				t.Fatal(err)
			}
			if err := initSessionDB(path); err != nil {
				t.Fatal(err)
			}
			response.Session.Status = state
			response.ChallengeSeed = nil // Terminal cleanup must work after anchor pruning.
			height := "12"
			if state == types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_OPEN || state == types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_EXPIRED {
				height = fmt.Sprint(f.Context.Window.Deadline + 1)
			}
			cleanupTestAuthority(t, response, height, nil)
			if _, err := cleanupFrozenSessionProofs(context.Background(), nil); err != nil {
				t.Fatal(err)
			}
			if frozenProofExists(t, frozenProofKey(f.Context.ID)) {
				t.Fatal("abandoned terminal or expired proof survived maintenance")
			}
		})
	}
}

func TestFrozenProofCleanupPreservesUncertainAndBusy(t *testing.T) {
	for _, mode := range []string{"live", "at-deadline", "submitting", "known-hash", "missing-height", "wrong-context", "wrong-record", "corrupt", "not-found", "unavailable", "malformed", "busy", "canceled-pass"} {
		t.Run(mode, func(t *testing.T) {
			submissionTestDB(t)
			response, f, proofs := submissionFixture(t, 1)
			if err := storeFrozenSessionProof(f, proofs); err != nil {
				t.Fatal(err)
			}
			height := fmt.Sprint(f.Context.Window.Deadline + 1)
			switch mode {
			case "live":
				height = "12"
			case "at-deadline":
				height = fmt.Sprint(f.Context.Window.Deadline)
			case "missing-height":
				height = ""
			case "wrong-context":
				response.ChallengeContextHash = bytes.Repeat([]byte{9}, 32)
			case "submitting", "known-hash", "wrong-record", "corrupt":
				entry, err := loadFrozenSubmission(f)
				if err != nil {
					t.Fatal(err)
				}
				if err := changeFrozenSubmissions([]*frozenSubmission{entry}, func(p *storedFrozenProof) {
					if mode == "submitting" {
						p.Submitting = true
					} else if mode == "known-hash" {
						p.TxHash = strings.Repeat("A", 64)
					} else if mode == "wrong-record" {
						p.Hash = bytes.Repeat([]byte{9}, 32)
					}
				}, false); err != nil {
					t.Fatal(err)
				}
				if mode == "corrupt" {
					if err := sessionDB.Update(func(tx *bolt.Tx) error {
						return tx.Bucket(onChainSessionProofsBucket).Put(frozenProofKey(f.Context.ID), []byte("{bad"))
					}); err != nil {
						t.Fatal(err)
					}
				}
			}
			if mode == "busy" {
				release, err := claimRetrievalOperations([]string{"0x" + hex.EncodeToString(f.Context.ID[:])}, "")
				if err != nil {
					t.Fatal(err)
				}
				defer release()
			}
			queries := 0
			cleanupTestAuthority(t, response, height, func() { queries++ })
			if mode == "not-found" || mode == "unavailable" || mode == "malformed" {
				lcdHTTPClient.Transport = proofCleanupTransport(func(r *http.Request) (*http.Response, error) {
					status := 200
					if mode == "not-found" {
						status = 404
					} else if mode == "unavailable" {
						status = 503
					}
					return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader("{bad")), Request: r}, nil
				})
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if mode == "canceled-pass" {
				cancel()
			}
			_, _ = cleanupFrozenSessionProofs(ctx, nil)
			if !frozenProofExists(t, frozenProofKey(f.Context.ID)) {
				t.Fatal("uncertain or active proof was deleted")
			}
			if (mode == "busy" || mode == "canceled-pass") && queries != 0 {
				t.Fatal("queried despite busy session or canceled pass")
			}
		})
	}
}

func TestFrozenProofCleanupBoundedCursorAndOperationGuard(t *testing.T) {
	submissionTestDB(t)
	response, f, proofs := submissionFixture(t, 1)
	// Put terminal work after one full batch of corrupt records. None may starve it.
	response.Session.SessionId = bytes.Repeat([]byte{255}, 32)
	c, err := types.RetrievalChallengeContext(response.Session)
	if err != nil {
		t.Fatal(err)
	}
	response.ChallengeContext, _ = c.Bytes()
	hash, _ := c.Hash()
	response.ChallengeContextHash = hash[:]
	f, err = frozenRetrievalIdentity(response, 12)
	if err != nil {
		t.Fatal(err)
	}
	copy(f.Seed[:], response.ChallengeSeed)
	if err := storeFrozenSessionProof(f, proofs); err != nil {
		t.Fatal(err)
	}
	marker := []byte(`{"kind":"retrieval","ids":["unresolved"]}`)
	if err := sessionDB.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(onChainSessionProofsBucket)
		for i := 0; i < maxFrozenProofsPerPass; i++ {
			if err := b.Put([]byte(fmt.Sprintf("v2:%064x", i)), []byte("{bad")); err != nil {
				return err
			}
		}
		return b.Put(pendingSignerKey("preserve"), marker)
	}); err != nil {
		t.Fatal(err)
	}
	response.Session.Status = types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_COMPLETED
	id := "0x" + hex.EncodeToString(f.Context.ID[:])
	queries := 0
	cleanupTestAuthority(t, response, "12", func() {
		queries++
		if release, err := claimRetrievalOperations([]string{id}, ""); err == nil {
			release()
			t.Fatal("serving could enter while cleanup owns session")
		}
	})
	cursor, _ := cleanupFrozenSessionProofs(context.Background(), nil)
	if len(cursor) == 0 || !frozenProofExists(t, frozenProofKey(f.Context.ID)) {
		t.Fatal("first pass exceeded its bounded scan")
	}
	_, err = cleanupFrozenSessionProofs(context.Background(), cursor)
	if err != nil {
		t.Fatal(err)
	}
	if frozenProofExists(t, frozenProofKey(f.Context.ID)) {
		t.Fatal("earlier corrupt records starved terminal cleanup")
	}
	if queries > maxFrozenProofsPerPass+1 {
		t.Fatal("unbounded authority queries")
	}
	if err := sessionDB.View(func(tx *bolt.Tx) error {
		got := tx.Bucket(onChainSessionProofsBucket).Get(pendingSignerKey("preserve"))
		if !bytes.Equal(got, marker) || !json.Valid(got) {
			t.Fatal("unresolved signer marker changed")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

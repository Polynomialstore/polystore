package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	sdkmath "cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/gogoproto/jsonpb"
	"polystorechain/x/polystorechain/types"
)

func TestRetrievalQueryRejectsWrongSessionAndLossyFields(t *testing.T) {
	id := strings.Repeat("01", 32)
	encoded := base64.StdEncoding.EncodeToString([]byte(strings.Repeat("\x01", 32)))
	root := base64.StdEncoding.EncodeToString(make([]byte, 32))
	valid := fmt.Sprintf(`{"session":{"session_id":%q,"deal_id":"9007199254740993","owner":"owner","provider":"provider","manifest_root":%q,"start_mdu_index":"2","start_blob_index":0,"blob_count":"1","total_bytes":"131072","nonce":"1","expires_at":"100","opened_height":"1","updated_height":"1","status":"RETRIEVAL_SESSION_STATUS_OPEN"}}`, encoded, root)
	body := valid
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(body)) }))
	defer srv.Close()
	old := lcdBase
	lcdBase = srv.URL
	t.Cleanup(func() { lcdBase = old })
	s, err := fetchRetrievalSession(id)
	if err != nil || s.DealId != 9007199254740993 {
		t.Fatalf("lossless valid query: %v %+v", err, s)
	}
	for _, tc := range []struct{ name, body string }{
		{"wrong id", strings.Replace(valid, encoded, root, 1)},
		{"fraction", strings.Replace(valid, `"start_blob_index":0`, `"start_blob_index":0.5`, 1)},
		{"narrowing", strings.Replace(valid, `"start_blob_index":0`, `"start_blob_index":4294967296`, 1)},
		{"unknown status", strings.Replace(valid, "RETRIEVAL_SESSION_STATUS_OPEN", "FUTURE_STATUS", 1)},
		{"trailing", valid + ` {}`},
		{"zero height", strings.Replace(valid, `"opened_height":"1"`, `"opened_height":"0"`, 1)},
		{"over bound", valid + strings.Repeat(" ", 65536)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body = tc.body
			if _, err := fetchRetrievalSession(id); err == nil {
				t.Fatal("accepted malformed authority")
			}
		})
	}
}

func testFrozenSession(t *testing.T) types.QueryGetRetrievalSessionResponse {
	t.Helper()
	setup, _ := hex.DecodeString(types.RetrievalSetupDigest)
	provider := sdk.AccAddress(bytes.Repeat([]byte{2}, 20)).String()
	payee := sdk.AccAddress(bytes.Repeat([]byte{3}, 20)).String()
	s := types.RetrievalSession{SessionId: bytes.Repeat([]byte{1}, 32), DealId: 9007199254740993,
		Owner: sdk.AccAddress(bytes.Repeat([]byte{4}, 20)).String(), Provider: provider, AuthorizedProofProvider: payee,
		Purpose: types.RetrievalSessionPurpose_RETRIEVAL_SESSION_PURPOSE_USER, Funding: types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_DEAL_ESCROW, LockedFee: sdkmath.NewInt(2),
		ManifestRoot: bytes.Repeat([]byte{5}, 32), StartMduIndex: 2, StartBlobIndex: 8, BlobCount: 2, TotalBytes: 2 * types.BlobSizeBytes,
		OpenedHeight: 10, UpdatedHeight: 10, ExpiresAt: 50, Status: types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_OPEN, ChallengeVersion: 2,
		ChallengeSnapshot: &types.RetrievalChallengeSnapshot{ChainId: chainID, SetupDigest: setup, Generation: 7, Layout: 2, K: 8, M: 4, Slot: 1, MetadataMdus: 2, UserMdus: 1, DealEnd: 100},
	}
	c, err := types.RetrievalChallengeContext(s)
	if err != nil {
		t.Fatal(err)
	}
	contextBytes, _ := c.Bytes()
	hash, _ := c.Hash()
	return types.QueryGetRetrievalSessionResponse{Session: s, ChallengeContext: contextBytes, ChallengeContextHash: hash[:], ChallengeSeed: bytes.Repeat([]byte{6}, 32)}
}

func TestFrozenSessionRequiresCommittedCanonicalAuthority(t *testing.T) {
	r := testFrozenSession(t)
	height := "12"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if height != "" {
			w.Header().Set(committedHeightHeader, height)
		}
		if err := (&jsonpb.Marshaler{OrigName: true}).Marshal(w, &r); err != nil {
			t.Error(err)
		}
	}))
	defer srv.Close()
	old := lcdBase
	lcdBase = srv.URL
	t.Cleanup(func() { lcdBase = old })
	id := hex.EncodeToString(r.Session.SessionId)
	f, err := fetchFrozenRetrievalSession(context.Background(), id)
	if err != nil || f.Context.DealID != 9007199254740993 || f.Session.Provider == f.Session.AuthorizedProofProvider {
		t.Fatalf("valid deputy session: %+v %v", f, err)
	}
	for _, tc := range []struct {
		name   string
		mutate func()
	}{
		{"no height", func() { height = "" }},
		{"zero height", func() { height = "0" }},
		{"state newer than query", func() { height = "9" }},
		{"wrong chain", func() { r.Session.ChallengeSnapshot.ChainId = "different" }},
		{"changed payee", func() { r.Session.AuthorizedProofProvider = r.Session.Provider }},
		{"changed root", func() { r.Session.ManifestRoot[0] ^= 1 }},
		{"changed context", func() { r.ChallengeContext[0] ^= 1 }},
		{"changed hash", func() { r.ChallengeContextHash[0] ^= 1 }},
		{"missing anchored seed", func() { r.ChallengeSeed = nil }},
		{"malformed seed", func() { r.ChallengeSeed = r.ChallengeSeed[:31] }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r = testFrozenSession(t)
			height = "12"
			tc.mutate()
			if _, err := fetchFrozenRetrievalSession(context.Background(), id); err == nil {
				t.Fatal("accepted invalid frozen authority")
			}
		})
	}
	r = testFrozenSession(t)
	r.ChallengeSeed = nil
	height = "10"
	if _, err := fetchFrozenRetrievalSession(context.Background(), id); !errors.Is(err, errChallengeNotReady) {
		t.Fatalf("before anchor: %v", err)
	}
	r = testFrozenSession(t)
	height = "11"
	if _, err := fetchFrozenRetrievalSession(context.Background(), id); !errors.Is(err, errChallengeNotReady) {
		t.Fatalf("before first response: %v", err)
	}
}

func TestRetentionSnapshotPinsWholeInventoryAndCurrentRoots(t *testing.T) {
	rootA := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 32))
	rootB := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{2}, 32))
	tuple := fmt.Sprintf(`{"deal_id":"9007199254740993","generation":"7","manifest_root":%q}`, rootA)
	valid := `{"committed_height":"20","generations":[` + tuple + `]}`
	body := valid
	header := "20"
	currentHeader := "20"
	currentRoot := rootB
	currentGen := "8"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "retained-generations") {
			w.Header().Set(committedHeightHeader, header)
			_, _ = w.Write([]byte(body))
			return
		}
		if r.Header.Get(committedHeightHeader) != "20" {
			t.Error("current root not pinned to inventory height")
		}
		w.Header().Set(committedHeightHeader, currentHeader)
		_, _ = fmt.Fprintf(w, `{"deal":{"id":"9007199254740993","manifest_root":%q,"current_gen":%q,"total_mdus":"3","witness_mdus":"1"}}`, currentRoot, currentGen)
	}))
	defer srv.Close()
	old := lcdBase
	lcdBase = srv.URL
	t.Cleanup(func() { lcdBase = old })
	ids := []uint64{9007199254740993}
	s, err := fetchRetentionSnapshot(context.Background(), ids)
	if err != nil || s.Height != 20 || len(s.Keep) != 2 {
		t.Fatalf("retained old and current new union: %+v %v", s, err)
	}
	for _, tc := range []struct{ name, body string }{
		{"null", `null`}, {"missing", `{"committed_height":"20"}`}, {"null list", `{"committed_height":"20","generations":null}`},
		{"partial", valid[:len(valid)-1]}, {"trailing", valid + `{}`},
		{"duplicates", `{"committed_height":"20","generations":[` + tuple + `,` + tuple + `]}`},
		{"over limit", `{"committed_height":"20","generations":[` + strings.Repeat(tuple+",", int(maxRetainedGenerations)) + tuple + `]}`},
		{"wrong height", strings.Replace(valid, `"20"`, `"19"`, 1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body = tc.body
			if _, err := fetchRetentionSnapshot(context.Background(), ids); err == nil {
				t.Fatal("accepted incomplete retention authority")
			}
		})
	}
	body = valid
	currentHeader = "21"
	if _, err := fetchRetentionSnapshot(context.Background(), ids); err == nil {
		t.Fatal("accepted mixed-height current root")
	}
	currentHeader = "20"
	currentGen = "7"
	if _, err := fetchRetentionSnapshot(context.Background(), ids); err == nil {
		t.Fatal("accepted conflicting root for same generation")
	}
	currentGen = "8"
	body = `{"committed_height":"20","generations":[]}`
	if s, err := fetchRetentionSnapshot(context.Background(), ids); err != nil || len(s.Keep) != 1 {
		t.Fatalf("explicit empty inventory with current root: %v", err)
	}
	header = ""
	if _, err := fetchRetentionSnapshot(context.Background(), ids); err == nil {
		t.Fatal("accepted missing committed height")
	}
}

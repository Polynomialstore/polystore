package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/gogoproto/jsonpb"
	bolt "go.etcd.io/bbolt"
	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/types"
)

// Shared native/browser C5 bytes. Only challenge-dependent openings are rebuilt
// when a different owner/deal/session is requested; structural witnesses stay fixed.
func submissionFixture(t *testing.T, identity byte) (*types.QueryGetRetrievalSessionResponse, *frozenRetrievalSession, []types.ChainedProof) {
	t.Helper()
	if err := crypto_ffi.Init(trustedSetup); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile("../testdata/retrieval-window-v2/session.json")
	if err != nil {
		t.Fatal(err)
	}
	var response types.QueryGetRetrievalSessionResponse
	if err := jsonpb.Unmarshal(bytes.NewReader(raw), &response); err != nil {
		t.Fatal(err)
	}
	raw, err = os.ReadFile("../testdata/retrieval-window-v2/metadata.json")
	if err != nil {
		t.Fatal(err)
	}
	var metadata retrievalWindowMetadata
	if err := json.Unmarshal(raw, &metadata); err != nil {
		t.Fatal(err)
	}
	if identity != 1 {
		response.Session.SessionId = bytes.Repeat([]byte{identity}, 32)
		response.Session.DealId += uint64(identity)
		response.Session.Owner = sdk.AccAddress(bytes.Repeat([]byte{identity + 10}, 20)).String()
		c, err := types.RetrievalChallengeContext(response.Session)
		if err != nil {
			t.Fatal(err)
		}
		response.ChallengeContext, _ = c.Bytes()
		h, _ := c.Hash()
		response.ChallengeContextHash = h[:]
		challenges, err := c.Challenges(response.ChallengeSeed)
		if err != nil {
			t.Fatal(err)
		}
		window, err := os.ReadFile("../testdata/retrieval-window-v2/window.bin")
		if err != nil {
			t.Fatal(err)
		}
		for i, ch := range challenges {
			opening, y, err := crypto_ffi.ComputeBlobProof(window[i*types.BLOB_SIZE:(i+1)*types.BLOB_SIZE], ch.Z[:])
			if err != nil {
				t.Fatal(err)
			}
			metadata.Proofs[i].ZValue, metadata.Proofs[i].YValue, metadata.Proofs[i].KzgOpeningProof = ch.Z[:], y, opening
		}
	}
	f, err := freezeRetrievalSessionResponse(&response, 12)
	if err != nil {
		t.Fatal(err)
	}
	return &response, f, metadata.Proofs
}

func submissionTestDB(t *testing.T) string {
	t.Helper()
	useTempUploadDir(t)
	previous := sessionDB
	sessionDB = nil
	path := filepath.Join(t.TempDir(), "sessions.db")
	if err := initSessionDB(path); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = closeSessionDB(); sessionDB = previous })
	return path
}

func invokeSubmission(body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest("POST", "/sp/session-proof", strings.NewReader(body))
	request.Header.Set(gatewayAuthHeader, gatewayToProviderAuthToken())
	recorder := httptest.NewRecorder()
	SpSubmitRetrievalSessionProof(recorder, request)
	return recorder
}

func invokeContinuation(body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest("POST", "/sp/retrieval/session-proof/continue", strings.NewReader(body))
	recorder := httptest.NewRecorder()
	SpContinueRetrievalSessionProof(recorder, request)
	return recorder
}

type deadlineRecorder struct {
	*httptest.ResponseRecorder
	active    time.Time
	deadlines []time.Time
}

func (w *deadlineRecorder) SetReadDeadline(deadline time.Time) error {
	w.active = deadline
	w.deadlines = append(w.deadlines, deadline)
	return nil
}

type deadlineRequiredReader struct {
	w       *deadlineRecorder
	reader  *strings.Reader
	checked bool
}

func (r *deadlineRequiredReader) Read(p []byte) (int, error) {
	if r.w.active.IsZero() {
		return 0, errors.New("request body read before deadline was installed")
	}
	r.checked = true
	return r.reader.Read(p)
}

func TestPublicContinuationBoundsBodyRead(t *testing.T) {
	for _, tc := range []struct {
		name    string
		path    string
		handler http.HandlerFunc
	}{
		{"provider", "/sp/retrieval/session-proof/continue", SpContinueRetrievalSessionProof},
		{"gateway", "/gateway/retrieval/session-proof/continue", RouterGatewayContinueRetrievalSessionProof},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := &deadlineRecorder{ResponseRecorder: httptest.NewRecorder()}
			body := &deadlineRequiredReader{w: w, reader: strings.NewReader(`{}`)}
			request := httptest.NewRequest(http.MethodPost, tc.path, body)
			started := time.Now()
			tc.handler(w, request)
			if w.Code != http.StatusBadRequest || !body.checked {
				t.Fatalf("continuation did not read malformed body under deadline: status=%d checked=%v body=%s", w.Code, body.checked, w.Body.String())
			}
			if len(w.deadlines) != 2 || w.deadlines[0].Before(started) || w.deadlines[0].After(started.Add(publicContinuationBodyTimeout+time.Second)) || !w.deadlines[1].IsZero() {
				t.Fatalf("unexpected request body deadlines: %v", w.deadlines)
			}
		})
	}
}

type gatedBodyReader struct {
	reader  *strings.Reader
	entered chan<- struct{}
	release <-chan struct{}
	started bool
}

func (r *gatedBodyReader) Read(p []byte) (int, error) {
	if !r.started {
		r.started = true
		r.entered <- struct{}{}
		<-r.release
	}
	return r.reader.Read(p)
}

func TestPublicContinuationBodyReadsDoNotConsumeSubmissionSlots(t *testing.T) {
	for _, tc := range []struct {
		name    string
		path    string
		handler http.HandlerFunc
	}{
		{"provider", "/sp/retrieval/session-proof/continue", SpContinueRetrievalSessionProof},
		{"gateway", "/gateway/retrieval/session-proof/continue", RouterGatewayContinueRetrievalSessionProof},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := len(publicRetrievalContinuations); got != 0 {
				t.Fatalf("continuation slots already occupied: %d", got)
			}
			entered := make(chan struct{}, cap(publicRetrievalContinuations))
			releaseBodies := make(chan struct{})
			done := make(chan *httptest.ResponseRecorder, cap(publicRetrievalContinuations))
			for i := 0; i < cap(publicRetrievalContinuations); i++ {
				body := &gatedBodyReader{reader: strings.NewReader(`{}`), entered: entered, release: releaseBodies}
				request := httptest.NewRequest(http.MethodPost, tc.path, body)
				go func() {
					w := httptest.NewRecorder()
					tc.handler(w, request)
					done <- w
				}()
			}
			for i := 0; i < cap(publicRetrievalContinuations); i++ {
				select {
				case <-entered:
				case <-time.After(time.Second):
					t.Fatal("continuation did not start reading request body")
				}
			}
			releaseSlot, err := claimPublicRetrievalContinuation()
			if err != nil {
				close(releaseBodies)
				t.Fatalf("blocked request bodies consumed continuation slots: %v", err)
			}
			releaseSlot()
			close(releaseBodies)
			for i := 0; i < cap(publicRetrievalContinuations); i++ {
				select {
				case w := <-done:
					if w.Code != http.StatusBadRequest {
						t.Fatalf("malformed continuation status=%d body=%s", w.Code, w.Body.String())
					}
				case <-time.After(time.Second):
					t.Fatal("continuation did not finish after body release")
				}
			}
		})
	}
}

func TestSessionProofRequestDiscriminationAndBounds(t *testing.T) {
	id := "0x" + strings.Repeat("ab", 32)
	for _, body := range []string{
		`{}`, `null`, `{"session_ids":null}`, `{"session_ids":[]}`,
		fmt.Sprintf(`{"session_id":%q,"session_ids":[%q]}`, id, id),
		fmt.Sprintf(`{"session_id":%q,"session_id":%q}`, id, id),
		fmt.Sprintf(`{"session_ids":[%q,%q]}`, id, strings.ToUpper(id[2:])),
		fmt.Sprintf(`{"session_id":%q} {}`, id), `{"session_id":"0xabc"}`,
		fmt.Sprintf(`{"session_id":%q,"proofs":[]}`, id),
		fmt.Sprintf(`{"session_ids":[%s]}`, strings.TrimSuffix(strings.Repeat(fmt.Sprintf("%q,", id), 65), ",")),
		fmt.Sprintf(`{"session_id":%q,"provider":%q}`, id, strings.Repeat("p", maxSessionProofRequestBytes)),
		"{\"session_id\":\"\xff\"}",
	} {
		if _, _, _, err := readSessionProofRequest(strings.NewReader(body)); err == nil {
			t.Fatalf("accepted invalid request: %.100s", body)
		}
	}
	for _, body := range []string{fmt.Sprintf(`{"session_id":%q}`, id), fmt.Sprintf(`{"session_ids":[%q]}`, id)} {
		raw, _, ids, err := readSessionProofRequest(strings.NewReader(body))
		if err != nil || string(raw) != body || len(ids) != 1 || ids[0] != id {
			t.Fatal(ids, err)
		}
	}
}

func TestConfirmedSessionContinuationIsExactAndACKGated(t *testing.T) {
	id := "0x" + strings.Repeat("ab", 32)
	for _, body := range []string{
		`{}`, `null`, fmt.Sprintf(`{"session_ids":[%q]}`, id),
		fmt.Sprintf(`{"session_id":%q,"provider":"nil1route"}`, id),
		fmt.Sprintf(`{"session_id":%q,"deal_id":1}`, id),
	} {
		if _, _, _, err := readConfirmedSessionProofRequest(strings.NewReader(body)); err == nil {
			t.Fatalf("accepted non-exact continuation: %s", body)
		}
	}

	submissionTestDB(t)
	response, frozen, proofs := submissionFixture(t, 1)
	if err := storeFrozenSessionProof(frozen, proofs); err != nil {
		t.Fatal(err)
	}
	id = "0x" + hex.EncodeToString(frozen.Context.ID[:])
	body := fmt.Sprintf(`{"session_id":%q}`, id)
	hash := strings.Repeat("D", 64)
	txCommands := 0
	setupMockCombinedOutput(t, func(_ context.Context, _ string, args ...string) ([]byte, error) {
		if args[0] == "keys" {
			return []byte(response.Session.AuthorizedProofProvider), nil
		}
		txCommands++
		return []byte(fmt.Sprintf(`{"txhash":%q,"code":0}`, hash)), nil
	})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "retrieval-sessions/") {
			w.Header().Set(committedHeightHeader, "12")
			_ = (&jsonpb.Marshaler{OrigName: true}).Marshal(w, response)
			return
		}
		fmt.Fprintf(w, `{"tx_response":{"txhash":%q,"height":"13","code":0}}`, hash)
	}))
	defer server.Close()
	oldLCD := lcdBase
	lcdBase = server.URL
	defer func() { lcdBase = oldLCD }()

	for _, status := range []types.RetrievalSessionStatus{
		types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_OPEN,
		types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_PROOF_SUBMITTED,
	} {
		response.Session.Status = status
		got := invokeContinuation(body)
		if got.Code != http.StatusConflict || txCommands != 0 || !strings.Contains(got.Body.String(), "owner confirmation") {
			t.Fatalf("status %s was not rejected before signing: %d %s commands=%d", status, got.Code, got.Body.String(), txCommands)
		}
	}
	response.Session.Status = types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_USER_CONFIRMED
	response.Session.ChallengeVersion = 0
	if got := invokeContinuation(body); got.Code != http.StatusConflict || txCommands != 0 {
		t.Fatalf("non-v2 continuation reached signing: %d %s commands=%d", got.Code, got.Body.String(), txCommands)
	}
	response.Session.ChallengeVersion = 2
	got := invokeContinuation(body)
	if got.Code != http.StatusOK || txCommands != 1 || !strings.Contains(got.Body.String(), hash) {
		t.Fatalf("confirmed continuation failed: %d %s commands=%d", got.Code, got.Body.String(), txCommands)
	}
}

func TestPublicContinuationBoundsKeyLookupsBeforeSessionAdmission(t *testing.T) {
	server := httptest.NewServer(http.NotFoundHandler())
	defer server.Close()
	oldLCD := lcdBase
	lcdBase = server.URL
	defer func() { lcdBase = oldLCD }()

	entered := make(chan struct{}, cap(publicRetrievalContinuations))
	release := make(chan struct{})
	var lookups atomic.Int32
	var unexpectedCommands atomic.Int32
	setupMockCombinedOutput(t, func(_ context.Context, _ string, args ...string) ([]byte, error) {
		if args[0] != "keys" {
			unexpectedCommands.Add(1)
			return nil, fmt.Errorf("unexpected transaction command before session admission: %v", args)
		}
		lookups.Add(1)
		entered <- struct{}{}
		<-release
		return []byte("nil1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqnrql8a"), nil
	})

	done := make(chan *httptest.ResponseRecorder, cap(publicRetrievalContinuations))
	for i := 0; i < cap(publicRetrievalContinuations); i++ {
		body := fmt.Sprintf(`{"session_id":"0x%064x"}`, i+1)
		go func() { done <- invokeContinuation(body) }()
	}
	for i := 0; i < cap(publicRetrievalContinuations); i++ {
		select {
		case <-entered:
		case <-time.After(time.Second):
			t.Fatal("key lookup admission did not fill")
		}
	}
	blocked := invokeContinuation(fmt.Sprintf(`{"session_id":"0x%064x"}`, 99))
	if blocked.Code != http.StatusTooManyRequests || lookups.Load() != int32(cap(publicRetrievalContinuations)) || unexpectedCommands.Load() != 0 {
		t.Fatalf("excess public continuation reached key lookup: status=%d lookups=%d unexpected=%d body=%s", blocked.Code, lookups.Load(), unexpectedCommands.Load(), blocked.Body.String())
	}
	close(release)
	for i := 0; i < cap(publicRetrievalContinuations); i++ {
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("admitted continuation did not release")
		}
	}
}

func TestPublicContinuationRetainsCommittedFailureWithoutRebroadcast(t *testing.T) {
	submissionTestDB(t)
	failedResponse, failedFrozen, failedProofs := submissionFixture(t, 1)
	nextResponse, nextFrozen, nextProofs := submissionFixture(t, 2)
	failedResponse.Session.Status = types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_USER_CONFIRMED
	nextResponse.Session.Status = types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_USER_CONFIRMED
	for i, entry := range []struct {
		f      *frozenRetrievalSession
		proofs []types.ChainedProof
	}{{failedFrozen, failedProofs}, {nextFrozen, nextProofs}} {
		if err := storeFrozenSessionProof(entry.f, entry.proofs); err != nil {
			t.Fatalf("store frozen proof %d: %v", i, err)
		}
	}
	id := "0x" + hex.EncodeToString(failedFrozen.Context.ID[:])
	nextID := "0x" + hex.EncodeToString(nextFrozen.Context.ID[:])
	nextQueryID := base64.URLEncoding.EncodeToString(nextFrozen.Context.ID[:])
	body := fmt.Sprintf(`{"session_id":%q}`, id)
	hash, nextHash := strings.Repeat("E", 64), strings.Repeat("F", 64)
	var broadcasts atomic.Int32
	setupMockCombinedOutput(t, func(_ context.Context, _ string, args ...string) ([]byte, error) {
		if args[0] == "keys" {
			return []byte(failedResponse.Session.AuthorizedProofProvider), nil
		}
		if broadcasts.Add(1) == 1 {
			return []byte(fmt.Sprintf(`{"txhash":%q,"code":0}`, hash)), nil
		}
		return []byte(fmt.Sprintf(`{"txhash":%q,"code":0}`, nextHash)), nil
	})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "retrieval-sessions/") {
			w.Header().Set(committedHeightHeader, "12")
			response := failedResponse
			if strings.Contains(r.URL.Path, nextQueryID) {
				response = nextResponse
			}
			_ = (&jsonpb.Marshaler{OrigName: true}).Marshal(w, response)
			return
		}
		if strings.Contains(r.URL.Path, nextHash) {
			fmt.Fprintf(w, `{"tx_response":{"txhash":%q,"height":"13","code":0}}`, nextHash)
			return
		}
		fmt.Fprintf(w, `{"tx_response":{"txhash":%q,"height":"13","code":9,"raw_log":"proof rejected"}}`, hash)
	}))
	defer server.Close()
	oldLCD := lcdBase
	lcdBase = server.URL
	defer func() { lcdBase = oldLCD }()

	for attempt := 0; attempt < 2; attempt++ {
		got := invokeContinuation(body)
		if got.Code != http.StatusConflict || !strings.Contains(got.Body.String(), hash) {
			t.Fatalf("attempt %d did not retain exact failed outcome: %d %s", attempt+1, got.Code, got.Body.String())
		}
	}
	if broadcasts.Load() != 1 {
		t.Fatalf("public retry rebroadcast committed failure: broadcasts=%d", broadcasts.Load())
	}
	record, err := loadFrozenSubmission(failedFrozen)
	if err != nil || !record.record.Submitting || record.record.TxHash != hash {
		t.Fatalf("failed submission marker was not retained: record=%+v err=%v", record, err)
	}
	pendingSigner, err := loadPendingSigner(failedResponse.Session.AuthorizedProofProvider)
	if err != nil || pendingSigner != nil {
		t.Fatalf("terminal failed transaction retained global signer quarantine: marker=%+v err=%v", pendingSigner, err)
	}
	next := invokeContinuation(fmt.Sprintf(`{"session_id":%q}`, nextID))
	if next.Code != http.StatusOK || !strings.Contains(next.Body.String(), nextHash) || broadcasts.Load() != 2 {
		t.Fatalf("terminal failure blocked unrelated session: %d %s broadcasts=%d", next.Code, next.Body.String(), broadcasts.Load())
	}
}

func TestPublicContinuationReleasesKnownRejectionForSignerAndRetry(t *testing.T) {
	submissionTestDB(t)
	firstResponse, firstFrozen, firstProofs := submissionFixture(t, 1)
	secondResponse, secondFrozen, secondProofs := submissionFixture(t, 2)
	firstResponse.Session.Status = types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_USER_CONFIRMED
	secondResponse.Session.Status = types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_USER_CONFIRMED
	for i, entry := range []struct {
		f      *frozenRetrievalSession
		proofs []types.ChainedProof
	}{{firstFrozen, firstProofs}, {secondFrozen, secondProofs}} {
		if err := storeFrozenSessionProof(entry.f, entry.proofs); err != nil {
			t.Fatalf("store frozen proof %d: %v", i, err)
		}
	}
	firstID := "0x" + hex.EncodeToString(firstFrozen.Context.ID[:])
	secondID := "0x" + hex.EncodeToString(secondFrozen.Context.ID[:])
	secondQueryID := base64.URLEncoding.EncodeToString(secondFrozen.Context.ID[:])
	rejectedHash, acceptedHash := strings.Repeat("7", 64), strings.Repeat("8", 64)
	var submissions atomic.Int32
	setupMockCombinedOutput(t, func(_ context.Context, _ string, args ...string) ([]byte, error) {
		if args[0] == "keys" {
			return []byte(firstResponse.Session.AuthorizedProofProvider), nil
		}
		if submissions.Add(1) == 1 {
			return []byte(fmt.Sprintf(`{"txhash":%q,"code":7}`, rejectedHash)), nil
		}
		return []byte(fmt.Sprintf(`{"txhash":%q,"code":0}`, acceptedHash)), nil
	})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "retrieval-sessions/") {
			w.Header().Set(committedHeightHeader, "12")
			response := firstResponse
			if strings.Contains(r.URL.Path, secondQueryID) {
				response = secondResponse
			}
			_ = (&jsonpb.Marshaler{OrigName: true}).Marshal(w, response)
			return
		}
		fmt.Fprintf(w, `{"tx_response":{"txhash":%q,"height":"13","code":0}}`, acceptedHash)
	}))
	defer server.Close()
	oldLCD := lcdBase
	lcdBase = server.URL
	defer func() { lcdBase = oldLCD }()

	rejected := invokeContinuation(fmt.Sprintf(`{"session_id":%q}`, firstID))
	if rejected.Code != http.StatusConflict || !strings.Contains(rejected.Body.String(), rejectedHash) {
		t.Fatalf("known CheckTx rejection not reported: %d %s", rejected.Code, rejected.Body.String())
	}
	record, err := loadFrozenSubmission(firstFrozen)
	if err != nil || record.record.Submitting || record.record.TxHash != "" {
		t.Fatalf("known CheckTx rejection quarantined signer: record=%+v err=%v", record, err)
	}
	second := invokeContinuation(fmt.Sprintf(`{"session_id":%q}`, secondID))
	if second.Code != http.StatusOK || !strings.Contains(second.Body.String(), acceptedHash) {
		t.Fatalf("known rejection blocked another session: %d %s", second.Code, second.Body.String())
	}
	retry := invokeContinuation(fmt.Sprintf(`{"session_id":%q}`, firstID))
	if retry.Code != http.StatusOK || submissions.Load() != 3 {
		t.Fatalf("safe public retry failed: %d %s submissions=%d", retry.Code, retry.Body.String(), submissions.Load())
	}
}

func TestFrozenSubmissionRestartAndCleanup(t *testing.T) {
	hash := strings.Repeat("A", 64)
	for _, mode := range []string{"hash-restart", "lost-hash", "cleanup-failure", "committed-failure", "checktx-rejection"} {
		t.Run(mode, func(t *testing.T) {
			path := submissionTestDB(t)
			response, f, proofs := submissionFixture(t, 1)
			if err := storeFrozenSessionProof(f, proofs); err != nil {
				t.Fatal(err)
			}
			id := "0x" + hex.EncodeToString(f.Context.ID[:])
			body := fmt.Sprintf(`{"session_id":%q}`, id)
			commands := 0
			setupMockCombinedOutput(t, func(_ context.Context, _ string, args ...string) ([]byte, error) {
				if args[0] == "keys" {
					return []byte(response.Session.AuthorizedProofProvider), nil
				}
				commands++
				switch mode {
				case "lost-hash":
					return nil, context.Canceled
				case "hash-restart":
					return []byte(fmt.Sprintf(`{"txhash":%q,"code":0}`, hash)), context.Canceled
				case "checktx-rejection":
					return []byte(fmt.Sprintf(`{"txhash":%q,"code":7}`, hash)), nil
				}
				return []byte(fmt.Sprintf(`{"txhash":%q,"code":0}`, hash)), nil
			})
			height := "12"
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.Contains(r.URL.Path, "retrieval-sessions/") {
					w.Header().Set(committedHeightHeader, height)
					_ = (&jsonpb.Marshaler{OrigName: true}).Marshal(w, response)
					return
				}
				code := 0
				if mode == "committed-failure" {
					code = 9
				}
				if mode == "cleanup-failure" {
					if err := sessionDB.Close(); err != nil {
						t.Error(err)
					}
				}
				fmt.Fprintf(w, `{"tx_response":{"txhash":%q,"height":"13","code":%d}}`, hash, code)
			}))
			defer server.Close()
			previous := lcdBase
			lcdBase = server.URL
			defer func() { lcdBase = previous }()
			got := invokeSubmission(body)
			want := http.StatusAccepted
			if mode == "cleanup-failure" {
				want = 200
			} else if mode == "committed-failure" || mode == "checktx-rejection" {
				want = 409
			}
			if got.Code != want || commands != 1 {
				t.Fatalf("first submission: %d %s commands=%d", got.Code, got.Body.String(), commands)
			}
			if mode != "lost-hash" && !strings.Contains(got.Body.String(), hash) {
				t.Fatal("lost known broadcast hash", got.Body.String())
			}
			if mode == "cleanup-failure" && !strings.Contains(got.Body.String(), `"cleanup_status":"pending"`) {
				t.Fatal(got.Body.String())
			}
			// Reopen the real bbolt file, discarding all decoded in-memory records.
			if mode != "cleanup-failure" {
				if err := closeSessionDB(); err != nil {
					t.Fatal(err)
				}
			} else {
				sessionDB = nil
			}
			if err := initSessionDB(path); err != nil {
				t.Fatal(err)
			}
			stored, err := loadFrozenSubmission(f)
			if err != nil {
				t.Fatal("proofs not durable", err)
			}
			if mode == "checktx-rejection" || mode == "committed-failure" {
				if stored.record.Submitting || stored.record.TxHash != "" {
					t.Fatal("resolved failed submission left an unknown intent")
				}
				return
			}
			if !stored.record.Submitting {
				t.Fatal("lost persisted submission intent")
			}
			if mode == "lost-hash" {
				repeated := invokeSubmission(body)
				if repeated.Code != want || commands != 1 {
					t.Fatal("unknown submission rebroadcast", repeated.Code, commands)
				}
			}
			if mode == "hash-restart" {
				// The tx hash remains usable after the anchor is pruned, even before
				// this query observes session completion. Reconcile, never rebroadcast.
				response.ChallengeSeed = nil
				height = "100"
				got = invokeSubmission(body)
				if got.Code != 200 || commands != 1 || !strings.Contains(got.Body.String(), hash) {
					t.Fatal("known hash did not recover", got.Code, got.Body.String(), commands)
				}
			}
			// Completion retains payee/context after seed expiry; no new proof/CLI is required.
			response.Session.Status = types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_COMPLETED
			response.ChallengeSeed = nil
			height = "100"
			got = invokeSubmission(body)
			if got.Code != 200 || commands != 1 || !strings.Contains(got.Body.String(), `"status":"reconciled"`) {
				t.Fatal(got.Code, got.Body.String(), commands)
			}
			if _, err := loadFrozenSubmission(f); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("matching complete proof not cleaned", err)
			}
			if got = invokeSubmission(body); got.Code != 200 {
				t.Fatal("cleanup retry not idempotent", got.Code, got.Body.String())
			}
		})
	}
}

func TestFrozenSubmissionBatchOneCLIAndFailClosed(t *testing.T) {
	submissionTestDB(t)
	first, f, p := submissionFixture(t, 1)
	second, g, q := submissionFixture(t, 2)
	// Stored ranges may arrive shuffled; normalize once by the full tuple.
	p[0], p[1] = p[1], p[0]
	if err := storeFrozenSessionProof(f, p); err != nil {
		t.Fatal(err)
	}
	if err := storeFrozenSessionProof(g, q); err != nil {
		t.Fatal(err)
	}
	ids := []string{"0x" + hex.EncodeToString(f.Context.ID[:]), "0x" + hex.EncodeToString(g.Context.ID[:])}
	body, _ := json.Marshal(sessionProofRequest{SessionIDs: ids, Provider: first.Session.AuthorizedProofProvider})
	hash := strings.Repeat("B", 64)
	broadcasts := 0
	setupMockCombinedOutput(t, func(_ context.Context, _ string, args ...string) ([]byte, error) {
		if args[0] == "keys" {
			return []byte(first.Session.AuthorizedProofProvider), nil
		}
		broadcasts++
		data, err := os.ReadFile(args[3])
		if err != nil {
			t.Fatal(err)
		}
		var batch struct {
			Sessions []types.MsgSubmitRetrievalSessionProof `json:"sessions"`
		}
		if err := json.Unmarshal(data, &batch); err != nil {
			t.Fatal(err)
		}
		if len(batch.Sessions) != 2 {
			t.Fatal("not one two-message input")
		}
		for i, m := range batch.Sessions {
			if m.Creator != first.Session.AuthorizedProofProvider || "0x"+hex.EncodeToString(m.SessionId) != ids[i] || len(m.Proofs) != 2 {
				t.Fatal("wrong submitted identity/order", i)
			}
		}
		return []byte(fmt.Sprintf(`{"txhash":%q,"code":0}`, hash)), nil
	})
	wrong := true
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "retrieval-sessions/") {
			response := first
			if strings.HasSuffix(r.URL.Path, base64.URLEncoding.EncodeToString(second.Session.SessionId)) {
				response = second
			}
			if wrong {
				response = second
			} // A different valid session must not authorize deletion.
			w.Header().Set(committedHeightHeader, "12")
			_ = (&jsonpb.Marshaler{OrigName: true}).Marshal(w, response)
			return
		}
		fmt.Fprintf(w, `{"tx_response":{"txhash":%q,"height":"13","code":0}}`, hash)
	}))
	defer server.Close()
	previous := lcdBase
	lcdBase = server.URL
	defer func() { lcdBase = previous }()
	if got := invokeSubmission(string(body)); got.Code != 502 || broadcasts != 0 {
		t.Fatal("wrong query accepted", got.Code, got.Body.String())
	}
	wrong = false
	// Mutated z and corrupt JSON remain unchanged and cannot fall back to legacy storage.
	original, err := loadFrozenSubmission(f)
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range [][]byte{[]byte(`{"version":2,`), bytes.Replace(original.raw, []byte(`"version":2`), []byte(`"version":0`), 1)} {
		if err := sessionDB.Update(func(tx *bolt.Tx) error {
			return tx.Bucket(onChainSessionProofsBucket).Put(frozenProofKey(f.Context.ID), bad)
		}); err != nil {
			t.Fatal(err)
		}
		got := invokeSubmission(string(body))
		if got.Code != 409 || broadcasts != 0 {
			t.Fatal(got.Code, got.Body.String())
		}
		_ = sessionDB.View(func(tx *bolt.Tx) error {
			if !bytes.Equal(tx.Bucket(onChainSessionProofsBucket).Get(frozenProofKey(f.Context.ID)), bad) {
				t.Error("corrupt data overwritten")
			}
			return nil
		})
	}
	_ = sessionDB.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(onChainSessionProofsBucket).Put(frozenProofKey(f.Context.ID), original.raw)
	})
	got := invokeSubmission(string(body))
	if got.Code != 200 || broadcasts != 1 || !strings.Contains(got.Body.String(), `"proof_count":4`) {
		t.Fatal(got.Code, got.Body.String(), broadcasts)
	}
	for _, f := range []*frozenRetrievalSession{f, g} {
		if _, err := loadFrozenSubmission(f); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("batch cleanup failed", err)
		}
	}
}

func TestFrozenProofStorageAndOperationIsolation(t *testing.T) {
	submissionTestDB(t)
	_, f, p := submissionFixture(t, 1)
	_, g, q := submissionFixture(t, 2)
	if err := storeFrozenSessionProof(f, p); err != nil {
		t.Fatal(err)
	}
	if err := storeFrozenSessionProof(g, q); err != nil {
		t.Fatal(err)
	}
	a, _ := loadFrozenSubmission(f)
	b, _ := loadFrozenSubmission(g)
	original := bytes.Clone(a.raw)
	if err := changeFrozenSubmissions([]*frozenSubmission{b}, func(r *storedFrozenProof) { r.Submitting = true }, false); err != nil {
		t.Fatal(err)
	}
	b.raw = []byte("stale snapshot")
	if err := changeFrozenSubmissions([]*frozenSubmission{a, b}, nil, true); err == nil {
		t.Fatal("stale batch cleanup succeeded")
	}
	a, err := loadFrozenSubmission(f)
	if err != nil || !bytes.Equal(a.raw, original) {
		t.Fatal("partial cleanup committed", err)
	}
	hash := strings.Repeat("A", 64)
	if err := changeFrozenSubmissions([]*frozenSubmission{a}, func(r *storedFrozenProof) { r.TxHash = hash; r.Submitting = true }, false); err != nil {
		t.Fatal(err)
	}
	if err := storeFrozenSessionProof(f, p); err != nil {
		t.Fatal("same-proof retry failed", err)
	}
	after, _ := loadFrozenSubmission(f)
	if !bytes.Equal(after.raw, a.raw) {
		t.Fatal("late store erased durable intent/hash")
	}
	p[0].ZValue = bytes.Clone(p[0].ZValue)
	p[0].ZValue[0] ^= 1
	if err := storeFrozenSessionProof(f, p); err == nil {
		t.Fatal("wrong challenge overwrote record")
	}
	after.record.Proofs = p
	if err := validateStoredSessionProof(after); err == nil {
		t.Fatal("wrong z accepted")
	}
	after.record.Proofs = []types.ChainedProof{q[0], q[0]}
	if err := validateStoredSessionProof(after); err == nil {
		t.Fatal("duplicate tuple accepted")
	}
	release, err := claimRetrievalOperations([]string{"one"}, "actual-key")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		ids    []string
		signer string
	}{{[]string{"one"}, ""}, {[]string{"two"}, "actual-key"}} {
		if undo, err := claimRetrievalOperations(tc.ids, tc.signer); err == nil {
			undo()
			t.Fatal("overlap admitted")
		}
	}
	other, err := claimRetrievalOperations([]string{"two"}, "another-key")
	if err != nil {
		t.Fatal(err)
	}
	other()
	release()
	release()
	next, err := claimRetrievalOperations([]string{"one"}, "actual-key")
	if err != nil {
		t.Fatal(err)
	}
	next()
}

func waitForPrioritySigner(t *testing.T, signer string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		retrievalOperations.Lock()
		waiting := retrievalOperations.priority[signer] != nil
		retrievalOperations.Unlock()
		if waiting {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("priority signer %q did not start waiting", signer)
}

func TestPriorityRetrievalSignerPreventsForegroundStarvationAndCancels(t *testing.T) {
	signer := "audit-signer"
	foreground, err := claimRetrievalOperations([]string{"first"}, signer)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(foreground)

	type result struct {
		release func()
		waited  bool
		err     error
	}
	resultCh := make(chan result, 1)
	go func() {
		release, waited, err := claimPriorityRetrievalSigner(context.Background(), signer)
		resultCh <- result{release, waited, err}
	}()
	waitForPrioritySigner(t, signer)
	if release, _, err := claimPriorityRetrievalSigner(context.Background(), signer); err == nil {
		release()
		t.Fatal("duplicate audit waiter admitted")
	}
	for i := 0; i < 20; i++ {
		if release, err := claimRetrievalOperations([]string{fmt.Sprintf("foreground-%d", i)}, signer); err == nil {
			release()
			t.Fatal("foreground request stole reserved signer")
		}
	}
	foreground()
	got := <-resultCh
	if got.err != nil || !got.waited || got.release == nil {
		t.Fatal(got.waited, got.err)
	}
	if release, err := claimRetrievalOperations([]string{"overlap"}, signer); err == nil {
		release()
		t.Fatal("foreground overlapped admitted audit")
	}
	got.release()
	got.release()

	foreground, err = claimRetrievalOperations([]string{"second"}, signer)
	if err != nil {
		t.Fatal(err)
	}
	cancelCtx, cancel := context.WithCancel(context.Background())
	resultCh = make(chan result, 1)
	go func() {
		release, waited, err := claimPriorityRetrievalSigner(cancelCtx, signer)
		resultCh <- result{release, waited, err}
	}()
	waitForPrioritySigner(t, signer)
	cancel()
	got = <-resultCh
	if !errors.Is(got.err, context.Canceled) || !got.waited || got.release != nil {
		t.Fatalf("canceled reservation result: waited=%v release_present=%v err=%v", got.waited, got.release != nil, got.err)
	}
	foreground()
	next, err := claimRetrievalOperations([]string{"after-cancel"}, signer)
	if err != nil {
		t.Fatal("canceled reservation retained signer", err)
	}
	next()
	canceledCtx, cancelAlready := context.WithCancel(context.Background())
	cancelAlready()
	if release, _, err := claimPriorityRetrievalSigner(canceledCtx, signer); !errors.Is(err, context.Canceled) {
		if release != nil {
			release()
		}
		t.Fatal("already canceled audit admission", err)
	}
	next, err = claimRetrievalOperations([]string{"after-pre-cancel"}, signer)
	if err != nil {
		t.Fatal("pre-canceled admission leaked signer", err)
	}
	next()
}

func TestPriorityRetrievalSignerWaitersAreBounded(t *testing.T) {
	type result struct {
		release func()
		err     error
	}
	active := make([]func(), 4)
	cancels := make([]context.CancelFunc, 4)
	results := make([]chan result, 4)
	for i := range active {
		signer := fmt.Sprintf("bounded-signer-%d", i)
		var err error
		active[i], err = claimRetrievalOperations(nil, signer)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(active[i])
		ctx, cancel := context.WithCancel(context.Background())
		cancels[i] = cancel
		results[i] = make(chan result, 1)
		go func() {
			release, _, err := claimPriorityRetrievalSigner(ctx, signer)
			results[i] <- result{release, err}
		}()
		waitForPrioritySigner(t, signer)
	}
	if release, _, err := claimPriorityRetrievalSigner(context.Background(), "fifth-signer"); err == nil {
		release()
		t.Fatal("fifth audit waiter admitted")
	}
	for _, cancel := range cancels {
		cancel()
	}
	for i, resultCh := range results {
		got := <-resultCh
		if !errors.Is(got.err, context.Canceled) || got.release != nil {
			t.Fatalf("waiter %d cancellation: release_present=%v err=%v", i, got.release != nil, got.err)
		}
		active[i]()
	}
}

func TestPriorityRetrievalSignerCancellationRacesReleaseWithoutLeak(t *testing.T) {
	type result struct {
		release func()
		err     error
	}
	for i := 0; i < 100; i++ {
		signer := fmt.Sprintf("cancel-race-signer-%d", i)
		foreground, err := claimRetrievalOperations(nil, signer)
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		resultCh := make(chan result, 1)
		go func() {
			release, _, err := claimPriorityRetrievalSigner(ctx, signer)
			resultCh <- result{release, err}
		}()
		waitForPrioritySigner(t, signer)
		start := make(chan struct{})
		done := make(chan struct{}, 2)
		go func() { <-start; cancel(); done <- struct{}{} }()
		go func() { <-start; foreground(); done <- struct{}{} }()
		close(start)
		<-done
		<-done
		got := <-resultCh
		if got.release != nil {
			got.release()
		} else if !errors.Is(got.err, context.Canceled) {
			t.Fatal("raced admission returned neither ownership nor cancellation", got.err)
		}
		retrievalOperations.Lock()
		active := retrievalOperations.signers[signer]
		waiting := retrievalOperations.priority[signer] != nil
		queued := false
		for _, waiter := range retrievalOperations.priorityWaiters {
			queued = queued || waiter.signer == signer
		}
		retrievalOperations.Unlock()
		if active || waiting || queued {
			t.Fatal("raced cancellation leaked admission state", i, active, waiting, queued)
		}
		next, err := claimRetrievalOperations(nil, signer)
		if err != nil {
			t.Fatal("raced cancellation retained signer", i, err)
		}
		next()
	}
}

func TestPriorityRetrievalSignerGetsNextGlobalSlot(t *testing.T) {
	active := make([]func(), maxConcurrentRetrievalSigners)
	for i := range active {
		var err error
		active[i], err = claimRetrievalOperations(nil, fmt.Sprintf("active-signer-%d", i))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(active[i])
	}
	const signer = "waiting-different-signer"
	type result struct {
		release func()
		err     error
	}
	resultCh := make(chan result, 1)
	go func() {
		release, _, err := claimPriorityRetrievalSigner(context.Background(), signer)
		resultCh <- result{release, err}
	}()
	waitForPrioritySigner(t, signer)
	active[0]()
	got := <-resultCh
	if got.err != nil || got.release == nil {
		t.Fatal(got.err)
	}
	if release, err := claimRetrievalOperations(nil, signer); err == nil {
		release()
		t.Fatal("foreground overlapped globally admitted audit")
	}
	retrievalOperations.Lock()
	activeCount := len(retrievalOperations.signers)
	retrievalOperations.Unlock()
	if activeCount != maxConcurrentRetrievalSigners {
		t.Fatal("reserved audit did not receive the released global slot", activeCount)
	}
	got.release()
	for _, release := range active[1:] {
		release()
	}
}

func TestDelayedCommittedSubmissionThroughBothGatewayModes(t *testing.T) {
	for _, mode := range []string{"ordinary", "router"} {
		t.Run(mode, func(t *testing.T) {
			submissionTestDB(t)
			response, f, proofs := submissionFixture(t, 1)
			if err := storeFrozenSessionProof(f, proofs); err != nil {
				t.Fatal(err)
			}
			id := "0x" + hex.EncodeToString(f.Context.ID[:])
			hash := strings.Repeat("C", 64)
			body := fmt.Sprintf(`{"session_ids":[%q],"provider":%q}`, id, response.Session.AuthorizedProofProvider)
			var firstPoll time.Time
			lcd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.Contains(r.URL.Path, "retrieval-sessions/") {
					w.Header().Set(committedHeightHeader, "12")
					_ = (&jsonpb.Marshaler{OrigName: true}).Marshal(w, response)
					return
				}
				if firstPoll.IsZero() {
					firstPoll = time.Now()
				}
				if time.Since(firstPoll) < 5100*time.Millisecond {
					w.WriteHeader(404)
					return
				}
				fmt.Fprintf(w, `{"tx_response":{"txhash":%q,"height":"13","code":0}}`, hash)
			}))
			defer lcd.Close()
			oldLCD := lcdBase
			lcdBase = lcd.URL
			defer func() { lcdBase = oldLCD }()
			broadcasts := 0
			setupMockCombinedOutput(t, func(_ context.Context, _ string, args ...string) ([]byte, error) {
				if args[0] == "keys" {
					return []byte(response.Session.AuthorizedProofProvider), nil
				}
				broadcasts++
				return []byte(fmt.Sprintf(`{"txhash":%q,"code":0}`, hash)), nil
			})
			provider := httptest.NewServer(http.HandlerFunc(SpSubmitRetrievalSessionProof))
			defer provider.Close()
			t.Setenv("POLYSTORE_PROVIDER_HTTP_BASE_OVERRIDES", response.Session.AuthorizedProofProvider+"="+provider.URL)
			providerBaseCache.Clear()
			t.Cleanup(func() { providerBaseCache.Clear() })
			request := httptest.NewRequest("POST", "/gateway/session-proof", strings.NewReader(body))
			request.Header.Set(gatewayAuthHeader, gatewayToProviderAuthToken())
			result := httptest.NewRecorder()
			if mode == "ordinary" {
				GatewaySubmitRetrievalSessionProof(result, request)
			} else {
				RouterGatewaySubmitRetrievalSessionProof(result, request)
			}
			if result.Code != 200 || broadcasts != 1 || !strings.Contains(result.Body.String(), hash) {
				t.Fatal("delayed commit lost in forwarding", result.Code, result.Body.String(), broadcasts)
			}
			if _, err := loadFrozenSubmission(f); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("committed proof not cleaned", err)
			}
		})
	}
}

func TestPendingSignerQuarantineAtomicity(t *testing.T) {
	submissionTestDB(t)
	_, f, proofs := submissionFixture(t, 1)
	if err := storeFrozenSessionProof(f, proofs); err != nil {
		t.Fatal(err)
	}
	record, _ := loadFrozenSubmission(f)
	before := bytes.Clone(record.raw)
	signer := f.Session.AuthorizedProofProvider
	audit := pendingSignerOperation{Kind: "audit", IDs: []string{"context:1"}}
	if err := sessionDB.Update(func(tx *bolt.Tx) error { return claimPendingSigner(tx, signer, audit) }); err != nil {
		t.Fatal(err)
	}
	err := changeFrozenSubmissions([]*frozenSubmission{record}, func(r *storedFrozenProof) { r.Submitting = true }, false, func(tx *bolt.Tx) error {
		return claimPendingSigner(tx, signer, pendingSignerOperation{Kind: "retrieval", IDs: []string{"session"}})
	})
	if err == nil {
		t.Fatal("unknown audit failed to quarantine actual signer")
	}
	record, _ = loadFrozenSubmission(f)
	if !bytes.Equal(record.raw, before) {
		t.Fatal("failed marker claim partially changed proof")
	}
	if err := sessionDB.Update(func(tx *bolt.Tx) error { return clearPendingSigner(tx, signer, "retrieval", []string{"session"}) }); err == nil {
		t.Fatal("another operation cleared signer")
	}
	audit.TxHash = strings.Repeat("A", 64)
	if err := sessionDB.Update(func(tx *bolt.Tx) error { return claimPendingSigner(tx, signer, audit) }); err != nil {
		t.Fatal(err)
	}
	audit.TxHash = ""
	if err := sessionDB.Update(func(tx *bolt.Tx) error { return claimPendingSigner(tx, signer, audit) }); err == nil {
		t.Fatal("known hash erased")
	}
	marker, err := loadPendingSigner(signer)
	if err != nil || marker.TxHash == "" {
		t.Fatal(marker, err)
	}
	if err := sessionDB.Update(func(tx *bolt.Tx) error { return clearPendingSigner(tx, signer, "audit", audit.IDs) }); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 4; i++ {
		if err := sessionDB.Update(func(tx *bolt.Tx) error { return claimPendingSigner(tx, fmt.Sprint(i), audit) }); err != nil {
			t.Fatal(err)
		}
	}
	if err := sessionDB.Update(func(tx *bolt.Tx) error { return claimPendingSigner(tx, "fifth", audit) }); err == nil {
		t.Fatal("unbounded signer intents")
	}
}

func TestLegacyProofCorruptionAndTupleIdentity(t *testing.T) {
	submissionTestDB(t)
	id := "0x" + strings.Repeat("a", 64)
	bad := []byte(`[{"mdu_index":`)
	if err := sessionDB.Update(func(tx *bolt.Tx) error { return tx.Bucket(onChainSessionProofsBucket).Put([]byte(id), bad) }); err != nil {
		t.Fatal(err)
	}
	if err := storeOnChainSessionProof(id, types.ChainedProof{MduIndex: 1, BlobIndex: 64}); err == nil {
		t.Fatal("corruption overwritten")
	}
	if _, err := loadOnChainSessionProofs(id); err == nil {
		t.Fatal("corruption became absence")
	}
	_ = sessionDB.View(func(tx *bolt.Tx) error {
		if !bytes.Equal(tx.Bucket(onChainSessionProofsBucket).Get([]byte(id)), bad) {
			t.Error("corrupt record changed")
		}
		return nil
	})
	_ = sessionDB.Update(func(tx *bolt.Tx) error { return tx.Bucket(onChainSessionProofsBucket).Delete([]byte(id)) })
	for _, proof := range []types.ChainedProof{{MduIndex: 1, BlobIndex: 64}, {MduIndex: 2, BlobIndex: 0}, {MduIndex: 1, BlobIndex: 64}} {
		if err := storeOnChainSessionProof(id, proof); err != nil {
			t.Fatal(err)
		}
	}
	proofs, err := loadOnChainSessionProofs(id)
	if err != nil || len(proofs) != 2 {
		t.Fatal("tuple collision or duplicate growth", len(proofs), err)
	}
}

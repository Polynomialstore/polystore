package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/cosmos/gogoproto/jsonpb"
	"github.com/gorilla/mux"
)

func diagnosticDataRouteFixtureV3(t testing.TB, size uint64) (*frozenRetrievalSessionV3, retrievalGenerationKey, string, func(context.Context) *http.Request) {
	t.Helper()
	frozen, key, dir := buildProviderV3ArtifactFixtureSize(t, size)
	previousDB := sessionDB
	sessionDB = nil
	if err := initSessionDB(filepath.Join(t.TempDir(), "sessions.db")); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = closeSessionDB(); sessionDB = previousDB })
	response := responseFromFrozenV3(frozen)
	lcd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/retrieval-sessions/") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set(committedHeightHeader, strconv.FormatUint(frozen.Height, 10))
		if err := (&jsonpb.Marshaler{OrigName: true}).Marshal(w, &response); err != nil {
			t.Error(err)
		}
	}))
	t.Cleanup(lcd.Close)
	oldLCD, oldMock := lcdBase, mockCombinedOutput
	lcdBase = lcd.URL
	signer := frozen.Session.Obligations[0].Payee
	// Exercise real key resolution dispatch, but do not mistake a deterministic
	// process-boundary stub for the cost of the deployed chain binary/keyring.
	mockCombinedOutput = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		if len(args) >= 2 && args[0] == "keys" && args[1] == "show" {
			return []byte(signer), nil
		}
		return nil, fmt.Errorf("unexpected subprocess")
	}
	t.Cleanup(func() { lcdBase, mockCombinedOutput = oldLCD, oldMock })
	t.Setenv("POLYSTORE_PROVIDER_ADDRESS", signer)
	root := "0x" + hex.EncodeToString(key.Root[:])
	return frozen, key, dir, func(ctx context.Context) *http.Request {
		index := strconv.FormatUint(key.Metadata, 10)
		q := url.Values{"deal_id": {strconv.FormatUint(key.Deal, 10)}, "owner": {frozen.Session.Owner}}
		r := httptest.NewRequest(http.MethodGet, "/sp/retrieval/mdu/"+root+"/"+index+"?"+q.Encode(), nil).WithContext(ctx)
		r = mux.SetURLVars(r, map[string]string{"cid": root, "index": index})
		r.Header.Set("Accept", "multipart/form-data; version=3")
		r.Header.Set("X-PolyStore-Session-Id", "0x"+hex.EncodeToString(frozen.Session.SessionId))
		r.Header.Set("X-PolyStore-Slot", "0")
		return r
	}
}

func TestGatewayMduV3DiagnosticsPublicSuccessAndFailures(t *testing.T) {
	t.Setenv("POLYSTORE_RETRIEVAL_DIAGNOSTICS", "1")
	_, _, _, request := diagnosticDataRouteFixtureV3(t, 1024)
	var wire []byte
	for attempt := 0; attempt < 2; attempt++ {
		now := time.Unix(0, 0)
		d := &retrievalDiagnosticsV3{now: func() time.Time { now = now.Add(time.Millisecond); return now }}
		r := request(context.WithValue(context.Background(), retrievalDiagnosticsKeyV3{}, d))
		w := httptest.NewRecorder()
		GatewayMdu(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
		_, payload := decodeRetrievalDataResponseV3(t, w)
		if attempt == 0 {
			wire = payload
		} else if !bytes.Equal(wire, payload) {
			t.Fatal("diagnostics changed payload")
		}
		for phase, calls := range map[retrievalPhaseV3]uint64{retrievalAdmissionV3: 1, retrievalLCDV3: 2, retrievalKeysV3: 1,
			retrievalGenerationOpenV3: 1, retrievalMetadataV3: 1, retrievalIndexV3: 1, retrievalArtifactReadV3: 1,
			retrievalHashV3: 1, retrievalPathV3: 1, retrievalEncodeV3: 1, retrievalWriteV3: 1} {
			if got := d.phases[phase]; got.Calls != calls || got.Done != calls || got.Time != time.Duration(calls)*time.Millisecond {
				t.Fatalf("attempt=%d phase=%s measurement=%+v", attempt, retrievalPhaseNamesV3[phase], got)
			}
		}
		if d.chunk != "0:0:0" || len(w.Header().Get("Server-Timing")) > 2048 || strings.Contains(w.Header().Get("Server-Timing"), "ps3p_write") {
			t.Fatal("invalid chunk correlation or pre-body write duration")
		}
	}
	// Rejection must precede both chain queries and key subprocess dispatch.
	for i := 0; i < maxRetrievalResponses; i++ {
		retrievalResponses <- struct{}{}
	}
	w := httptest.NewRecorder()
	GatewayMdu(w, request(context.Background()))
	for i := 0; i < maxRetrievalResponses; i++ {
		<-retrievalResponses
	}
	if w.Code != http.StatusServiceUnavailable || strings.Contains(w.Header().Get("Server-Timing"), "ps3p_lcd") || strings.Contains(w.Header().Get("Server-Timing"), "ps3p_keys") {
		t.Fatal("admission rejection performed authority or subprocess work")
	}
	// A real key lookup failure remains fail-closed; no artifact read follows.
	mockCombinedOutput = func(context.Context, string, ...string) ([]byte, error) {
		return nil, fmt.Errorf("private-keyring-path")
	}
	w = httptest.NewRecorder()
	GatewayMdu(w, request(context.Background()))
	if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Header().Get("Server-Timing"), "ps3p_keys") || strings.Contains(w.Header().Get("Server-Timing"), "ps3p_read") || strings.Contains(w.Header().Get("Server-Timing"), "private") {
		t.Fatal("key failure attribution changed authority or leaked error text")
	}
	t.Setenv("POLYSTORE_RETRIEVAL_DIAGNOSTICS", "0")
	w = httptest.NewRecorder()
	GatewayMdu(w, request(context.Background()))
	if w.Header().Get("Server-Timing") != "" {
		t.Fatal("disabled diagnostics emitted headers")
	}
}

type failingDiagnosticWriterV3 struct{ headers http.Header }

func (w failingDiagnosticWriterV3) Header() http.Header { return w.headers }

func (w failingDiagnosticWriterV3) WriteHeader(int)           {}
func (w failingDiagnosticWriterV3) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }

func TestRetrievalDiagnosticsV3WriteFailureAndHeaderPreservation(t *testing.T) {
	d := &retrievalDiagnosticsV3{role: "user-gateway"}
	d.phases[retrievalLCDV3] = retrievalPhaseMeasurementV3{Calls: 2, Done: 2, Time: 3 * time.Millisecond}
	h := make(http.Header)
	h.Add("Server-Timing", `ps3p_lcd;dur=4.000;desc="2"`)
	w := &retrievalDiagnosticWriterV3{ResponseWriter: failingDiagnosticWriterV3{h}, d: d}
	if _, err := w.Write([]byte("payload")); err != io.ErrClosedPipe || !w.writeError || w.bytes != 0 {
		t.Fatal("write failure suppressed")
	}
	combined := strings.Join(h.Values("Server-Timing"), ", ")
	if !strings.Contains(combined, "ps3p_lcd") || !strings.Contains(combined, "ps3g_lcd") {
		t.Fatal("gateway overwrote provider attribution")
	}
}

func TestGatewayMduV3DiagnosticsAuthorityFailure(t *testing.T) {
	t.Setenv("POLYSTORE_RETRIEVAL_DIAGNOSTICS", "1")
	queries := 0
	lcd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		queries++
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer lcd.Close()
	oldLCD := lcdBase
	lcdBase = lcd.URL
	t.Cleanup(func() { lcdBase = oldLCD })
	root := "0x" + strings.Repeat("00", 32)
	r := httptest.NewRequest(http.MethodGet, "/sp/retrieval/mdu/"+root+"/4?deal_id=0&owner=private-owner", nil)
	r = mux.SetURLVars(r, map[string]string{"cid": root, "index": "4"})
	r.Header.Set("Accept", "multipart/form-data; version=3")
	r.Header.Set("X-PolyStore-Session-Id", "0x"+strings.Repeat("11", 32))
	w := httptest.NewRecorder()
	GatewayMdu(w, r)
	if w.Code != http.StatusBadGateway || queries != 1 {
		t.Fatalf("authority failure changed: status=%d queries=%d", w.Code, queries)
	}
	timing := w.Header().Get("Server-Timing")
	if !strings.Contains(timing, "ps3p_admission;dur=") || !strings.Contains(timing, "ps3p_lcd;dur=") || strings.Contains(timing, "keys") || strings.Contains(timing, "private-owner") {
		t.Fatalf("missing or unsafe outer-route failure attribution: %q", timing)
	}
}

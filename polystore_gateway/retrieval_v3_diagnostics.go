package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

// Request-local, fixed-cardinality diagnostics. No paths, keys, accounts, URLs,
// errors or payloads are recorded. These observations never authorize work.
type retrievalPhaseV3 uint8

const (
	retrievalAdmissionV3 retrievalPhaseV3 = iota
	retrievalLCDV3
	retrievalKeysV3
	retrievalGenerationOpenV3
	retrievalMetadataV3
	retrievalIndexV3
	retrievalArtifactReadV3
	retrievalHashV3
	retrievalPathV3
	retrievalEncodeV3
	retrievalWriteV3
	retrievalEndpointV3
	retrievalProxyV3
	retrievalPhaseCountV3
)

var retrievalPhaseNamesV3 = [retrievalPhaseCountV3]string{
	"admission", "lcd", "keys", "generation", "metadata", "index", "read", "hash", "path", "encode", "write", "endpoint", "proxy",
}

type retrievalPhaseMeasurementV3 struct {
	Calls uint64        `json:"calls"`
	Done  uint64        `json:"-"`
	Time  time.Duration `json:"-"`
}

type retrievalDiagnosticsKeyV3 struct{}

type retrievalDiagnosticsV3 struct {
	now     func() time.Time
	started time.Time
	role    string
	session string
	chunk   string
	phases  [retrievalPhaseCountV3]retrievalPhaseMeasurementV3
}

func retrievalDiagnosticsFromV3(ctx context.Context) *retrievalDiagnosticsV3 {
	d, _ := ctx.Value(retrievalDiagnosticsKeyV3{}).(*retrievalDiagnosticsV3)
	return d
}

func startRetrievalPhaseV3(ctx context.Context, phase retrievalPhaseV3) func() {
	d := retrievalDiagnosticsFromV3(ctx)
	if d == nil {
		return func() {}
	}
	start := d.now()
	d.phases[phase].Calls++
	return func() {
		d.phases[phase].Time += d.now().Sub(start)
		d.phases[phase].Done++
	}
}

func (d *retrievalDiagnosticsV3) serverTiming() string {
	prefix := "ps3p_"
	if d.role == "user-gateway" {
		prefix = "ps3g_"
	}
	var parts []string
	for i, phase := range d.phases {
		if phase.Calls != 0 && phase.Calls == phase.Done {
			parts = append(parts, fmt.Sprintf("%s%s;dur=%.3f;desc=\"%d\"", prefix, retrievalPhaseNamesV3[i], phase.Time.Seconds()*1000, phase.Calls))
		}
	}
	return strings.Join(parts, ", ")
}

type retrievalDiagnosticWriterV3 struct {
	http.ResponseWriter
	d          *retrievalDiagnosticsV3
	status     int
	bytes      int64
	writeError bool
}

func (w *retrievalDiagnosticWriterV3) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *retrievalDiagnosticWriterV3) Flush() {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	if err := http.NewResponseController(w.ResponseWriter).Flush(); err != nil && err != http.ErrNotSupported {
		w.writeError = true
	}
}

func (w *retrievalDiagnosticWriterV3) ReadFrom(r io.Reader) (int64, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	if fast, ok := w.ResponseWriter.(io.ReaderFrom); ok {
		n, err := fast.ReadFrom(r)
		w.bytes += n
		w.writeError = w.writeError || err != nil
		return n, err
	}
	// Hide this ReaderFrom method to avoid recursion; Write owns accounting.
	n, err := io.Copy(struct{ io.Writer }{w}, r)
	w.writeError = w.writeError || err != nil
	return n, err
}

func (w *retrievalDiagnosticWriterV3) WriteHeader(status int) {
	if w.status != 0 {
		return
	}
	w.status = status
	// Only already-completed phases are meaningful in pre-body headers. Final
	// write/proxy and total durations are emitted in the server completion log.
	w.Header().Add("Server-Timing", w.d.serverTiming())
	w.Header().Set("Access-Control-Expose-Headers", mergeCSVHeaders(w.Header().Get("Access-Control-Expose-Headers"), "Server-Timing"))
	w.ResponseWriter.WriteHeader(status)
}

func (w *retrievalDiagnosticWriterV3) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	n, err := w.ResponseWriter.Write(p)
	w.bytes += int64(n)
	w.writeError = w.writeError || err != nil
	return n, err
}

// Call at the actual HTTP entry point, before capacity admission and authority
// queries. Disabled by default; a client cannot enable server diagnostics.
func beginRetrievalDiagnosticsV3(w http.ResponseWriter, r *http.Request, role string) (http.ResponseWriter, *http.Request, func()) {
	if os.Getenv("POLYSTORE_RETRIEVAL_DIAGNOSTICS") != "1" || !acceptsRetrievalVersion(r, "3") || len(r.Header.Values("X-PolyStore-Session-Id")) != 1 {
		return w, r, func() {}
	}
	session, _, err := parseSessionIDHex(r.Header.Get("X-PolyStore-Session-Id"))
	if err != nil {
		return w, r, func() {}
	}
	d := retrievalDiagnosticsFromV3(r.Context())
	if d == nil {
		d = &retrievalDiagnosticsV3{now: time.Now}
	}
	d.started, d.role, d.session = d.now(), role, session
	r = r.WithContext(context.WithValue(r.Context(), retrievalDiagnosticsKeyV3{}, d))
	out := &retrievalDiagnosticWriterV3{ResponseWriter: w, d: d}
	return out, r, func() {
		phases := make(map[string]any, retrievalPhaseCountV3)
		for i, phase := range d.phases {
			if phase.Calls != 0 {
				phases[retrievalPhaseNamesV3[i]] = struct {
					Calls uint64  `json:"calls"`
					MS    float64 `json:"ms"`
				}{phase.Calls, phase.Time.Seconds() * 1000}
			}
		}
		entry := struct {
			Version    int            `json:"version"`
			Role       string         `json:"role"`
			Session    string         `json:"session_id"`
			Chunk      string         `json:"chunk_id,omitempty"`
			Status     int            `json:"status"`
			Bytes      int64          `json:"response_bytes"`
			WriteError bool           `json:"response_error"`
			MS         float64        `json:"route_ms"`
			Phases     map[string]any `json:"phases"`
		}{1, role, session, d.chunk, out.status, out.bytes, out.writeError, d.now().Sub(d.started).Seconds() * 1000, phases}
		encoded, _ := json.Marshal(entry)
		log.Printf("retrieval_v3_diagnostic %s", encoded)
	}
}

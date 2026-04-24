package main

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTestFaultEnabledIsDisabledByDefault(t *testing.T) {
	t.Setenv(testFaultsEnv, "")

	if testFaultEnabled("sp_upload_fail") {
		t.Fatal("expected test faults to be disabled by default")
	}
}

func TestTestFaultEnabledParsesList(t *testing.T) {
	t.Setenv(testFaultsEnv, "sp_upload_fail, sp_fetch_corrupt")

	if !testFaultEnabled("sp_upload_fail") {
		t.Fatal("expected upload fault to be enabled")
	}
	if !testFaultEnabled("sp_fetch_corrupt") {
		t.Fatal("expected corrupt fetch fault to be enabled")
	}
	if testFaultEnabled("sp_fetch_fail") {
		t.Fatal("did not expect fetch-fail fault to be enabled")
	}
}

func TestSpUploadMduTestFaultReturnsUnavailable(t *testing.T) {
	t.Setenv(testFaultsEnv, "sp_upload_fail")

	req := httptest.NewRequest(http.MethodPost, "/sp/upload_mdu", bytes.NewReader([]byte("ignored")))
	w := httptest.NewRecorder()

	SpUploadMdu(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d body=%s", w.Code, w.Body.String())
	}
	if got := w.Header().Get("X-PolyStore-Test-Fault"); got != "sp_upload_fail" {
		t.Fatalf("expected test fault header, got %q", got)
	}
}

func TestGatewayFetchTestFaultReturnsUnavailable(t *testing.T) {
	t.Setenv(testFaultsEnv, "sp_fetch_fail")

	req := httptest.NewRequest(http.MethodGet, "/gateway/fetch/test", nil)
	w := httptest.NewRecorder()

	GatewayFetch(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d body=%s", w.Code, w.Body.String())
	}
	if got := w.Header().Get("X-PolyStore-Test-Fault"); got != "sp_fetch_fail" {
		t.Fatalf("expected test fault header, got %q", got)
	}
}

func TestCorruptOnceReadCloserFlipsOnlyFirstByte(t *testing.T) {
	reader := &corruptOnceReadCloser{ReadCloser: io.NopCloser(bytes.NewReader([]byte{0x00, 0x11, 0x22}))}

	out, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("read corrupt reader: %v", err)
	}
	if !bytes.Equal(out, []byte{0xff, 0x11, 0x22}) {
		t.Fatalf("unexpected corrupt output: %x", out)
	}
}

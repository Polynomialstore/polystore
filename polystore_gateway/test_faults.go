package main

import (
	"io"
	"net/http"
	"os"
	"strings"
)

const testFaultsEnv = "POLYSTORE_TEST_FAULTS"

func testFaultEnabled(name string) bool {
	name = strings.TrimSpace(strings.ToLower(name))
	if name == "" {
		return false
	}
	raw := strings.TrimSpace(os.Getenv(testFaultsEnv))
	if raw == "" {
		return false
	}
	for _, token := range strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ';' || r == ' ' || r == '\t' || r == '\n'
	}) {
		token = strings.TrimSpace(strings.ToLower(token))
		if token == name || token == "all" {
			return true
		}
	}
	return false
}

func maybeApplyHTTPTestFault(w http.ResponseWriter, fault string, status int) bool {
	if !testFaultEnabled(fault) {
		return false
	}
	w.Header().Set("X-PolyStore-Test-Fault", fault)
	writeJSONError(w, status, "test fault injected", fault)
	return true
}

type corruptOnceReadCloser struct {
	io.ReadCloser
	corrupted bool
}

func (r *corruptOnceReadCloser) Read(p []byte) (int, error) {
	n, err := r.ReadCloser.Read(p)
	if n > 0 && !r.corrupted {
		p[0] ^= 0xff
		r.corrupted = true
	}
	return n, err
}

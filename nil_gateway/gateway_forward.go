package main

import (
	"bytes"
	"io"
	"net/http"
	"strings"
)

func forwardToProvider(w http.ResponseWriter, r *http.Request, path string) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "failed to read body", err.Error())
		return
	}

	target := strings.TrimRight(providerBase, "/") + path
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to create provider request", err.Error())
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(gatewayAuthHeader, gatewayToProviderAuthToken())

	resp, err := lcdHTTPClient.Do(req)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "failed to contact provider", err.Error())
		return
	}
	defer resp.Body.Close()

	out, _ := io.ReadAll(resp.Body)
	if ct := strings.TrimSpace(resp.Header.Get("Content-Type")); ct != "" {
		w.Header().Set("Content-Type", ct)
	} else {
		w.Header().Set("Content-Type", "application/json")
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(out)
}

package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
)

// dynamicMockDealServer returns an LCD-like handler that serves deal states from a map.
func dynamicMockDealServer(dealStates map[uint64]struct{ Owner string; CID string }) *httptest.Server {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		pathSegments := strings.Split(r.URL.Path, "/")
		if len(pathSegments) < 2 || pathSegments[len(pathSegments)-2] != "deals" {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		dealIDStr := pathSegments[len(pathSegments)-1]
		dealID, err := strconv.ParseUint(dealIDStr, 10, 64)
		if err != nil {
			http.Error(w, "invalid deal ID", http.StatusBadRequest)
			return
		}

		state, ok := dealStates[dealID]
		if !ok {
			http.Error(w, "deal not found", http.StatusNotFound)
			return
		}

		resp := map[string]any{
			"deal": map[string]any{
				"id":    strconv.FormatUint(dealID, 10),
				"owner": state.Owner,
				"cid":   state.CID,
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	})
	return httptest.NewServer(handler)
}

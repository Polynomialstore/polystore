package main

import (
	"encoding/json"
	"net/http"
)

type jsonErrorResponse struct {
	Error string `json:"error"`
	Hint  string `json:"hint,omitempty"`
}

func writeJSONError(w http.ResponseWriter, status int, message string, hint string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(jsonErrorResponse{
		Error: message,
		Hint:  hint,
	})
}


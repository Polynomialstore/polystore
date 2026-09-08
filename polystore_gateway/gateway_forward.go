package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
)

func resolveForwardProviderBase(ctx context.Context, path string, body []byte) (string, error) {
	path = strings.TrimSpace(path)
	providerAddr := ""

	switch path {
	case "/sp/receipt", "/sp/session-receipt":
		var env struct {
			Receipt struct {
				Provider string `json:"provider"`
			} `json:"receipt"`
		}
		if err := json.Unmarshal(body, &env); err == nil {
			providerAddr = strings.TrimSpace(env.Receipt.Provider)
		}
	case "/sp/receipts":
		var env struct {
			Receipts []struct {
				Receipt struct {
					Provider string `json:"provider"`
				} `json:"receipt"`
			} `json:"receipts"`
		}
		if err := json.Unmarshal(body, &env); err == nil {
			for _, item := range env.Receipts {
				p := strings.TrimSpace(item.Receipt.Provider)
				if p == "" {
					continue
				}
				if providerAddr == "" {
					providerAddr = p
					continue
				}
				if providerAddr != p {
					return "", httpErrorf(http.StatusBadRequest, "batch must target a single provider")
				}
			}
		}
	case "/sp/session-proof":
		var env struct {
			Provider string `json:"provider"`
		}
		if err := json.Unmarshal(body, &env); err == nil {
			providerAddr = strings.TrimSpace(env.Provider)
		}
	}

	if providerAddr == "" {
		return "", nil
	}

	baseURL, err := resolveProviderHTTPBaseURL(ctx, providerAddr)
	if err != nil {
		return "", err
	}
	return baseURL, nil
}

func httpErrorf(status int, msg string) error {
	return &httpStatusError{status: status, message: msg}
}

type httpStatusError struct {
	status  int
	message string
}

func (e *httpStatusError) Error() string {
	return e.message
}

func forwardToProvider(w http.ResponseWriter, r *http.Request, path string) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	var body []byte
	var err error
	if path == "/sp/session-proof" {
		body, _, _, err = readSessionProofRequest(r.Body)
	} else {
		body, err = io.ReadAll(r.Body)
	}
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "failed to read body", err.Error())
		return
	}

	targetBase := strings.TrimSpace(providerBase)
	resolvedBase, resolveErr := resolveForwardProviderBase(r.Context(), path, body)
	if resolveErr != nil {
		if hs, ok := resolveErr.(*httpStatusError); ok {
			writeJSONError(w, hs.status, hs.message, "")
			return
		}
		writeJSONError(w, http.StatusBadGateway, "failed to resolve provider endpoint", resolveErr.Error())
		return
	}
	if strings.TrimSpace(resolvedBase) != "" {
		targetBase = resolvedBase
	}
	if strings.TrimSpace(targetBase) == "" {
		writeJSONError(w, http.StatusBadGateway, "failed to resolve provider endpoint", "provider base is empty")
		return
	}

	forwardJSONToProviderBase(w, r, targetBase, path, body)
}

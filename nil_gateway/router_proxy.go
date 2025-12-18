package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
)

var routerHTTPClient = &http.Client{}

func proxyToProviderBaseURL(w http.ResponseWriter, r *http.Request, providerBaseURL string) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	base := strings.TrimRight(strings.TrimSpace(providerBaseURL), "/")
	if base == "" {
		writeJSONError(w, http.StatusBadGateway, "provider base url is empty", "")
		return
	}

	target := base + r.URL.Path
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}

	req, err := http.NewRequestWithContext(r.Context(), r.Method, target, r.Body)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to create provider request", err.Error())
		return
	}
	req.Header = r.Header.Clone()
	req.Header.Set(gatewayAuthHeader, gatewayToProviderAuthToken())

	resp, err := routerHTTPClient.Do(req)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "failed to contact provider", err.Error())
		return
	}
	defer resp.Body.Close()

	for k, vals := range resp.Header {
		for _, v := range vals {
			w.Header().Add(k, v)
		}
	}
	// Ensure CORS headers are always present on responses returned via the router.
	setCORS(w)
	w.WriteHeader(resp.StatusCode)

	if _, err := io.Copy(w, resp.Body); err != nil {
		return
	}
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
}

func requireDealIDQuery(w http.ResponseWriter, r *http.Request) (uint64, bool) {
	raw := strings.TrimSpace(r.URL.Query().Get("deal_id"))
	if raw == "" {
		writeJSONError(w, http.StatusBadRequest, "deal_id query parameter is required", "")
		return 0, false
	}
	dealID, err := parseDealID(raw)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid deal_id", "")
		return 0, false
	}
	return dealID, true
}

func parseDealID(raw string) (uint64, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, fmt.Errorf("empty")
	}
	return strconv.ParseUint(raw, 10, 64)
}

func RouterGatewayFetch(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	dealID, ok := requireDealIDQuery(w, r)
	if !ok {
		return
	}
	providerAddr, err := resolveDealAssignedProvider(r.Context(), dealID)
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, ErrDealNotFound) {
			status = http.StatusNotFound
		}
		writeJSONError(w, status, "failed to resolve deal provider", err.Error())
		return
	}
	baseURL, err := resolveProviderHTTPBaseURL(r.Context(), providerAddr)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "failed to resolve provider endpoint", err.Error())
		return
	}
	proxyToProviderBaseURL(w, r, baseURL)
}

func RouterGatewayListFiles(w http.ResponseWriter, r *http.Request) { RouterGatewayFetch(w, r) }
func RouterGatewaySlab(w http.ResponseWriter, r *http.Request)      { RouterGatewayFetch(w, r) }
func RouterGatewayManifestInfo(w http.ResponseWriter, r *http.Request) {
	RouterGatewayFetch(w, r)
}
func RouterGatewayMduKzg(w http.ResponseWriter, r *http.Request) { RouterGatewayFetch(w, r) }
func RouterGatewayDebugRawFetch(w http.ResponseWriter, r *http.Request) {
	RouterGatewayFetch(w, r)
}
func RouterGatewayPlanRetrievalSession(w http.ResponseWriter, r *http.Request) {
	RouterGatewayFetch(w, r)
}
func RouterGatewayOpenSession(w http.ResponseWriter, r *http.Request) {
	RouterGatewayFetch(w, r)
}

func RouterGatewayUpload(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// NOTE: In router mode we require deal_id in the URL query string so we can
	// route without parsing the multipart body. The provider will still accept
	// deal_id in the multipart form for compatibility.
	dealID, ok := requireDealIDQuery(w, r)
	if !ok {
		return
	}
	providerAddr, err := resolveDealAssignedProvider(r.Context(), dealID)
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, ErrDealNotFound) {
			status = http.StatusNotFound
		}
		writeJSONError(w, status, "failed to resolve deal provider", err.Error())
		return
	}
	baseURL, err := resolveProviderHTTPBaseURL(r.Context(), providerAddr)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "failed to resolve provider endpoint", err.Error())
		return
	}
	proxyToProviderBaseURL(w, r, baseURL)
}

func forwardJSONToProviderBase(w http.ResponseWriter, r *http.Request, providerBaseURL string, path string, body []byte) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	target := strings.TrimRight(strings.TrimSpace(providerBaseURL), "/") + path
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to create provider request", err.Error())
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(gatewayAuthHeader, gatewayToProviderAuthToken())

	resp, err := routerHTTPClient.Do(req)
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

func RouterGatewaySubmitReceipt(w http.ResponseWriter, r *http.Request) {
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

	var env struct {
		Receipt struct {
			Provider string `json:"provider"`
		} `json:"receipt"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid JSON", "")
		return
	}
	providerAddr := strings.TrimSpace(env.Receipt.Provider)
	if providerAddr == "" {
		writeJSONError(w, http.StatusBadRequest, "receipt.provider is required", "")
		return
	}

	baseURL, err := resolveProviderHTTPBaseURL(r.Context(), providerAddr)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "failed to resolve provider endpoint", err.Error())
		return
	}
	forwardJSONToProviderBase(w, r, baseURL, "/sp/receipt", body)
}

func RouterGatewaySubmitReceipts(w http.ResponseWriter, r *http.Request) {
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

	var env struct {
		Receipts []struct {
			Receipt struct {
				Provider string `json:"provider"`
			} `json:"receipt"`
		} `json:"receipts"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid JSON", "")
		return
	}
	providerAddr := ""
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
			writeJSONError(w, http.StatusBadRequest, "batch must target a single provider", "")
			return
		}
	}
	if providerAddr == "" {
		writeJSONError(w, http.StatusBadRequest, "receipt.provider is required", "")
		return
	}

	baseURL, err := resolveProviderHTTPBaseURL(r.Context(), providerAddr)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "failed to resolve provider endpoint", err.Error())
		return
	}
	forwardJSONToProviderBase(w, r, baseURL, "/sp/receipts", body)
}

func RouterGatewaySubmitSessionReceipt(w http.ResponseWriter, r *http.Request) {
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

	var env struct {
		Receipt struct {
			Provider string `json:"provider"`
		} `json:"receipt"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid JSON", "")
		return
	}
	providerAddr := strings.TrimSpace(env.Receipt.Provider)
	if providerAddr == "" {
		writeJSONError(w, http.StatusBadRequest, "receipt.provider is required", "")
		return
	}

	baseURL, err := resolveProviderHTTPBaseURL(r.Context(), providerAddr)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "failed to resolve provider endpoint", err.Error())
		return
	}
	forwardJSONToProviderBase(w, r, baseURL, "/sp/session-receipt", body)
}

func RouterGatewaySubmitRetrievalSessionProof(w http.ResponseWriter, r *http.Request) {
	RouterGatewayFetch(w, r)
}

func isGatewayRouterMode() bool {
	return strings.TrimSpace(os.Getenv("NIL_GATEWAY_ROUTER")) == "1"
}

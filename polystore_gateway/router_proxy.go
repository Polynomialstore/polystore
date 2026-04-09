package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

var routerHTTPClient = &http.Client{
	Transport: &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   4 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		TLSHandshakeTimeout:   4 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		// Some provider requests (especially /gateway/upload which may ingest + upload
		// Mode 2 stripes) can take longer than a few seconds before responding.
		// Keep this generous so local-stack/E2E doesn't flake on slow machines/CI.
		ResponseHeaderTimeout: 2 * time.Minute,
		IdleConnTimeout:       90 * time.Second,
		MaxIdleConns:          128,
	},
}

func copyUpstreamResponseHeaders(dst http.Header, src http.Header) {
	for k, vals := range src {
		// Router handlers apply canonical CORS headers at the edge.
		// Avoid duplicating provider Access-Control-* headers, which can produce
		// invalid values such as "origin, origin" and break browser fetches.
		if strings.HasPrefix(strings.ToLower(strings.TrimSpace(k)), "access-control-") {
			continue
		}
		for _, v := range vals {
			dst.Add(k, v)
		}
	}
}

func mapGatewayPathToProviderPath(path string) string {
	switch {
	case path == "/gateway/upload":
		return "/sp/retrieval/upload"
	case path == "/gateway/upload-status":
		return "/sp/retrieval/upload-status"
	case strings.HasPrefix(path, "/gateway/download/"):
		return "/sp/retrieval/download/" + strings.TrimPrefix(path, "/gateway/download/")
	case strings.HasPrefix(path, "/gateway/fetch/"):
		return "/sp/retrieval/fetch/" + strings.TrimPrefix(path, "/gateway/fetch/")
	case strings.HasPrefix(path, "/gateway/debug/raw-fetch/"):
		return "/sp/retrieval/debug/raw-fetch/" + strings.TrimPrefix(path, "/gateway/debug/raw-fetch/")
	case strings.HasPrefix(path, "/gateway/plan-retrieval-session/"):
		return "/sp/retrieval/plan/" + strings.TrimPrefix(path, "/gateway/plan-retrieval-session/")
	case strings.HasPrefix(path, "/gateway/list-files/"):
		return "/sp/retrieval/list-files/" + strings.TrimPrefix(path, "/gateway/list-files/")
	case strings.HasPrefix(path, "/gateway/slab/"):
		return "/sp/retrieval/slab/" + strings.TrimPrefix(path, "/gateway/slab/")
	case strings.HasPrefix(path, "/gateway/manifest-info/"):
		return "/sp/retrieval/manifest-info/" + strings.TrimPrefix(path, "/gateway/manifest-info/")
	case strings.HasPrefix(path, "/gateway/mdu/"):
		return "/sp/retrieval/mdu/" + strings.TrimPrefix(path, "/gateway/mdu/")
	case strings.HasPrefix(path, "/gateway/mdu-kzg/"):
		return "/sp/retrieval/mdu-kzg/" + strings.TrimPrefix(path, "/gateway/mdu-kzg/")
	case strings.HasPrefix(path, "/gateway/open-session/"):
		return "/sp/retrieval/open-session/" + strings.TrimPrefix(path, "/gateway/open-session/")
	case path == "/gateway/prove-retrieval":
		return "/sp/retrieval/prove-retrieval"
	default:
		return path
	}
}

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

	targetPath := mapGatewayPathToProviderPath(r.URL.Path)
	target := base + targetPath
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

	copyUpstreamResponseHeaders(w.Header(), resp.Header)
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

func tryProxyToProviderBaseURL(w http.ResponseWriter, r *http.Request, providerBaseURL string) (bool, error) {
	base := strings.TrimRight(strings.TrimSpace(providerBaseURL), "/")
	if base == "" {
		return false, fmt.Errorf("provider base url is empty")
	}

	targetPath := mapGatewayPathToProviderPath(r.URL.Path)
	target := base + targetPath
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}

	ctx := r.Context()
	if ctx == nil {
		ctx = context.Background()
	}
	req, err := http.NewRequestWithContext(ctx, r.Method, target, nil)
	if err != nil {
		return false, err
	}
	req.Header = r.Header.Clone()
	req.Header.Set(gatewayAuthHeader, gatewayToProviderAuthToken())

	resp, err := routerHTTPClient.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()

	// Slot mismatch is a router concern (Mode 2): treat it as a routing miss so we can
	// try another provider without leaking a confusing 400 back to the client.
	if resp.StatusCode == http.StatusBadRequest {
		bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		body := strings.TrimSpace(string(bodyBytes))
		if strings.Contains(body, "provider slot mismatch") {
			return false, fmt.Errorf("provider slot mismatch: %s", body)
		}

		// Not a routing miss: forward the 400 response to the client.
		copyUpstreamResponseHeaders(w.Header(), resp.Header)
		setCORS(w)
		w.WriteHeader(resp.StatusCode)
		_, copyErr := w.Write(bodyBytes)
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		return true, copyErr
	}

	// If this is an on-chain session fetch, a non-assigned provider will reject the
	// session unless deputy mode is enabled. Treat that as a routing miss so the router
	// can retry the request with `deputy=1` (or try other providers).
	if resp.StatusCode == http.StatusForbidden {
		bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		body := strings.TrimSpace(string(bodyBytes))
		if strings.TrimSpace(r.Header.Get("X-PolyStore-Session-Id")) != "" && strings.Contains(body, "session provider mismatch") {
			return false, fmt.Errorf("session provider mismatch: %s", body)
		}

		copyUpstreamResponseHeaders(w.Header(), resp.Header)
		setCORS(w)
		w.WriteHeader(resp.StatusCode)
		_, copyErr := w.Write(bodyBytes)
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		return true, copyErr
	}

	// If the provider is reachable but returns a 5xx, attempt failover to the next candidate.
	if resp.StatusCode >= http.StatusInternalServerError {
		bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		body := strings.TrimSpace(string(bodyBytes))
		if body == "" {
			body = resp.Status
		}
		return false, fmt.Errorf("provider returned %d: %s", resp.StatusCode, body)
	}

	copyUpstreamResponseHeaders(w.Header(), resp.Header)
	setCORS(w)
	w.WriteHeader(resp.StatusCode)

	_, copyErr := io.Copy(w, resp.Body)
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
	return true, copyErr
}

func bufferRequestBody(r *http.Request) (*os.File, int64, error) {
	tmpFile, err := os.CreateTemp("", "nil-router-upload-*")
	if err != nil {
		return nil, 0, err
	}
	defer func() {
		if err != nil {
			_ = tmpFile.Close()
		}
	}()

	size, copyErr := io.Copy(tmpFile, r.Body)
	if copyErr != nil {
		err = copyErr
		return nil, 0, err
	}
	if closeErr := r.Body.Close(); closeErr != nil && err == nil {
		err = closeErr
		return nil, 0, err
	}
	if _, seekErr := tmpFile.Seek(0, io.SeekStart); seekErr != nil {
		err = seekErr
		return nil, 0, err
	}
	return tmpFile, size, nil
}

func tryProxyUploadToProviderBaseURL(w http.ResponseWriter, r *http.Request, providerBaseURL string, bodyFile *os.File, contentLength int64) (bool, error) {
	base := strings.TrimRight(strings.TrimSpace(providerBaseURL), "/")
	if base == "" {
		return false, fmt.Errorf("provider base url is empty")
	}

	// Use a SectionReader so the HTTP client doesn't close the shared temp file
	// across provider retries.
	bodyReader := io.NewSectionReader(bodyFile, 0, contentLength)

	targetPath := mapGatewayPathToProviderPath(r.URL.Path)
	target := base + targetPath
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}

	ctx := r.Context()
	if ctx == nil {
		ctx = context.Background()
	}
	req, err := http.NewRequestWithContext(ctx, r.Method, target, bodyReader)
	if err != nil {
		return false, err
	}
	req.Header = r.Header.Clone()
	req.Header.Set(gatewayAuthHeader, gatewayToProviderAuthToken())
	req.ContentLength = contentLength

	resp, err := routerHTTPClient.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()

	// If the provider is reachable but returns a 5xx, attempt failover to the next candidate.
	if resp.StatusCode >= http.StatusInternalServerError {
		bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		body := strings.TrimSpace(string(bodyBytes))
		if body == "" {
			body = resp.Status
		}
		return false, fmt.Errorf("provider returned %d: %s", resp.StatusCode, body)
	}

	copyUpstreamResponseHeaders(w.Header(), resp.Header)
	setCORS(w)
	w.WriteHeader(resp.StatusCode)

	_, copyErr := io.Copy(w, resp.Body)
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
	return true, copyErr
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

func requireUploadIDQuery(w http.ResponseWriter, r *http.Request) (string, bool) {
	raw := strings.TrimSpace(r.URL.Query().Get("upload_id"))
	if raw == "" {
		writeJSONError(w, http.StatusBadRequest, "upload_id query parameter is required", "")
		return "", false
	}
	return raw, true
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

	isFetch := strings.HasPrefix(r.URL.Path, "/gateway/fetch/")
	gatewayDownloadMode := false
	if raw := strings.TrimSpace(r.URL.Query().Get("gateway_download")); raw != "" {
		switch strings.ToLower(raw) {
		case "1", "true", "yes", "y":
			gatewayDownloadMode = true
		}
	}
	if requireOnchainSession && isFetch {
		if !gatewayDownloadMode && strings.TrimSpace(r.Header.Get("X-PolyStore-Session-Id")) == "" {
			writeJSONError(w, http.StatusBadRequest, "missing X-PolyStore-Session-Id", "")
			return
		}
	}
	if isFetch && !gatewayDownloadMode && !requireRetrievalReqSig && strings.TrimSpace(r.Header.Get("Range")) == "" {
		writeJSONError(w, http.StatusBadRequest, "Range header is required", "unsigned fetches must be chunked")
		return
	}

	dealID, ok := requireDealIDQuery(w, r)
	if !ok {
		return
	}
	providers, err := resolveDealProviders(r.Context(), dealID)
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, ErrDealNotFound) {
			status = http.StatusNotFound
		}
		writeJSONError(w, status, "failed to resolve deal providers", err.Error())
		return
	}

	// For Mode 2 deals, the router doesn't have enough local context to compute the
	// exact slot provider for an arbitrary file range. Instead, it tries each
	// assigned provider until it finds one that can serve the request. If all
	// providers reject with a slot mismatch (or if the correct provider is down),
	// fall back to "deputy" mode which allows any provider to reconstruct from K
	// shards and serve the request.
	origRawQuery := r.URL.RawQuery

	var lastErr error
	for _, providerAddr := range providers {
		baseURL, err := resolveProviderHTTPBaseURL(r.Context(), providerAddr)
		if err != nil {
			lastErr = err
			continue
		}
		ok, err := tryProxyToProviderBaseURL(w, r, baseURL)
		if ok {
			dealProviderCache.Store(dealID, &dealProviderCacheEntry{
				provider: providerAddr,
				expires:  time.Now().Add(dealProviderTTL),
			})
			if err != nil {
				// The provider response already started streaming to the client.
				// We can't safely failover, but keep the error for logging/visibility.
				lastErr = err
			}
			return
		}
		if err != nil {
			lastErr = err
		}
	}

	if isFetch {
		q := r.URL.Query()
		if strings.TrimSpace(q.Get("deputy")) == "" {
			q.Set("deputy", "1")
			r.URL.RawQuery = q.Encode()
		}

		for _, providerAddr := range providers {
			baseURL, err := resolveProviderHTTPBaseURL(r.Context(), providerAddr)
			if err != nil {
				lastErr = err
				continue
			}
			ok, err := tryProxyToProviderBaseURL(w, r, baseURL)
			if ok {
				dealProviderCache.Store(dealID, &dealProviderCacheEntry{
					provider: providerAddr,
					expires:  time.Now().Add(dealProviderTTL),
				})
				if err != nil {
					lastErr = err
				}
				r.URL.RawQuery = origRawQuery
				return
			}
			if err != nil {
				lastErr = err
			}
		}
	}

	msg := "failed to contact provider"
	detail := ""
	if lastErr != nil {
		detail = lastErr.Error()
	}
	writeJSONError(w, http.StatusBadGateway, msg, detail)

	if isFetch {
		r.URL.RawQuery = origRawQuery
	}
}

func RouterGatewayListFiles(w http.ResponseWriter, r *http.Request) { RouterGatewayFetch(w, r) }
func RouterGatewaySlab(w http.ResponseWriter, r *http.Request)      { RouterGatewayFetch(w, r) }
func RouterGatewayManifestInfo(w http.ResponseWriter, r *http.Request) {
	RouterGatewayFetch(w, r)
}
func RouterGatewayDownload(w http.ResponseWriter, r *http.Request) { RouterGatewayFetch(w, r) }
func RouterGatewayMdu(w http.ResponseWriter, r *http.Request)      { RouterGatewayFetch(w, r) }
func RouterGatewayMduKzg(w http.ResponseWriter, r *http.Request) { RouterGatewayFetch(w, r) }
func RouterGatewayDebugRawFetch(w http.ResponseWriter, r *http.Request) {
	if requireOnchainSession {
		if strings.TrimSpace(r.Header.Get("X-PolyStore-Session-Id")) == "" {
			writeJSONError(w, http.StatusBadRequest, "missing X-PolyStore-Session-Id", "")
			return
		}
	}
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
	providers, err := resolveDealProviders(r.Context(), dealID)
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, ErrDealNotFound) {
			status = http.StatusNotFound
		}
		writeJSONError(w, status, "failed to resolve deal providers", err.Error())
		return
	}

	tmpFile, size, err := bufferRequestBody(r)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "failed to read upload body", err.Error())
		return
	}
	defer func() {
		tmpPath := tmpFile.Name()
		if err := tmpFile.Close(); err == nil {
			_ = os.Remove(tmpPath)
		}
	}()

	var lastErr error
	for _, providerAddr := range providers {
		baseURL, err := resolveProviderHTTPBaseURL(r.Context(), providerAddr)
		if err != nil {
			lastErr = err
			continue
		}
		ok, err := tryProxyUploadToProviderBaseURL(w, r, baseURL, tmpFile, size)
		if ok {
			dealProviderCache.Store(dealID, &dealProviderCacheEntry{
				provider: providerAddr,
				expires:  time.Now().Add(dealProviderTTL),
			})
			return
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("no providers available")
	}
	writeJSONError(w, http.StatusBadGateway, "failed to contact provider", lastErr.Error())
}

func RouterGatewayUploadStatus(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	dealID, ok := requireDealIDQuery(w, r)
	if !ok {
		return
	}
	if _, ok := requireUploadIDQuery(w, r); !ok {
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
		SessionID string `json:"session_id"`
		Provider  string `json:"provider"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid JSON", "expected {session_id, provider}")
		return
	}

	providerAddr := strings.TrimSpace(env.Provider)
	if providerAddr == "" {
		writeJSONError(w, http.StatusBadRequest, "provider is required", "")
		return
	}

	baseURL, err := resolveProviderHTTPBaseURL(r.Context(), providerAddr)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "failed to resolve provider endpoint", err.Error())
		return
	}
	forwardJSONToProviderBase(w, r, baseURL, "/sp/session-proof", body)
}

func isGatewayRouterMode() bool {
	raw := strings.TrimSpace(os.Getenv("POLYSTORE_GATEWAY_ROUTER"))
	if raw == "" {
		raw = strings.TrimSpace(os.Getenv("POLYSTORE_GATEWAY_ROUTER_MODE"))
	}
	return raw == "1" || strings.EqualFold(raw, "true")
}

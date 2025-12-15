package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

type dealProviderCacheEntry struct {
	provider string
	expires  time.Time
}

type providerBaseCacheEntry struct {
	baseURL string
	expires time.Time
}

var (
	dealProviderCache  sync.Map // map[uint64]*dealProviderCacheEntry
	providerBaseCache  sync.Map // map[string]*providerBaseCacheEntry
	providerCacheTTL   = 30 * time.Second
	dealProviderTTL    = 10 * time.Second
	errNoHTTPMultiaddr = errors.New("no supported http multiaddr")
)

func sleepWithContext(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

func isRetryableLCDStatus(code int) bool {
	return code == http.StatusTooManyRequests ||
		code == http.StatusBadGateway ||
		code == http.StatusServiceUnavailable ||
		code == http.StatusGatewayTimeout ||
		code == http.StatusInternalServerError
}

func httpBaseURLFromMultiaddr(endpoint string) (string, error) {
	ep := strings.TrimSpace(endpoint)
	if ep == "" {
		return "", fmt.Errorf("empty endpoint")
	}
	if !strings.HasPrefix(ep, "/") {
		return "", fmt.Errorf("not a multiaddr: %q", ep)
	}

	parts := strings.Split(strings.TrimPrefix(ep, "/"), "/")
	// Supported forms:
	// - /ip4/<ip>/tcp/<port>/http
	// - /ip6/<ip>/tcp/<port>/http
	// - /dns4/<host>/tcp/<port>/http
	// - /dns6/<host>/tcp/<port>/http
	// - /dns/<host>/tcp/<port>/http
	if len(parts) != 5 {
		return "", fmt.Errorf("unsupported multiaddr shape: %q", ep)
	}
	addrProto := parts[0]
	addr := parts[1]
	if parts[2] != "tcp" {
		return "", fmt.Errorf("unsupported multiaddr (expected /tcp): %q", ep)
	}
	portStr := parts[3]
	scheme := parts[4]
	if scheme != "http" && scheme != "https" {
		return "", fmt.Errorf("unsupported multiaddr (expected /http or /https): %q", ep)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port <= 0 || port > 65535 {
		return "", fmt.Errorf("invalid tcp port in multiaddr: %q", ep)
	}

	host := addr
	switch addrProto {
	case "ip4":
		ip := net.ParseIP(addr)
		if ip == nil || ip.To4() == nil {
			return "", fmt.Errorf("invalid ip4 in multiaddr: %q", ep)
		}
	case "ip6":
		ip := net.ParseIP(addr)
		if ip == nil || ip.To16() == nil || ip.To4() != nil {
			return "", fmt.Errorf("invalid ip6 in multiaddr: %q", ep)
		}
		host = "[" + addr + "]"
	case "dns", "dns4", "dns6":
		if strings.TrimSpace(addr) == "" {
			return "", fmt.Errorf("empty dns host in multiaddr: %q", ep)
		}
	default:
		return "", fmt.Errorf("unsupported address protocol in multiaddr: %q", ep)
	}

	return fmt.Sprintf("%s://%s:%d", scheme, host, port), nil
}

func fetchDealProvidersFromLCD(ctx context.Context, dealID uint64) ([]string, error) {
	url := fmt.Sprintf("%s/nilchain/nilchain/v1/deals/%d", lcdBase, dealID)
	var lastBody string
	for attempt := 1; attempt <= 10; attempt++ {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		resp, err := lcdHTTPClient.Do(req)
		if err != nil {
			return nil, fmt.Errorf("LCD request failed: %w", err)
		}

		bodyBytes, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		lastBody = strings.TrimSpace(string(bodyBytes))

		if resp.StatusCode == http.StatusOK {
			var payload struct {
				Deal struct {
					Providers []string `json:"providers"`
				} `json:"deal"`
			}
			if err := json.Unmarshal(bodyBytes, &payload); err != nil {
				return nil, fmt.Errorf("failed to decode LCD response: %w", err)
			}

			out := make([]string, 0, len(payload.Deal.Providers))
			for _, p := range payload.Deal.Providers {
				p = strings.TrimSpace(p)
				if p == "" {
					continue
				}
				out = append(out, p)
			}
			return out, nil
		}

		if resp.StatusCode == http.StatusNotFound {
			return nil, ErrDealNotFound
		}
		if !isRetryableLCDStatus(resp.StatusCode) || attempt == 10 {
			return nil, fmt.Errorf("LCD returned %d: %s", resp.StatusCode, lastBody)
		}

		if err := sleepWithContext(ctx, time.Duration(attempt)*150*time.Millisecond); err != nil {
			return nil, err
		}
	}
	return nil, fmt.Errorf("LCD returned 500: %s", lastBody)
}

func fetchProviderEndpointsFromLCD(ctx context.Context, providerAddr string) ([]string, error) {
	url := fmt.Sprintf("%s/nilchain/nilchain/v1/providers/%s", lcdBase, providerAddr)
	var lastBody string
	for attempt := 1; attempt <= 10; attempt++ {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		resp, err := lcdHTTPClient.Do(req)
		if err != nil {
			return nil, fmt.Errorf("LCD request failed: %w", err)
		}

		bodyBytes, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		lastBody = strings.TrimSpace(string(bodyBytes))

		if resp.StatusCode == http.StatusOK {
			var payload struct {
				Provider struct {
					Endpoints []string `json:"endpoints"`
				} `json:"provider"`
			}
			if err := json.Unmarshal(bodyBytes, &payload); err != nil {
				return nil, fmt.Errorf("failed to decode LCD response: %w", err)
			}

			out := make([]string, 0, len(payload.Provider.Endpoints))
			for _, ep := range payload.Provider.Endpoints {
				ep = strings.TrimSpace(ep)
				if ep == "" {
					continue
				}
				out = append(out, ep)
			}
			return out, nil
		}

		if !isRetryableLCDStatus(resp.StatusCode) || attempt == 10 {
			return nil, fmt.Errorf("LCD returned %d: %s", resp.StatusCode, lastBody)
		}

		if err := sleepWithContext(ctx, time.Duration(attempt)*150*time.Millisecond); err != nil {
			return nil, err
		}
	}
	return nil, fmt.Errorf("LCD returned 500: %s", lastBody)
}

func resolveDealAssignedProvider(ctx context.Context, dealID uint64) (string, error) {
	if cachedAny, ok := dealProviderCache.Load(dealID); ok {
		cached := cachedAny.(*dealProviderCacheEntry)
		if time.Now().Before(cached.expires) && cached.provider != "" {
			return cached.provider, nil
		}
	}

	var providers []string
	var err error
	for attempt := 1; attempt <= 60; attempt++ {
		providers, err = fetchDealProvidersFromLCD(ctx, dealID)
		if err == nil {
			break
		}
		if !errors.Is(err, ErrDealNotFound) || attempt == 60 {
			return "", err
		}
		if err := sleepWithContext(ctx, 250*time.Millisecond); err != nil {
			return "", err
		}
	}
	if len(providers) == 0 {
		return "", fmt.Errorf("deal %d has no assigned providers", dealID)
	}

	assigned := providers[0]
	dealProviderCache.Store(dealID, &dealProviderCacheEntry{
		provider: assigned,
		expires:  time.Now().Add(dealProviderTTL),
	})
	return assigned, nil
}

func resolveProviderHTTPBaseURL(ctx context.Context, providerAddr string) (string, error) {
	key := strings.TrimSpace(providerAddr)
	if key == "" {
		return "", fmt.Errorf("provider address is required")
	}

	if cachedAny, ok := providerBaseCache.Load(key); ok {
		cached := cachedAny.(*providerBaseCacheEntry)
		if time.Now().Before(cached.expires) && cached.baseURL != "" {
			return cached.baseURL, nil
		}
	}

	endpoints, err := fetchProviderEndpointsFromLCD(ctx, key)
	if err != nil {
		return "", err
	}

	for _, ep := range endpoints {
		baseURL, err := httpBaseURLFromMultiaddr(ep)
		if err != nil {
			continue
		}
		providerBaseCache.Store(key, &providerBaseCacheEntry{
			baseURL: baseURL,
			expires: time.Now().Add(providerCacheTTL),
		})
		return baseURL, nil
	}

	return "", fmt.Errorf("%w for provider %s", errNoHTTPMultiaddr, key)
}

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
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

type dealProviderCacheEntry struct {
	provider string
	expires  time.Time
}

type dealProvidersCacheEntry struct {
	providers []string
	expires   time.Time
}

type dealHintCacheEntry struct {
	hint    string
	expires time.Time
}

type dealMode2SlotsCacheEntry struct {
	slots   []mode2SlotAssignment
	expires time.Time
}

type providerBaseCacheEntry struct {
	baseURL string
	expires time.Time
}

type providerP2PCacheEntry struct {
	addrs   []string
	expires time.Time
}

type mode2SlotAssignment struct {
	Provider        string
	PendingProvider string
	Status          int
}

var (
	dealProviderCache                        sync.Map // map[uint64]*dealProviderCacheEntry
	dealProvidersCache                       sync.Map // map[uint64]*dealProvidersCacheEntry
	dealHintCache                            sync.Map // map[uint64]*dealHintCacheEntry
	dealMode2SlotsCache                      sync.Map // map[uint64]*dealMode2SlotsCacheEntry
	providerBaseCache                        sync.Map // map[string]*providerBaseCacheEntry
	providerP2PCache                         sync.Map // map[string]*providerP2PCacheEntry
	providerCacheTTL                         = 30 * time.Second
	dealProviderTTL                          = 10 * time.Second
	dealHintTTL                              = 10 * time.Second
	errNoHTTPMultiaddr                       = errors.New("no supported http multiaddr")
	ErrProviderResolutionMetadataUnavailable = errors.New("provider metadata unavailable")
	ErrProviderResolutionMetadataInvalid     = errors.New("provider metadata invalid")
	ErrProviderResolutionSlotOutOfRange      = errors.New("provider slot out of range")
)

func allowPlanProviderFallback() bool {
	raw := strings.ToLower(strings.TrimSpace(os.Getenv("NIL_ALLOW_PLAN_PROVIDER_FALLBACK")))
	return raw == "1" || raw == "true" || raw == "yes" || raw == "on"
}

type retrievalProviderResolution struct {
	Provider          string
	Source            string
	UsedLocalFallback bool
}

func providerHTTPBaseOverrides() map[string]string {
	raw := strings.TrimSpace(os.Getenv("NIL_PROVIDER_HTTP_BASE_OVERRIDES"))
	if raw == "" {
		return nil
	}

	overrides := make(map[string]string)
	for _, entry := range strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ';' || r == '\n'
	}) {
		pair := strings.TrimSpace(entry)
		if pair == "" {
			continue
		}
		parts := strings.SplitN(pair, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key := normalizeProviderOverrideKey(parts[0])
		base := normalizeProviderOverrideBase(parts[1])
		if key == "" || base == "" {
			continue
		}
		overrides[key] = base
	}
	if len(overrides) == 0 {
		return nil
	}
	return overrides
}

func normalizeProviderOverrideKey(raw string) string {
	key := strings.ToLower(strings.TrimSpace(raw))
	key = strings.TrimRight(key, "/")
	return key
}

func normalizeProviderOverrideBase(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return ""
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return ""
	}
	path := strings.TrimRight(parsed.EscapedPath(), "/")
	if path == "" || path == "." {
		return fmt.Sprintf("%s://%s", scheme, parsed.Host)
	}
	return fmt.Sprintf("%s://%s%s", scheme, parsed.Host, path)
}

func lookupProviderOverride(overrides map[string]string, key string) (string, bool) {
	if len(overrides) == 0 {
		return "", false
	}
	normalized := normalizeProviderOverrideKey(key)
	if normalized == "" {
		return "", false
	}
	base, ok := overrides[normalized]
	return base, ok && base != ""
}

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

func parseMode2SlotStatus(raw json.RawMessage) int {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return 0
	}
	var statusStr string
	if err := json.Unmarshal(raw, &statusStr); err == nil {
		switch strings.ToUpper(strings.TrimSpace(statusStr)) {
		case "SLOT_STATUS_ACTIVE":
			return 1
		case "SLOT_STATUS_REPAIRING":
			return 2
		default:
			return 0
		}
	}
	var statusInt int
	if err := json.Unmarshal(raw, &statusInt); err == nil {
		return statusInt
	}
	var statusFloat float64
	if err := json.Unmarshal(raw, &statusFloat); err == nil {
		return int(statusFloat)
	}
	return 0
}

func resolveProviderForRetrievalPlan(ctx context.Context, dealID uint64, stripe stripeParams, mode2Slot uint64) (retrievalProviderResolution, error) {
	fallbackToLocal := func(metadataErr error) (retrievalProviderResolution, error) {
		if !allowPlanProviderFallback() {
			if metadataErr != nil {
				return retrievalProviderResolution{}, fmt.Errorf(
					"%w: metadata lookup failed: %v; set NIL_ALLOW_PLAN_PROVIDER_FALLBACK=1 to force fallback",
					ErrProviderResolutionMetadataUnavailable,
					metadataErr,
				)
			}
			return retrievalProviderResolution{}, fmt.Errorf(
				"%w: local provider fallback disabled; set NIL_ALLOW_PLAN_PROVIDER_FALLBACK=1 to force fallback",
				ErrProviderResolutionMetadataUnavailable,
			)
		}

		localProvider := strings.TrimSpace(cachedProviderAddress(ctx))
		if localProvider == "" {
			if metadataErr != nil {
				return retrievalProviderResolution{}, fmt.Errorf(
					"%w: metadata lookup failed: %v; local provider fallback unavailable",
					ErrProviderResolutionMetadataUnavailable,
					metadataErr,
				)
			}
			return retrievalProviderResolution{}, fmt.Errorf(
				"%w: local provider fallback unavailable",
				ErrProviderResolutionMetadataUnavailable,
			)
		}
		return retrievalProviderResolution{
			Provider:          localProvider,
			Source:            "local_cached_provider_fallback",
			UsedLocalFallback: true,
		}, nil
	}

	if stripe.mode == 2 {
		slots, err := resolveDealMode2Slots(ctx, dealID)
		if err != nil {
			return fallbackToLocal(fmt.Errorf("resolve mode2 slots for deal %d: %w", dealID, err))
		}
		if int(mode2Slot) >= len(slots) {
			return retrievalProviderResolution{}, fmt.Errorf(
				"%w: deal_id=%d slot=%d slots=%d",
				ErrProviderResolutionSlotOutOfRange,
				dealID,
				mode2Slot,
				len(slots),
			)
		}

		assign := slots[mode2Slot]
		provider := strings.TrimSpace(assign.Provider)
		source := "mode2_slot_provider"
		if assign.Status == 2 {
			if pending := strings.TrimSpace(assign.PendingProvider); pending != "" {
				provider = pending
				source = "mode2_slot_pending_provider"
			}
		}
		if provider == "" {
			return retrievalProviderResolution{}, fmt.Errorf(
				"%w: deal_id=%d slot=%d status=%d",
				ErrProviderResolutionMetadataInvalid,
				dealID,
				mode2Slot,
				assign.Status,
			)
		}

		dealProviderCache.Store(dealID, &dealProviderCacheEntry{
			provider: provider,
			expires:  time.Now().Add(dealProviderTTL),
		})
		return retrievalProviderResolution{
			Provider: provider,
			Source:   source,
		}, nil
	}

	providers, err := fetchDealProvidersFromLCD(ctx, dealID)
	if err != nil {
		return fallbackToLocal(fmt.Errorf("fetch deal providers for deal %d: %w", dealID, err))
	}
	if len(providers) == 0 {
		return retrievalProviderResolution{}, fmt.Errorf(
			"%w: deal_id=%d has no assigned providers",
			ErrProviderResolutionMetadataInvalid,
			dealID,
		)
	}
	provider := strings.TrimSpace(providers[0])
	if provider == "" {
		return retrievalProviderResolution{}, fmt.Errorf(
			"%w: deal_id=%d providers[0] is empty",
			ErrProviderResolutionMetadataInvalid,
			dealID,
		)
	}

	dealProviderCache.Store(dealID, &dealProviderCacheEntry{
		provider: provider,
		expires:  time.Now().Add(dealProviderTTL),
	})
	return retrievalProviderResolution{
		Provider: provider,
		Source:   "deal_metadata_provider",
	}, nil
}

func fetchDealProvidersFromLCD(ctx context.Context, dealID uint64) ([]string, error) {
	url := fmt.Sprintf("%s/polystorechain/polystorechain/v1/deals/%d", lcdBase, dealID)
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
			type dealSlot struct {
				Provider        string          `json:"provider"`
				PendingProvider string          `json:"pending_provider"`
				Status          json.RawMessage `json:"status"`
			}

			var payload struct {
				Deal struct {
					Providers  []string   `json:"providers"`
					Mode2Slots []dealSlot `json:"mode2_slots"`
				} `json:"deal"`
			}
			if err := json.Unmarshal(bodyBytes, &payload); err != nil {
				return nil, fmt.Errorf("failed to decode LCD response: %w", err)
			}

			out := make([]string, 0, len(payload.Deal.Providers))
			for _, p := range payload.Deal.Providers {
				if p = strings.TrimSpace(p); p != "" {
					out = append(out, p)
				}
			}

			if len(payload.Deal.Mode2Slots) > 0 {
				active := make([]string, 0, len(payload.Deal.Mode2Slots))
				repairing := make([]string, 0, len(payload.Deal.Mode2Slots))
				unknown := make([]string, 0, len(payload.Deal.Mode2Slots))

				for _, slot := range payload.Deal.Mode2Slots {
					p := strings.TrimSpace(slot.Provider)
					pending := strings.TrimSpace(slot.PendingProvider)
					if p == "" && pending == "" {
						continue
					}
					switch parseMode2SlotStatus(slot.Status) {
					case 1:
						if p != "" {
							active = append(active, p)
						}
					case 2:
						// When a slot is repairing, prefer routing to the pending provider
						// (make-before-break) and de-prioritize the outgoing provider.
						if pending != "" {
							active = append(active, pending)
						}
						if p != "" {
							repairing = append(repairing, p)
						}
					default:
						if p != "" {
							unknown = append(unknown, p)
						}
					}
				}

				ordered := make([]string, 0, len(active)+len(unknown)+len(repairing)+len(out))
				seen := make(map[string]bool, len(active)+len(unknown)+len(repairing)+len(out))
				appendUnique := func(values []string) {
					for _, v := range values {
						if v == "" || seen[v] {
							continue
						}
						seen[v] = true
						ordered = append(ordered, v)
					}
				}
				appendUnique(active)
				appendUnique(unknown)
				appendUnique(repairing)

				// Preserve any legacy providers that are not in mode2_slots (e.g. pre-migration deals).
				appendUnique(out)

				if len(ordered) > 0 {
					return ordered, nil
				}
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

func fetchDealMode2SlotsFromLCD(ctx context.Context, dealID uint64) ([]mode2SlotAssignment, error) {
	url := fmt.Sprintf("%s/polystorechain/polystorechain/v1/deals/%d", lcdBase, dealID)
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
			type dealSlot struct {
				Slot            uint64          `json:"slot"`
				Provider        string          `json:"provider"`
				PendingProvider string          `json:"pending_provider"`
				Status          json.RawMessage `json:"status"`
			}

			var payload struct {
				Deal struct {
					Providers  []string   `json:"providers"`
					Mode2Slots []dealSlot `json:"mode2_slots"`
				} `json:"deal"`
			}
			if err := json.Unmarshal(bodyBytes, &payload); err != nil {
				return nil, fmt.Errorf("failed to decode LCD response: %w", err)
			}
			if len(payload.Deal.Mode2Slots) == 0 {
				if len(payload.Deal.Providers) == 0 {
					return nil, fmt.Errorf("deal %d has no providers", dealID)
				}
				slots := make([]mode2SlotAssignment, 0, len(payload.Deal.Providers))
				for i, p := range payload.Deal.Providers {
					p = strings.TrimSpace(p)
					if p == "" {
						return nil, fmt.Errorf("deal %d providers[%d] is empty", dealID, i)
					}
					slots = append(slots, mode2SlotAssignment{
						Provider: p,
						Status:   1,
					})
				}
				return slots, nil
			}

			var maxSlot uint64
			seen := make(map[uint64]struct{}, len(payload.Deal.Mode2Slots))
			for _, slot := range payload.Deal.Mode2Slots {
				if _, ok := seen[slot.Slot]; ok {
					return nil, fmt.Errorf("duplicate mode2_slots entry for slot %d", slot.Slot)
				}
				seen[slot.Slot] = struct{}{}
				if slot.Slot > maxSlot {
					maxSlot = slot.Slot
				}
			}

			slots := make([]mode2SlotAssignment, maxSlot+1)
			for _, slot := range payload.Deal.Mode2Slots {
				slots[slot.Slot] = mode2SlotAssignment{
					Provider:        strings.TrimSpace(slot.Provider),
					PendingProvider: strings.TrimSpace(slot.PendingProvider),
					Status:          parseMode2SlotStatus(slot.Status),
				}
			}
			return slots, nil
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

func resolveDealMode2Slots(ctx context.Context, dealID uint64) ([]mode2SlotAssignment, error) {
	if cachedAny, ok := dealMode2SlotsCache.Load(dealID); ok {
		cached := cachedAny.(*dealMode2SlotsCacheEntry)
		if time.Now().Before(cached.expires) && len(cached.slots) > 0 {
			out := make([]mode2SlotAssignment, len(cached.slots))
			copy(out, cached.slots)
			return out, nil
		}
	}

	var slots []mode2SlotAssignment
	var err error
	for attempt := 1; attempt <= 60; attempt++ {
		slots, err = fetchDealMode2SlotsFromLCD(ctx, dealID)
		if err == nil {
			break
		}
		if !errors.Is(err, ErrDealNotFound) || attempt == 60 {
			return nil, err
		}
		if err := sleepWithContext(ctx, 250*time.Millisecond); err != nil {
			return nil, err
		}
	}
	if len(slots) == 0 {
		return nil, fmt.Errorf("deal %d has no mode2_slots", dealID)
	}

	copied := make([]mode2SlotAssignment, len(slots))
	copy(copied, slots)
	dealMode2SlotsCache.Store(dealID, &dealMode2SlotsCacheEntry{
		slots:   copied,
		expires: time.Now().Add(dealProviderTTL),
	})

	out := make([]mode2SlotAssignment, len(copied))
	copy(out, copied)
	return out, nil
}

func fetchDealServiceHintFromLCD(ctx context.Context, dealID uint64) (string, error) {
	if cachedAny, ok := dealHintCache.Load(dealID); ok {
		cached := cachedAny.(*dealHintCacheEntry)
		if time.Now().Before(cached.expires) {
			return cached.hint, nil
		}
	}

	url := fmt.Sprintf("%s/polystorechain/polystorechain/v1/deals/%d", lcdBase, dealID)
	var lastBody string
	for attempt := 1; attempt <= 10; attempt++ {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		resp, err := lcdHTTPClient.Do(req)
		if err != nil {
			return "", fmt.Errorf("LCD request failed: %w", err)
		}

		bodyBytes, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		lastBody = strings.TrimSpace(string(bodyBytes))

		if resp.StatusCode == http.StatusOK {
			var payload struct {
				Deal struct {
					ServiceHint string `json:"service_hint"`
				} `json:"deal"`
			}
			if err := json.Unmarshal(bodyBytes, &payload); err != nil {
				return "", fmt.Errorf("failed to decode LCD response: %w", err)
			}
			hint := strings.TrimSpace(payload.Deal.ServiceHint)
			dealHintCache.Store(dealID, &dealHintCacheEntry{
				hint:    hint,
				expires: time.Now().Add(dealHintTTL),
			})
			return hint, nil
		}

		if resp.StatusCode == http.StatusNotFound {
			return "", ErrDealNotFound
		}
		if !isRetryableLCDStatus(resp.StatusCode) || attempt == 10 {
			return "", fmt.Errorf("LCD returned %d: %s", resp.StatusCode, lastBody)
		}

		if err := sleepWithContext(ctx, time.Duration(attempt)*150*time.Millisecond); err != nil {
			return "", err
		}
	}
	return "", fmt.Errorf("LCD returned 500: %s", lastBody)
}

func fetchProviderEndpointsFromLCD(ctx context.Context, providerAddr string) ([]string, error) {
	url := fmt.Sprintf("%s/polystorechain/polystorechain/v1/providers/%s", lcdBase, providerAddr)
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

func resolveDealProviders(ctx context.Context, dealID uint64) ([]string, error) {
	if cachedAny, ok := dealProvidersCache.Load(dealID); ok {
		cached := cachedAny.(*dealProvidersCacheEntry)
		if time.Now().Before(cached.expires) && len(cached.providers) > 0 {
			out := make([]string, len(cached.providers))
			copy(out, cached.providers)
			return out, nil
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
			return nil, err
		}
		if err := sleepWithContext(ctx, 250*time.Millisecond); err != nil {
			return nil, err
		}
	}
	if len(providers) == 0 {
		return nil, fmt.Errorf("deal %d has no assigned providers", dealID)
	}

	// If we have a cached "preferred" provider for this deal, rotate it to the front.
	if cachedAny, ok := dealProviderCache.Load(dealID); ok {
		cached := cachedAny.(*dealProviderCacheEntry)
		if time.Now().Before(cached.expires) && cached.provider != "" {
			for i, p := range providers {
				if p == cached.provider {
					if i > 0 {
						copy(providers[1:i+1], providers[0:i])
						providers[0] = p
					}
					break
				}
			}
		}
	}

	copied := make([]string, len(providers))
	copy(copied, providers)
	dealProvidersCache.Store(dealID, &dealProvidersCacheEntry{
		providers: copied,
		expires:   time.Now().Add(dealProviderTTL),
	})
	return copied, nil
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

	overrides := providerHTTPBaseOverrides()
	if override, ok := lookupProviderOverride(overrides, key); ok {
		providerBaseCache.Store(key, &providerBaseCacheEntry{
			baseURL: override,
			expires: time.Now().Add(providerCacheTTL),
		})
		return override, nil
	}

	endpoints, err := fetchProviderEndpointsFromLCD(ctx, key)
	if err != nil {
		return "", err
	}

	firstDiscovered := ""
	for _, ep := range endpoints {
		if override, ok := lookupProviderOverride(overrides, ep); ok {
			providerBaseCache.Store(key, &providerBaseCacheEntry{
				baseURL: override,
				expires: time.Now().Add(providerCacheTTL),
			})
			return override, nil
		}

		baseURL, err := httpBaseURLFromMultiaddr(ep)
		if err != nil {
			continue
		}
		if firstDiscovered == "" {
			firstDiscovered = baseURL
		}

		if override, ok := lookupProviderOverride(overrides, baseURL); ok {
			providerBaseCache.Store(key, &providerBaseCacheEntry{
				baseURL: override,
				expires: time.Now().Add(providerCacheTTL),
			})
			return override, nil
		}
		if parsed, err := url.Parse(baseURL); err == nil {
			if override, ok := lookupProviderOverride(overrides, parsed.Host); ok {
				providerBaseCache.Store(key, &providerBaseCacheEntry{
					baseURL: override,
					expires: time.Now().Add(providerCacheTTL),
				})
				return override, nil
			}
			if host := strings.TrimSpace(parsed.Hostname()); host != "" {
				if override, ok := lookupProviderOverride(overrides, host); ok {
					providerBaseCache.Store(key, &providerBaseCacheEntry{
						baseURL: override,
						expires: time.Now().Add(providerCacheTTL),
					})
					return override, nil
				}
			}
		}
	}

	if firstDiscovered != "" {
		providerBaseCache.Store(key, &providerBaseCacheEntry{
			baseURL: firstDiscovered,
			expires: time.Now().Add(providerCacheTTL),
		})
		return firstDiscovered, nil
	}

	return "", fmt.Errorf("%w for provider %s", errNoHTTPMultiaddr, key)
}

func p2pMultiaddrsFromEndpoints(endpoints []string) []string {
	out := make([]string, 0, len(endpoints))
	for _, ep := range endpoints {
		trimmed := strings.TrimSpace(ep)
		if trimmed == "" {
			continue
		}
		if !strings.Contains(trimmed, "/p2p/") {
			continue
		}
		if !strings.Contains(trimmed, "/ws") && !strings.Contains(trimmed, "/wss") {
			continue
		}
		out = append(out, trimmed)
	}
	return out
}

func resolveProviderP2PAddrs(ctx context.Context, providerAddr string) ([]string, error) {
	key := strings.TrimSpace(providerAddr)
	if key == "" {
		return nil, fmt.Errorf("provider address is required")
	}

	if cachedAny, ok := providerP2PCache.Load(key); ok {
		cached := cachedAny.(*providerP2PCacheEntry)
		if time.Now().Before(cached.expires) {
			return cached.addrs, nil
		}
	}

	endpoints, err := fetchProviderEndpointsFromLCD(ctx, key)
	if err != nil {
		return nil, err
	}

	addrs := p2pMultiaddrsFromEndpoints(endpoints)
	providerP2PCache.Store(key, &providerP2PCacheEntry{
		addrs:   addrs,
		expires: time.Now().Add(providerCacheTTL),
	})
	return addrs, nil
}

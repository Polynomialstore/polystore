package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
)

func TestFetchDealProvidersFromLCD_Mode2SlotsPrefersActive(t *testing.T) {
	origLCD := lcdBase
	t.Cleanup(func() { lcdBase = origLCD })

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/polystorechain/polystorechain/v1/deals/123" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"deal": {
				"providers": ["providerA", "providerB", "providerC", "providerD"],
				"mode2_slots": [
					{"slot": 0, "provider": "providerA", "status": "SLOT_STATUS_REPAIRING", "pending_provider": "providerZ"},
					{"slot": 1, "provider": "providerB", "status": "SLOT_STATUS_ACTIVE"},
					{"slot": 2, "provider": "providerC", "status": 1},
					{"slot": 3, "provider": "providerB", "status": 1}
				]
			}
		}`))
	}))
	t.Cleanup(srv.Close)
	lcdBase = srv.URL

	providers, err := fetchDealProvidersFromLCD(context.Background(), 123)
	if err != nil {
		t.Fatalf("fetchDealProvidersFromLCD returned error: %v", err)
	}

	// Pending providers for repairing slots should be preferred over outgoing providers
	// so router/deputy selection routes around repairing assignments.
	want := []string{"providerZ", "providerB", "providerC", "providerA", "providerD"}
	if len(providers) != len(want) {
		t.Fatalf("expected %d providers, got %d (%v)", len(want), len(providers), providers)
	}
	for i := range want {
		if providers[i] != want[i] {
			t.Fatalf("providers[%d] expected %q, got %q (full=%v)", i, want[i], providers[i], providers)
		}
	}
}

func TestFetchDealProvidersFromLCD_FallsBackToProvidersWhenNoMode2Slots(t *testing.T) {
	origLCD := lcdBase
	t.Cleanup(func() { lcdBase = origLCD })

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/polystorechain/polystorechain/v1/deals/7" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"deal": {
				"providers": ["p1", "p2"]
			}
		}`))
	}))
	t.Cleanup(srv.Close)
	lcdBase = srv.URL

	providers, err := fetchDealProvidersFromLCD(context.Background(), 7)
	if err != nil {
		t.Fatalf("fetchDealProvidersFromLCD returned error: %v", err)
	}
	want := []string{"p1", "p2"}
	if len(providers) != len(want) {
		t.Fatalf("expected %d providers, got %d (%v)", len(want), len(providers), providers)
	}
	for i := range want {
		if providers[i] != want[i] {
			t.Fatalf("providers[%d] expected %q, got %q (full=%v)", i, want[i], providers[i], providers)
		}
	}
}

func TestResolveDealMode2Slots_PreservesSlotOrder(t *testing.T) {
	origLCD := lcdBase
	t.Cleanup(func() { lcdBase = origLCD })

	const dealID = 999

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/polystorechain/polystorechain/v1/deals/999" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"deal": {
				"providers": ["providerA", "providerB", "providerC", "providerD"],
				"mode2_slots": [
					{"slot": 2, "provider": "providerC", "status": 1},
					{"slot": 0, "provider": "providerA", "status": "SLOT_STATUS_ACTIVE"},
					{"slot": 3, "provider": "providerD", "status": 2, "pending_provider": "providerZ"},
					{"slot": 1, "provider": "providerB", "status": "SLOT_STATUS_ACTIVE"}
				]
			}
		}`))
	}))
	t.Cleanup(srv.Close)
	lcdBase = srv.URL
	dealMode2SlotsCache.Delete(uint64(dealID))

	slots, err := resolveDealMode2Slots(context.Background(), dealID)
	if err != nil {
		t.Fatalf("resolveDealMode2Slots returned error: %v", err)
	}
	if len(slots) != 4 {
		t.Fatalf("expected 4 slots, got %d", len(slots))
	}
	if slots[0].Provider != "providerA" {
		t.Fatalf("slots[0].Provider expected providerA, got %q", slots[0].Provider)
	}
	if slots[1].Provider != "providerB" {
		t.Fatalf("slots[1].Provider expected providerB, got %q", slots[1].Provider)
	}
	if slots[2].Provider != "providerC" {
		t.Fatalf("slots[2].Provider expected providerC, got %q", slots[2].Provider)
	}
	if slots[3].Provider != "providerD" {
		t.Fatalf("slots[3].Provider expected providerD, got %q", slots[3].Provider)
	}
	if slots[3].Status != 2 || slots[3].PendingProvider != "providerZ" {
		t.Fatalf("slots[3] expected status=2 pending=providerZ, got status=%d pending=%q", slots[3].Status, slots[3].PendingProvider)
	}
}

func TestResolveProviderHTTPBaseURL_ProviderOverrideBypassesLCD(t *testing.T) {
	origLCD := lcdBase
	origOverrides := os.Getenv("POLYSTORE_PROVIDER_HTTP_BASE_OVERRIDES")
	origCache := providerBaseCache
	t.Cleanup(func() {
		lcdBase = origLCD
		if origOverrides == "" {
			_ = os.Unsetenv("POLYSTORE_PROVIDER_HTTP_BASE_OVERRIDES")
		} else {
			_ = os.Setenv("POLYSTORE_PROVIDER_HTTP_BASE_OVERRIDES", origOverrides)
		}
		providerBaseCache = origCache
	})

	providerBaseCache = sync.Map{}
	lcdRequests := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		lcdRequests++
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	lcdBase = srv.URL

	_ = os.Setenv("POLYSTORE_PROVIDER_HTTP_BASE_OVERRIDES", "nil1providerx=http://127.0.0.1:8091")
	base, err := resolveProviderHTTPBaseURL(context.Background(), "nil1providerx")
	if err != nil {
		t.Fatalf("resolveProviderHTTPBaseURL returned error: %v", err)
	}
	if base != "http://127.0.0.1:8091" {
		t.Fatalf("expected override base url, got %q", base)
	}
	if lcdRequests != 0 {
		t.Fatalf("expected override to bypass LCD lookup, got %d requests", lcdRequests)
	}
}

func TestResolveProviderHTTPBaseURL_HostOverrideFromEndpoint(t *testing.T) {
	origLCD := lcdBase
	origOverrides := os.Getenv("POLYSTORE_PROVIDER_HTTP_BASE_OVERRIDES")
	origCache := providerBaseCache
	t.Cleanup(func() {
		lcdBase = origLCD
		if origOverrides == "" {
			_ = os.Unsetenv("POLYSTORE_PROVIDER_HTTP_BASE_OVERRIDES")
		} else {
			_ = os.Setenv("POLYSTORE_PROVIDER_HTTP_BASE_OVERRIDES", origOverrides)
		}
		providerBaseCache = origCache
	})

	providerBaseCache = sync.Map{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/polystorechain/polystorechain/v1/providers/nil1providerz" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"provider": {
				"endpoints": ["/dns4/sp2.polynomialstore.com/tcp/443/https"]
			}
		}`))
	}))
	t.Cleanup(srv.Close)
	lcdBase = srv.URL

	_ = os.Setenv("POLYSTORE_PROVIDER_HTTP_BASE_OVERRIDES", "sp2.polynomialstore.com=http://127.0.0.1:8092")
	base, err := resolveProviderHTTPBaseURL(context.Background(), "nil1providerz")
	if err != nil {
		t.Fatalf("resolveProviderHTTPBaseURL returned error: %v", err)
	}
	if base != "http://127.0.0.1:8092" {
		t.Fatalf("expected host override base url, got %q", base)
	}
}

func TestResolveProviderForRetrievalPlan_Mode2UsesPendingProvider(t *testing.T) {
	origLCD := lcdBase
	t.Cleanup(func() { lcdBase = origLCD })
	t.Setenv("POLYSTORE_PROVIDER_ADDRESS", "nil1localprovider")

	const dealID uint64 = 55
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/polystorechain/polystorechain/v1/deals/55" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"deal": {
				"providers": ["providerA"],
				"mode2_slots": [
					{"slot": 0, "provider": "providerA", "status": "SLOT_STATUS_REPAIRING", "pending_provider": "providerPending"}
				]
			}
		}`))
	}))
	t.Cleanup(srv.Close)
	lcdBase = srv.URL
	dealMode2SlotsCache.Delete(dealID)
	dealProviderCache.Delete(dealID)

	res, err := resolveProviderForRetrievalPlan(context.Background(), dealID, stripeParams{mode: 2}, 0)
	if err != nil {
		t.Fatalf("resolveProviderForRetrievalPlan returned error: %v", err)
	}
	if res.Provider != "providerPending" {
		t.Fatalf("expected pending provider, got %q", res.Provider)
	}
	if res.UsedLocalFallback {
		t.Fatalf("expected metadata mode2 slot selection, got local fallback")
	}
	if res.Source != "mode2_slot_pending_provider" {
		t.Fatalf("unexpected source: %q", res.Source)
	}
	if res.Mode2Slot != 0 || res.SlotStatus != 2 {
		t.Fatalf("unexpected mode2 context: slot=%d status=%d", res.Mode2Slot, res.SlotStatus)
	}
	if res.ActiveProvider != "providerA" || res.PendingProvider != "providerPending" {
		t.Fatalf("unexpected repair context: active=%q pending=%q", res.ActiveProvider, res.PendingProvider)
	}
}

func TestResolveProviderForRetrievalPlan_FallsBackToLocalWhenMetadataUnavailable(t *testing.T) {
	origLCD := lcdBase
	t.Cleanup(func() { lcdBase = origLCD })
	t.Setenv("POLYSTORE_ALLOW_PLAN_PROVIDER_FALLBACK", "1")
	t.Setenv("POLYSTORE_PROVIDER_ADDRESS", "nil1localfallback")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	lcdBase = srv.URL

	res, err := resolveProviderForRetrievalPlan(context.Background(), 9999, stripeParams{mode: 1}, 0)
	if err != nil {
		t.Fatalf("resolveProviderForRetrievalPlan returned error: %v", err)
	}
	if res.Provider != "nil1localfallback" {
		t.Fatalf("expected local fallback provider, got %q", res.Provider)
	}
	if !res.UsedLocalFallback {
		t.Fatalf("expected local fallback to be marked")
	}
	if res.Source != "local_cached_provider_fallback" {
		t.Fatalf("unexpected source: %q", res.Source)
	}
}

func TestResolveProviderForRetrievalPlan_FailsWithoutFallbackWhenMetadataUnavailable(t *testing.T) {
	origLCD := lcdBase
	t.Cleanup(func() { lcdBase = origLCD })
	t.Setenv("POLYSTORE_PROVIDER_ADDRESS", "nil1localfallback")
	t.Setenv("POLYSTORE_ALLOW_PLAN_PROVIDER_FALLBACK", "")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	lcdBase = srv.URL

	_, err := resolveProviderForRetrievalPlan(context.Background(), 8888, stripeParams{mode: 1}, 0)
	if err == nil {
		t.Fatalf("expected metadata lookup failure")
	}
	if !errors.Is(err, ErrProviderResolutionMetadataUnavailable) {
		t.Fatalf("expected ErrProviderResolutionMetadataUnavailable, got: %v", err)
	}
}

func TestResolveProviderForRetrievalPlan_Mode2SlotOutOfRange(t *testing.T) {
	origLCD := lcdBase
	t.Cleanup(func() { lcdBase = origLCD })

	const dealID uint64 = 56
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/polystorechain/polystorechain/v1/deals/56" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"deal": {
				"providers": ["providerA"],
				"mode2_slots": [
					{"slot": 0, "provider": "providerA", "status": "SLOT_STATUS_ACTIVE"}
				]
			}
		}`))
	}))
	t.Cleanup(srv.Close)
	lcdBase = srv.URL
	dealMode2SlotsCache.Delete(dealID)

	_, err := resolveProviderForRetrievalPlan(context.Background(), dealID, stripeParams{mode: 2}, 1)
	if err == nil {
		t.Fatalf("expected slot out-of-range error")
	}
	if !errors.Is(err, ErrProviderResolutionSlotOutOfRange) {
		t.Fatalf("expected ErrProviderResolutionSlotOutOfRange, got: %v", err)
	}
}

func TestResolveProviderForRetrievalPlan_Mode2MetadataInvalidEmptyProvider(t *testing.T) {
	origLCD := lcdBase
	t.Cleanup(func() { lcdBase = origLCD })

	const dealID uint64 = 57
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/polystorechain/polystorechain/v1/deals/57" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"deal": {
				"providers": ["providerA"],
				"mode2_slots": [
					{"slot": 0, "provider": "", "status": "SLOT_STATUS_ACTIVE"}
				]
			}
		}`))
	}))
	t.Cleanup(srv.Close)
	lcdBase = srv.URL
	dealMode2SlotsCache.Delete(dealID)

	_, err := resolveProviderForRetrievalPlan(context.Background(), dealID, stripeParams{mode: 2}, 0)
	if err == nil {
		t.Fatalf("expected metadata invalid error")
	}
	if !errors.Is(err, ErrProviderResolutionMetadataInvalid) {
		t.Fatalf("expected ErrProviderResolutionMetadataInvalid, got: %v", err)
	}
}

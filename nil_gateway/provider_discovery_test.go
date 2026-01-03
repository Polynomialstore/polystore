package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFetchDealProvidersFromLCD_Mode2SlotsPrefersActive(t *testing.T) {
	origLCD := lcdBase
	t.Cleanup(func() { lcdBase = origLCD })

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/nilchain/nilchain/v1/deals/123" {
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

	want := []string{"providerB", "providerC", "providerA", "providerD"}
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
		if r.URL.Path != "/nilchain/nilchain/v1/deals/7" {
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


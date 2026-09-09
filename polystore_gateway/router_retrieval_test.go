package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/gogoproto/jsonpb"
	"github.com/gorilla/mux"
	"polystorechain/x/polystorechain/types"
)

func TestGatewayMduFrozenPayeeRouting(t *testing.T) {
	for _, mode := range []struct {
		name    string
		handler http.HandlerFunc
	}{{"ordinary", GatewayMdu}, {"router", RouterGatewayMdu}} {
		t.Run(mode.name, func(t *testing.T) {
			response := testFrozenSession(t)
			original := response
			root := "0x" + hex.EncodeToString(response.Session.ManifestRoot)
			id := "0x" + hex.EncodeToString(response.Session.SessionId)
			payee := response.Session.AuthorizedProofProvider
			currentProvider := response.Session.Provider
			providerHits, wrongHits, currentDealReads := 0, 0, 0
			upstreamStatus := http.StatusOK
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				providerHits++
				if r.URL.Path != "/sp/retrieval/mdu/"+root+"/2" || r.Header.Get("X-PolyStore-Session-Id") != id || r.URL.Query().Get("owner") != original.Session.Owner {
					t.Error("frozen request identity changed")
				}
				if r.URL.Query().Has("deputy") || r.URL.Query().Has("provider") {
					t.Error("untrusted routing hints forwarded")
				}
				w.Header().Set("Content-Type", "multipart/form-data; boundary=frozen; version=2")
				w.WriteHeader(upstreamStatus)
				_, _ = w.Write([]byte("frozen response bytes"))
			}))
			defer upstream.Close()
			wrong := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { wrongHits++; w.WriteHeader(200) }))
			defer wrong.Close()
			lcd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case strings.Contains(r.URL.Path, "retrieval-sessions/"):
					w.Header().Set(committedHeightHeader, "12")
					_ = (&jsonpb.Marshaler{OrigName: true}).Marshal(w, &response)
				case strings.Contains(r.URL.Path, "/providers/"):
					provider := strings.TrimPrefix(r.URL.Path, "/polystorechain/polystorechain/v1/providers/")
					if provider != payee {
						t.Errorf("resolved mutable or hinted payee %s", provider)
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"provider": map[string]any{"endpoints": []string{mustHTTPMultiaddr(t, upstream.URL)}}})
				case strings.Contains(r.URL.Path, "/deals/"):
					currentDealReads++
					// A new generation and assignment exist, but cannot revoke this session.
					_ = json.NewEncoder(w).Encode(map[string]any{"deal": map[string]any{"manifest_root": bytes.Repeat([]byte{9}, 32), "providers": []string{currentProvider}}})
				default:
					http.NotFound(w, r)
				}
			}))
			defer lcd.Close()
			oldLCD := lcdBase
			lcdBase = lcd.URL
			defer func() { lcdBase = oldLCD }()
			providerBaseCache = sync.Map{}
			dealProvidersCache = sync.Map{}
			dealProviderCache = sync.Map{}
			providerBaseCache.Store(currentProvider, &providerBaseCacheEntry{baseURL: wrong.URL, expires: time.Now().Add(time.Hour)})
			dealProvidersCache.Store(response.Session.DealId, &dealProvidersCacheEntry{providers: []string{currentProvider}, expires: time.Now().Add(time.Hour)})
			// A gateway can have no provider key; this path only relays canonical authority.
			t.Setenv("POLYSTORE_PROVIDER_ADDRESS", "not-a-provider-key")
			invoke := func(mutator func(*http.Request)) *httptest.ResponseRecorder {
				req := httptest.NewRequest("GET", fmt.Sprintf("/gateway/mdu/%s/2?deal_id=%d&owner=%s&provider=%s&deputy=1", root, original.Session.DealId, original.Session.Owner, currentProvider), nil)
				req = mux.SetURLVars(req, map[string]string{"cid": root, "index": "2"})
				req.Header.Set("X-PolyStore-Session-Id", id)
				req.Header.Set("Accept", "multipart/form-data; version=2")
				if mutator != nil {
					mutator(req)
				}
				w := httptest.NewRecorder()
				mode.handler(w, req)
				return w
			}
			if got := invoke(nil); got.Code != 200 || got.Body.String() != "frozen response bytes" {
				t.Fatalf("frozen routing failed: %d %s", got.Code, got.Body.String())
			}
			for _, status := range []int{http.StatusNotFound, http.StatusForbidden, http.StatusInternalServerError} {
				upstreamStatus = status
				got := invoke(nil)
				if got.Code == 200 || (status == http.StatusNotFound && got.Code != http.StatusNotFound) {
					t.Fatal("failed authorized provider fell back")
				}
			}
			hits := providerHits
			for _, mutate := range []func(*http.Request){
				func(r *http.Request) {
					q := r.URL.Query()
					q.Set("owner", currentProvider)
					r.URL.RawQuery = q.Encode()
				},
				func(r *http.Request) { r.Header.Set("X-PolyStore-Blob-Count", "1") },
				func(r *http.Request) { r.Header.Set("Accept", "application/octet-stream") },
				func(r *http.Request) { r.Header.Add("X-PolyStore-Session-Id", id) },
			} {
				if got := invoke(mutate); got.Code < 400 {
					t.Fatal("mismatched request accepted")
				}
			}
			response.Session.AuthorizedProofProvider = currentProvider // Public context still binds original payee.
			if got := invoke(nil); got.Code < 400 {
				t.Fatal("changed payee accepted")
			}
			response = original
			response.ChallengeSeed = nil
			if got := invoke(nil); got.Code < 400 {
				t.Fatal("missing seed accepted")
			}
			if providerHits != hits || wrongHits != 0 || currentDealReads != 0 {
				t.Fatalf("authority bypass: payee=%d/%d wrong=%d mutable=%d", providerHits, hits, wrongHits, currentDealReads)
			}
		})
	}
}

func TestGatewayContinuationUsesFrozenPayeeWithoutPrivilegedAuth(t *testing.T) {
	response := testFrozenSession(t)
	response.Session.Status = types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_USER_CONFIRMED
	id := "0x" + hex.EncodeToString(response.Session.SessionId)
	body := fmt.Sprintf(`{"session_id":%q}`, id)
	providerHits := 0
	redirectURL := ""
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		providerHits++
		if r.URL.Path != "/sp/retrieval/session-proof/continue" || r.Header.Get(gatewayAuthHeader) != "" {
			t.Errorf("unexpected continuation forwarding: path=%s auth=%q", r.URL.Path, r.Header.Get(gatewayAuthHeader))
		}
		got, _ := io.ReadAll(r.Body)
		if string(got) != body {
			t.Errorf("continuation identity changed: %s", got)
		}
		if redirectURL != "" {
			http.Redirect(w, r, redirectURL, http.StatusFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"reconciled","session_id":"` + id + `","proof_count":1,"tx_hash":"","cleanup_status":"complete"}`))
	}))
	defer provider.Close()
	lcd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "retrieval-sessions/"):
			w.Header().Set(committedHeightHeader, "12")
			_ = (&jsonpb.Marshaler{OrigName: true}).Marshal(w, &response)
		case strings.Contains(r.URL.Path, "/providers/"):
			if got := strings.TrimPrefix(r.URL.Path, "/polystorechain/polystorechain/v1/providers/"); got != response.Session.AuthorizedProofProvider {
				t.Errorf("resolved caller or mutable provider %q", got)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"provider": map[string]any{"endpoints": []string{mustHTTPMultiaddr(t, provider.URL)}}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer lcd.Close()
	oldLCD := lcdBase
	lcdBase = lcd.URL
	defer func() { lcdBase = oldLCD }()
	providerBaseCache = sync.Map{}

	invoke := func(requestBody string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/gateway/retrieval/session-proof/continue", strings.NewReader(requestBody))
		recorder := httptest.NewRecorder()
		RouterGatewayContinueRetrievalSessionProof(recorder, request)
		return recorder
	}
	if got := invoke(body); got.Code != http.StatusOK || !strings.Contains(got.Body.String(), `"status":"reconciled"`) {
		t.Fatalf("continuation relay failed: %d %s", got.Code, got.Body.String())
	}
	for _, invalid := range []string{
		fmt.Sprintf(`{"session_id":%q,"provider":%q}`, id, response.Session.Provider),
		fmt.Sprintf(`{"session_ids":[%q]}`, id),
	} {
		if got := invoke(invalid); got.Code != http.StatusBadRequest {
			t.Fatalf("accepted caller routing authority: %d %s", got.Code, got.Body.String())
		}
	}
	response.Session.Status = types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_OPEN
	if got := invoke(body); got.Code != http.StatusConflict {
		t.Fatalf("relayed before owner ACK: %d %s", got.Code, got.Body.String())
	}
	response.Session.Status = types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_USER_CONFIRMED
	redirectHits := 0
	redirectTarget := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { redirectHits++ }))
	defer redirectTarget.Close()
	redirectURL = redirectTarget.URL
	if got := invoke(body); got.Code != http.StatusFound {
		t.Fatalf("unexpected redirect outcome: %d %s", got.Code, got.Body.String())
	}
	if redirectHits != 0 {
		t.Fatalf("followed provider continuation redirect: %d", redirectHits)
	}
	if providerHits != 2 {
		t.Fatalf("unexpected provider continuations: %d", providerHits)
	}
}

func TestGatewayMduPinnedMetadataRouting(t *testing.T) {
	for _, mode := range []struct {
		name    string
		handler http.HandlerFunc
	}{{"ordinary", GatewayMdu}, {"router", RouterGatewayMdu}} {
		t.Run(mode.name, func(t *testing.T) {
			owner := sdk.AccAddress(bytes.Repeat([]byte{4}, 20)).String()
			root := mustTestManifestRoot(t, "historical metadata routing")
			providers := make([]string, 5)
			for i := range providers {
				providers[i] = sdk.AccAddress(bytes.Repeat([]byte{byte(20 + i)}, 20)).String()
			}
			attempts := 0
			echo := "9"
			requestedHeight := ""
			allUnavailable := false
			missingStatus := http.StatusInternalServerError
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				attempts++
				if r.URL.Path != "/sp/retrieval/mdu/"+root.Canonical+"/0" || r.URL.Query().Get("committed_height") != "9" {
					t.Errorf("unpinned metadata request: %s", r.URL)
				}
				if allUnavailable || attempts%2 == 1 {
					w.WriteHeader(missingStatus)
					return
				}
				w.Header().Set(committedHeightHeader, "9")
				_, _ = w.Write([]byte("historical metadata"))
			}))
			defer upstream.Close()
			lcd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case strings.Contains(r.URL.Path, "/deals/"):
					requestedHeight = r.Header.Get(committedHeightHeader)
					w.Header().Set(committedHeightHeader, echo)
					d := types.Deal{Id: 7, Owner: owner, ManifestRoot: root.Bytes[:], TotalMdus: 3, WitnessMdus: 1}
					for i, p := range providers {
						d.Mode2Slots = append(d.Mode2Slots, &types.DealSlot{Slot: uint32(i), Provider: p, Status: types.SlotStatus_SLOT_STATUS_ACTIVE})
					}
					_ = (&jsonpb.Marshaler{OrigName: true}).Marshal(w, &types.QueryGetDealResponse{Deal: &d})
				case strings.Contains(r.URL.Path, "/providers/"):
					_ = json.NewEncoder(w).Encode(map[string]any{"provider": map[string]any{"endpoints": []string{mustHTTPMultiaddr(t, upstream.URL)}}})
				default:
					http.NotFound(w, r)
				}
			}))
			defer lcd.Close()
			oldLCD := lcdBase
			lcdBase = lcd.URL
			defer func() { lcdBase = oldLCD }()
			providerBaseCache = sync.Map{}
			dealProvidersCache = sync.Map{}
			dealProvidersCache.Store(uint64(7), &dealProvidersCacheEntry{providers: []string{"wrong-current-generation"}, expires: time.Now().Add(time.Hour)})
			invoke := func(index int, height string) *httptest.ResponseRecorder {
				target := fmt.Sprintf("/gateway/mdu/%s/%d?deal_id=7&owner=%s", root.Canonical, index, owner)
				if height != "" {
					target += "&committed_height=" + height
				}
				req := mux.SetURLVars(httptest.NewRequest("GET", target, nil), map[string]string{"cid": root.Canonical, "index": strconv.Itoa(index)})
				w := httptest.NewRecorder()
				mode.handler(w, req)
				return w
			}
			for _, status := range []int{http.StatusInternalServerError, http.StatusNotFound} {
				missingStatus = status
				for _, height := range []string{"9", ""} {
					attempts = 0
					got := invoke(0, height)
					if got.Code != 200 || got.Body.String() != "historical metadata" || got.Header().Get(committedHeightHeader) != "9" || requestedHeight != height || attempts != 2 {
						t.Fatalf("metadata pin lost: code=%d body=%s query=%s attempts=%d", got.Code, got.Body.String(), requestedHeight, attempts)
					}
				}
			}

			attempts = 0
			if got := invoke(2, "9"); got.Code != 400 || attempts != 0 {
				t.Fatal("unfunded user MDU was proxied")
			}
			echo = "10"
			if got := invoke(0, "9"); got.Code != 502 || attempts != 0 {
				t.Fatal("LCD ignored pinned height")
			}
			echo = "9"
			allUnavailable = true
			if got := invoke(0, "9"); got.Code != 502 || attempts != 4 {
				t.Fatalf("metadata retry bound: %d attempts=%d", got.Code, attempts)
			}
		})
	}
}

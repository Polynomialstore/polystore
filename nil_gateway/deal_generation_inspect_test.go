package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/gorilla/mux"
)

func TestListDealGenerationDetails_SortsAndClassifies(t *testing.T) {
	useTempUploadDir(t)
	dealID := uint64(410)

	activeRoot := mustTestManifestRoot(t, "inspect-active")
	writeTestDealGeneration(t, dealID, activeRoot, 2, false)
	if err := writeActiveDealGeneration(dealID, activeRoot); err != nil {
		t.Fatalf("write active generation: %v", err)
	}

	recentRoot := mustTestManifestRoot(t, "inspect-provisional-recent")
	recentDir := writeTestDealGeneration(t, dealID, recentRoot, 2, false)
	recentMeta, err := readSlabMetadataFile(recentDir)
	if err != nil {
		t.Fatalf("read recent metadata: %v", err)
	}
	recentMeta.GenerationState = slabGenerationStateProvisional
	recentMeta.PreviousManifestRoot = activeRoot.Canonical
	recentMeta.CreatedAt = time.Now().Add(-1 * time.Hour).UTC().Format(time.RFC3339Nano)
	if err := writeSlabMetadataFile(recentDir, recentMeta); err != nil {
		t.Fatalf("rewrite recent metadata: %v", err)
	}

	expiredRoot := mustTestManifestRoot(t, "inspect-provisional-expired")
	expiredDir := writeTestDealGeneration(t, dealID, expiredRoot, 2, false)
	expiredMeta, err := readSlabMetadataFile(expiredDir)
	if err != nil {
		t.Fatalf("read expired metadata: %v", err)
	}
	expiredMeta.GenerationState = slabGenerationStateProvisional
	expiredMeta.PreviousManifestRoot = activeRoot.Canonical
	expiredMeta.CreatedAt = time.Now().Add(-(configuredProvisionalGenerationRetentionTTL() + time.Hour)).UTC().Format(time.RFC3339Nano)
	if err := writeSlabMetadataFile(expiredDir, expiredMeta); err != nil {
		t.Fatalf("rewrite expired metadata: %v", err)
	}

	invalidRoot := mustTestManifestRoot(t, "inspect-invalid")
	invalidDir := writeTestDealGeneration(t, dealID, invalidRoot, 2, false)
	invalidMeta, err := readSlabMetadataFile(invalidDir)
	if err != nil {
		t.Fatalf("read invalid metadata: %v", err)
	}
	invalidMeta.GenerationState = slabGenerationStateProvisional
	invalidMeta.CreatedAt = "not-a-time"
	if err := writeSlabMetadataFile(invalidDir, invalidMeta); err != nil {
		t.Fatalf("rewrite invalid metadata: %v", err)
	}

	incompleteRoot := mustTestManifestRoot(t, "inspect-incomplete")
	incompleteDir := writeTestDealGeneration(t, dealID, incompleteRoot, 2, false)
	if err := os.Remove(filepath.Join(incompleteDir, mode2SlabCompleteMarker)); err != nil {
		t.Fatalf("remove complete marker: %v", err)
	}
	if err := os.Remove(filepath.Join(incompleteDir, "manifest.bin")); err != nil {
		t.Fatalf("remove manifest.bin: %v", err)
	}

	details, activePointer, err := listDealGenerationDetails(dealID, time.Now().UTC())
	if err != nil {
		t.Fatalf("listDealGenerationDetails failed: %v", err)
	}
	if activePointer.Canonical != activeRoot.Canonical {
		t.Fatalf("unexpected active pointer: got=%s want=%s", activePointer.Canonical, activeRoot.Canonical)
	}
	if len(details) != 5 {
		t.Fatalf("unexpected detail count: got=%d want=5", len(details))
	}
	if details[0].ManifestRoot != activeRoot.Canonical || !details[0].ActivePointer || details[0].Status != slabGenerationStateActive {
		t.Fatalf("expected active generation first, got %+v", details[0])
	}
	byRoot := make(map[string]dealGenerationDetail, len(details))
	for _, detail := range details {
		byRoot[detail.ManifestRoot] = detail
	}
	if got := byRoot[invalidRoot.Canonical].Status; got != "invalid" {
		t.Fatalf("expected invalid generation status, got=%q detail=%+v", got, byRoot[invalidRoot.Canonical])
	}
	if got := byRoot[incompleteRoot.Canonical].Status; got != "incomplete" {
		t.Fatalf("expected incomplete generation status, got=%q detail=%+v", got, byRoot[incompleteRoot.Canonical])
	}
	if got := byRoot[expiredRoot.Canonical]; got.Status != "provisional_expired" || !got.Expired {
		t.Fatalf("expected expired provisional generation, got=%+v", got)
	}
	if got := byRoot[recentRoot.Canonical]; got.Status != "provisional_recent" {
		t.Fatalf("expected recent provisional generation, got=%+v", got)
	}
	if byRoot[recentRoot.Canonical].PreviousManifestRoot != activeRoot.Canonical {
		t.Fatalf("expected recent provisional previous root=%s got=%s", activeRoot.Canonical, byRoot[recentRoot.Canonical].PreviousManifestRoot)
	}
	if details[0].BytesTotal == 0 || byRoot[recentRoot.Canonical].BytesTotal == 0 || details[0].FileCount != 1 {
		t.Fatalf("expected populated deal-generation detail sizes, got active=%+v recent=%+v", details[0], byRoot[recentRoot.Canonical])
	}
}

func TestGatewayDealGenerations_ReturnsPerDealDetails(t *testing.T) {
	useTempUploadDir(t)
	dealID := uint64(411)
	activeRoot := mustTestManifestRoot(t, "inspect-endpoint-active")
	writeTestDealGeneration(t, dealID, activeRoot, 2, false)
	if err := writeActiveDealGeneration(dealID, activeRoot); err != nil {
		t.Fatalf("write active generation: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/gateway/deal-generations/411", nil)
	req = mux.SetURLVars(req, map[string]string{"deal_id": "411"})
	w := httptest.NewRecorder()

	GatewayDealGenerations(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("unexpected status code: got=%d body=%s", w.Code, w.Body.String())
	}
	var resp dealGenerationListResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.DealID != dealID {
		t.Fatalf("unexpected deal id: got=%d want=%d", resp.DealID, dealID)
	}
	if resp.ActiveGeneration != activeRoot.Canonical {
		t.Fatalf("unexpected active generation: got=%s want=%s", resp.ActiveGeneration, activeRoot.Canonical)
	}
	if len(resp.Generations) != 1 {
		t.Fatalf("unexpected generation count: got=%d want=1", len(resp.Generations))
	}
	if !resp.Generations[0].ActivePointer || resp.Generations[0].Status != slabGenerationStateActive {
		t.Fatalf("unexpected generation payload: %+v", resp.Generations[0])
	}
}

func TestGatewayDealGenerations_NotFoundWhenDealMissing(t *testing.T) {
	useTempUploadDir(t)

	req := httptest.NewRequest(http.MethodGet, "/gateway/deal-generations/99999", nil)
	req = mux.SetURLVars(req, map[string]string{"deal_id": "99999"})
	w := httptest.NewRecorder()

	GatewayDealGenerations(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got=%d body=%s", w.Code, w.Body.String())
	}
}

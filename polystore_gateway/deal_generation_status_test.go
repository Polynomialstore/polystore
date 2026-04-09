package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestDealGenerationStatusSnapshotAt(t *testing.T) {
	useTempUploadDir(t)

	activeRoot := mustTestManifestRoot(t, "status-active")
	activeDir := writeTestDealGeneration(t, 201, activeRoot, 2, false)
	activeBytes := dirSizeBytes(activeDir)

	recentRoot := mustTestManifestRoot(t, "status-provisional-recent")
	recentDir := writeTestDealGeneration(t, 202, recentRoot, 2, false)
	recentMeta, err := readSlabMetadataFile(recentDir)
	if err != nil {
		t.Fatalf("read recent metadata: %v", err)
	}
	recentMeta.GenerationState = slabGenerationStateProvisional
	recentMeta.CreatedAt = time.Now().Add(-1 * time.Hour).UTC().Format(time.RFC3339Nano)
	if err := writeSlabMetadataFile(recentDir, recentMeta); err != nil {
		t.Fatalf("rewrite recent metadata: %v", err)
	}
	recentBytes := dirSizeBytes(recentDir)

	expiredRoot := mustTestManifestRoot(t, "status-provisional-expired")
	expiredDir := writeTestDealGeneration(t, 203, expiredRoot, 2, false)
	expiredMeta, err := readSlabMetadataFile(expiredDir)
	if err != nil {
		t.Fatalf("read expired metadata: %v", err)
	}
	expiredMeta.GenerationState = slabGenerationStateProvisional
	expiredMeta.CreatedAt = time.Now().Add(-(provisionalGenerationRetentionTTL + 2*time.Hour)).UTC().Format(time.RFC3339Nano)
	if err := writeSlabMetadataFile(expiredDir, expiredMeta); err != nil {
		t.Fatalf("rewrite expired metadata: %v", err)
	}
	expiredBytes := dirSizeBytes(expiredDir)

	incompleteRoot := mustTestManifestRoot(t, "status-incomplete")
	incompleteDir := dealScopedDir(204, incompleteRoot)
	if err := os.MkdirAll(incompleteDir, 0o755); err != nil {
		t.Fatalf("mkdir incomplete dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(incompleteDir, "mdu_0.bin"), []byte("stub"), 0o644); err != nil {
		t.Fatalf("write incomplete mdu_0.bin: %v", err)
	}

	invalidRoot := mustTestManifestRoot(t, "status-invalid")
	invalidDir := writeTestDealGeneration(t, 205, invalidRoot, 2, false)
	invalidMeta, err := readSlabMetadataFile(invalidDir)
	if err != nil {
		t.Fatalf("read invalid metadata: %v", err)
	}
	invalidMeta.GenerationState = slabGenerationStateProvisional
	invalidMeta.CreatedAt = "not-a-timestamp"
	if err := writeSlabMetadataFile(invalidDir, invalidMeta); err != nil {
		t.Fatalf("rewrite invalid metadata: %v", err)
	}
	invalidBytes := dirSizeBytes(invalidDir)

	snapshot := dealGenerationStatusSnapshotAt(time.Now().UTC())
	if snapshot.RetentionTTL != provisionalGenerationRetentionTTL {
		t.Fatalf("unexpected retention TTL: got=%s want=%s", snapshot.RetentionTTL, provisionalGenerationRetentionTTL)
	}
	if snapshot.Deals != 5 {
		t.Fatalf("unexpected deals count: got=%d want=5", snapshot.Deals)
	}
	if snapshot.Active != 1 {
		t.Fatalf("unexpected active count: got=%d want=1", snapshot.Active)
	}
	if snapshot.Provisional != 3 {
		t.Fatalf("unexpected provisional count: got=%d want=3", snapshot.Provisional)
	}
	if snapshot.ProvisionalRecent != 1 {
		t.Fatalf("unexpected recent provisional count: got=%d want=1", snapshot.ProvisionalRecent)
	}
	if snapshot.ProvisionalExpired != 1 {
		t.Fatalf("unexpected expired provisional count: got=%d want=1", snapshot.ProvisionalExpired)
	}
	if snapshot.Incomplete != 1 {
		t.Fatalf("unexpected incomplete count: got=%d want=1", snapshot.Incomplete)
	}
	if snapshot.Invalid != 1 {
		t.Fatalf("unexpected invalid count: got=%d want=1", snapshot.Invalid)
	}
	if snapshot.BytesActive != activeBytes {
		t.Fatalf("unexpected active bytes: got=%d want=%d", snapshot.BytesActive, activeBytes)
	}
	wantProvisionalBytes := recentBytes + expiredBytes + invalidBytes
	if snapshot.BytesProvisional != wantProvisionalBytes {
		t.Fatalf("unexpected provisional bytes: got=%d want=%d", snapshot.BytesProvisional, wantProvisionalBytes)
	}
	if snapshot.BytesTotal != activeBytes+wantProvisionalBytes {
		t.Fatalf("unexpected total bytes: got=%d want=%d", snapshot.BytesTotal, activeBytes+wantProvisionalBytes)
	}
}

func TestDealGenerationStatusSnapshotAt_UsesConfiguredRetentionTTL(t *testing.T) {
	useTempUploadDir(t)
	t.Setenv("POLYSTORE_PROVISIONAL_GENERATION_RETENTION_TTL", "36h")

	snapshot := dealGenerationStatusSnapshotAt(time.Now().UTC())
	if snapshot.RetentionTTL != 36*time.Hour {
		t.Fatalf("unexpected configured retention TTL: got=%s want=%s", snapshot.RetentionTTL, 36*time.Hour)
	}
}

func TestGatewayStatusIncludesDealGenerationSnapshot(t *testing.T) {
	useTempUploadDir(t)

	root := mustTestManifestRoot(t, "status-endpoint")
	writeTestDealGeneration(t, 301, root, 2, false)

	oldLCDBase := lcdBase
	oldProviderBase := providerBase
	lcdBase = ""
	providerBase = ""
	t.Cleanup(func() {
		lcdBase = oldLCDBase
		providerBase = oldProviderBase
	})

	req := httptest.NewRequest(http.MethodGet, "/status", nil)
	w := httptest.NewRecorder()

	GatewayStatus(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("unexpected status code: got=%d want=%d", w.Code, http.StatusOK)
	}
	var status gatewayStatusResponse
	if err := json.NewDecoder(w.Body).Decode(&status); err != nil {
		t.Fatalf("decode status response: %v", err)
	}
	if status.Extra["polyfs_generation_active"] != "1" {
		t.Fatalf("expected polyfs_generation_active=1, got=%q", status.Extra["polyfs_generation_active"])
	}
	if status.Extra["polyfs_generation_deals"] != "1" {
		t.Fatalf("expected polyfs_generation_deals=1, got=%q", status.Extra["polyfs_generation_deals"])
	}
	if status.Extra["polyfs_generation_provisional_retention_ttl_seconds"] != strconv.FormatInt(int64(provisionalGenerationRetentionTTL/time.Second), 10) {
		t.Fatalf("unexpected retention TTL seconds: got=%q", status.Extra["polyfs_generation_provisional_retention_ttl_seconds"])
	}
	bytesTotal, err := strconv.ParseUint(status.Extra["polyfs_generation_bytes_total"], 10, 64)
	if err != nil {
		t.Fatalf("parse polyfs_generation_bytes_total: %v", err)
	}
	if bytesTotal == 0 {
		t.Fatal("expected polyfs_generation_bytes_total > 0")
	}
}

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"nilchain/x/crypto_ffi"
)

type mode2Fixture struct {
	Spec          string            `json:"spec"`
	K             uint64            `json:"k"`
	M             uint64            `json:"m"`
	LeafCount     uint64            `json:"leaf_count"`
	PayloadHex    string            `json:"payload_hex"`
	PayloadSha256 string            `json:"payload_sha256"`
	WitnessCount  uint64            `json:"witness_count"`
	Roots         map[string]string `json:"roots"`
	ArtifactSha   map[string]string `json:"artifact_sha256"`
	Extra         map[string]any    `json:"extra"`
}

func readMode2Fixture(t *testing.T) mode2Fixture {
	t.Helper()
	path := filepath.Join("..", "testdata", "mode2-artifacts-v1", "fixture_k8m4_single.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var fx mode2Fixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	return fx
}

func sha256Hex0x(b []byte) string {
	sum := sha256.Sum256(b)
	return "0x" + hex.EncodeToString(sum[:])
}

func decodeHex0x(t *testing.T, s string) []byte {
	t.Helper()
	trimmed := strings.TrimSpace(s)
	trimmed = strings.TrimPrefix(trimmed, "0x")
	out, err := hex.DecodeString(trimmed)
	if err != nil {
		t.Fatalf("hex decode failed: %v", err)
	}
	return out
}

func TestMode2ArtifactsV1_FixtureHashes(t *testing.T) {
	useTempUploadDir(t)
	if err := crypto_ffi.Init(trustedSetup); err != nil {
		t.Fatalf("crypto_ffi.Init failed: %v", err)
	}

	fx := readMode2Fixture(t)
	if fx.Spec != "mode2-artifacts-v1" {
		t.Fatalf("unexpected spec: %s", fx.Spec)
	}

	payload := decodeHex0x(t, fx.PayloadHex)
	if sha256Hex0x(payload) != fx.PayloadSha256 {
		t.Fatalf("payload sha mismatch: got %s want %s", sha256Hex0x(payload), fx.PayloadSha256)
	}

	tmp := filepath.Join(t.TempDir(), "fixture.bin")
	if err := os.WriteFile(tmp, payload, 0o644); err != nil {
		t.Fatalf("write temp payload: %v", err)
	}

	const dealID = uint64(7)
	serviceHint := "General:replicas=12:rs=8+4"

	res, finalDir, err := mode2BuildArtifacts(t.Context(), tmp, dealID, serviceHint, "fixture.bin")
	if err != nil {
		t.Fatalf("mode2BuildArtifacts failed: %v", err)
	}
	if got, want := res.manifestRoot.Canonical, fx.Roots["manifest_root"]; strings.ToLower(got) != strings.ToLower(want) {
		t.Fatalf("manifest_root mismatch: got %s want %s", got, want)
	}

	key := strings.TrimPrefix(strings.ToLower(res.manifestRoot.Canonical), "0x")
	expectedDir := filepath.Join(uploadDir, "deals", strconv.FormatUint(dealID, 10), key)
	if finalDir != expectedDir {
		t.Fatalf("unexpected finalDir: got %s want %s", finalDir, expectedDir)
	}

	for name, expectedHash := range fx.ArtifactSha {
		path := filepath.Join(finalDir, name)
		b, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read artifact %s: %v", name, err)
		}
		if got := sha256Hex0x(b); got != expectedHash {
			t.Fatalf("artifact hash mismatch for %s: got %s want %s", name, got, expectedHash)
		}
	}
}

func TestMode2BuildArtifacts_IdempotentWhenFinalDirExists(t *testing.T) {
	useTempUploadDir(t)
	if err := crypto_ffi.Init(trustedSetup); err != nil {
		t.Fatalf("crypto_ffi.Init failed: %v", err)
	}

	fx := readMode2Fixture(t)
	payload := decodeHex0x(t, fx.PayloadHex)
	tmp := filepath.Join(t.TempDir(), "fixture.bin")
	if err := os.WriteFile(tmp, payload, 0o644); err != nil {
		t.Fatalf("write temp payload: %v", err)
	}

	const dealID = uint64(7)
	serviceHint := "General:replicas=12:rs=8+4"

	first, finalDir1, err := mode2BuildArtifacts(t.Context(), tmp, dealID, serviceHint, "fixture.bin")
	if err != nil {
		t.Fatalf("mode2BuildArtifacts (first) failed: %v", err)
	}

	second, finalDir2, err := mode2BuildArtifacts(t.Context(), tmp, dealID, serviceHint, "fixture.bin")
	if err != nil {
		t.Fatalf("mode2BuildArtifacts (second) failed: %v", err)
	}

	if finalDir1 != finalDir2 {
		t.Fatalf("finalDir mismatch: first=%s second=%s", finalDir1, finalDir2)
	}
	if first.manifestRoot.Key != second.manifestRoot.Key {
		t.Fatalf("manifest_root mismatch: first=%s second=%s", first.manifestRoot.Canonical, second.manifestRoot.Canonical)
	}
}

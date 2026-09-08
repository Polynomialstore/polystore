package keeper_test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// Metadata describes this export, not authenticated v2 challenges or delivery.
// Keep the exporter shared with the existing benchmark's actual crypto fixture.
func writeBenchmarkFixtureMetadata(t *testing.T, dir string, env *benchRetrievalEnv, sessions, proofs int, payload []byte) {
	t.Helper()
	digest := func(data []byte) string {
		sum := sha256.Sum256(data)
		return hex.EncodeToString(sum[:])
	}
	setup, err := os.ReadFile("../../../trusted_setup.txt")
	require.NoError(t, err)
	pattern := "zero-filled-v1"
	if os.Getenv("POLYSTORE_BENCH_FIXTURE_NONCONSTANT") == "1" {
		pattern = "be-fr-last-byte-cycle-1-through-251-v1"
	}
	metadata := map[string]any{
		"schema_version": 1, "challenge_kind": "legacy-fixed-z",
		"data_pattern": pattern, "data_sha256": digest(env.mduData),
		"data_bytes": len(env.mduData), "trusted_setup_sha256": digest(setup),
		"manifest_root":        "0x" + hex.EncodeToString(env.deal.ManifestRoot),
		"proof_payload_sha256": digest(payload), "sessions": sessions,
		"proofs_per_session": proofs, "total_proofs": sessions * proofs,
		"k": env.k, "m": env.m, "slot": 0, "rows_per_slot": env.rows,
		"mdu_index": benchTargetMduIndex, "metadata_mdus": 2, "user_mdus": 1,
		"encoded_blob_bytes": 131072, "raw_payload_capacity_bytes": 8126464,
	}
	encoded, err := json.MarshalIndent(metadata, "", "  ")
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(dir, "fixture.json"), encoded, 0o600))
}

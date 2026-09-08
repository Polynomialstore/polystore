package keeper_test

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/require"
	"polystorechain/x/polystorechain/types"
)

func TestNonconstantProofAdmissionFixture(t *testing.T) {
	t.Setenv("POLYSTORE_BENCH_FIXTURE_NONCONSTANT", "1")
	t.Setenv("POLYSTORE_BENCH_FIXTURE_SERVICE_HINT", "General:rs=8+4")
	env := setupBenchRetrievalEnv(t)
	v := struct {
		Root   []byte               `json:"root"`
		Proofs []types.ChainedProof `json:"proofs"`
	}{Root: env.deal.ManifestRoot}
	for i := 0; i < 3; i++ {
		v.Proofs = append(v.Proofs, env.benchBuildChainedProof(t, uint64(i), uint64(i)+100))
	}
	data, err := json.MarshalIndent(v, "", "  ")
	require.NoError(t, err)
	if os.Getenv("POLYSTORE_UPDATE_PROOF_ADMISSION_FIXTURE") == "1" {
		require.NoError(t, os.WriteFile("testdata/proof_admission_k8.json", append(data, '\n'), 0644))
	}
	expected, err := os.ReadFile("testdata/proof_admission_k8.json")
	require.NoError(t, err)
	require.JSONEq(t, string(expected), string(data))
}

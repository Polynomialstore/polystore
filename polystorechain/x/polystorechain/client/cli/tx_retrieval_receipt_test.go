package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"polystorechain/x/polystorechain/types"
)

func TestReadChainedProofJSON(t *testing.T) {
	proof := types.ChainedProof{MduIndex: 7, BlobIndex: 3, MduRootFr: []byte{1, 2, 3}}
	proofJSON, err := json.Marshal(proof)
	if err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		name string
		data []byte
	}{
		{name: "raw", data: proofJSON},
		{name: "gateway wrapper", data: mustMarshalJSON(t, struct {
			ProofDetails json.RawMessage `json:"proof_details"`
		}{ProofDetails: proofJSON})},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "proof.json")
			if err := os.WriteFile(path, tc.data, 0o600); err != nil {
				t.Fatal(err)
			}
			got, err := readChainedProofJSON(path, 7)
			if err != nil {
				t.Fatal(err)
			}
			if got.MduIndex != proof.MduIndex || got.BlobIndex != proof.BlobIndex {
				t.Fatalf("unexpected proof: %+v", got)
			}
			if _, err := readChainedProofJSON(path, 8); err == nil {
				t.Fatal("expected mismatched mdu_index to fail")
			}
		})
	}
}

func mustMarshalJSON(t *testing.T, value any) []byte {
	t.Helper()
	bz, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return bz
}

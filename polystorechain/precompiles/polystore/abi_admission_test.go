package polystore

import (
	"encoding/binary"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/stretchr/testify/require"
	"polystorechain/x/polystorechain/types"
)

func TestABIAdmissionRejectsAmplification(t *testing.T) {
	parsed, err := abi.JSON(strings.NewReader(`[{"type":"function","name":"test","inputs":[{"name":"values","type":"bytes[]"}]}]`))
	require.NoError(t, err)
	args := parsed.Methods["test"].Inputs
	data, err := args.Pack([][]byte{[]byte("one"), []byte("two")})
	require.NoError(t, err)
	require.NoError(t, validateABIAdmission(args, data))
	for _, tc := range []struct {
		name   string
		mutate func([]byte) []byte
	}{
		{"aliased tail", func(b []byte) []byte { copy(b[96:128], b[64:96]); return b }},
		{"count overflow", func(b []byte) []byte { b[32] = 1; return b }},
		{"array cap", func(b []byte) []byte { binary.BigEndian.PutUint64(b[56:64], 65); return b }},
		{"bytes overflow", func(b []byte) []byte { b[128] = 1; return b }},
		{"head alias", func(b []byte) []byte { clear(b[64:96]); return b }},
		{"truncated", func(b []byte) []byte { return b[:len(b)-1] }},
		{"trailing", func(b []byte) []byte { return append(b, make([]byte, 32)...) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			bad := tc.mutate(append([]byte{}, data...))
			require.Error(t, validateABIAdmission(args, bad))
		})
	}
	repeated := make([][]byte, 64)
	for i := range repeated {
		repeated[i] = make([]byte, 4096)
	}
	tooLarge, err := args.Pack(repeated)
	require.NoError(t, err)
	require.Error(t, validateABIAdmission(args, tooLarge))
	// No decoded allocations even for a rejected aliased array.
	bad := append([]byte{}, data...)
	copy(bad[96:128], bad[64:96])
	require.LessOrEqual(t, testing.AllocsPerRun(100, func() { _ = validateABIAdmission(args, bad) }), float64(3))
}

func TestABIAdmissionBoundsNestedProofTails(t *testing.T) {
	f := initFixture(t)
	p, err := New(&f.keeper)
	require.NoError(t, err)
	data, err := os.ReadFile("../../x/polystorechain/keeper/testdata/proof_admission_k8.json")
	require.NoError(t, err)
	var fixture struct {
		Proofs []types.ChainedProof `json:"proofs"`
	}
	require.NoError(t, json.Unmarshal(data, &fixture))
	method := p.abi.Methods["proveRetrievalBatch"]
	chunks := []decodedChunk{{RangeLen: 1, Proof: fixture.Proofs[0]}, {RangeLen: 1, Proof: fixture.Proofs[1]}}
	packed, err := method.Inputs.Pack(uint64(1), "provider", "file", uint64(1), chunks)
	require.NoError(t, err)
	require.NoError(t, validateABIAdmission(method.Inputs, packed))
	// The fifth argument points to the array. Aliasing tuple tails is accepted
	// by geth, but would permit repeated nested allocations from one tail.
	offset := int(binary.BigEndian.Uint64(packed[152:160]))
	first := offset + 32
	copy(packed[first+32:first+64], packed[first:first+32])
	_, err = method.Inputs.Unpack(packed)
	require.NoError(t, err)
	require.ErrorContains(t, validateABIAdmission(method.Inputs, packed), "unaliased")
}

package polystore

import (
	"encoding/binary"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/stretchr/testify/require"
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

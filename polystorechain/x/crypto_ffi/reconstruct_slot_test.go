package crypto_ffi

import (
	"bytes"
	"testing"

	"polystorechain/x/polystorechain/types"
)

func TestReconstructSlotRsMaximumParity(t *testing.T) {
	// K=1 parity equals the sole data shard; no 255 absent 8MiB buffers.
	data := make([]byte, types.MDU_SIZE)
	for i := range data {
		data[i] = byte(i*37 + i/97)
	}
	shards := make([][]byte, 256)
	shards[0] = data
	result, err := ReconstructSlotRs(shards, 1, 255, 255)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(result, data) {
		t.Fatal("incorrect maximum parity reconstruction")
	}
}

func TestReconstructSlotRsRejectsInvalidInputs(t *testing.T) {
	for _, tc := range []struct{ k, m, target uint64 }{{0, 4, 0}, {3, 4, 0}, {64, 193, 0}, {8, 4, 12}, {8, ^uint64(0), 1}} {
		if _, err := ReconstructSlotRs(nil, tc.k, tc.m, tc.target); err == nil {
			t.Fatal("accepted invalid geometry")
		}
	}
	shards := make([][]byte, 12)
	if _, err := ReconstructSlotRs(shards, 8, 4, 1); err == nil {
		t.Fatal("accepted missing inputs")
	}
	shards[0] = []byte{1}
	if _, err := ReconstructSlotRs(shards, 8, 4, 1); err == nil {
		t.Fatal("accepted short shard")
	}
}

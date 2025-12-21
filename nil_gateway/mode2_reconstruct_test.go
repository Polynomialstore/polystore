package main

import (
	"bytes"
	"testing"

	"nilchain/x/crypto_ffi"
	"nilchain/x/nilchain/types"
)

func TestReconstructMduRs_MissingShards(t *testing.T) {
	const k = 8
	const m = 4
	rows := types.BLOBS_PER_MDU / k
	if rows == 0 || types.BLOBS_PER_MDU%k != 0 {
		t.Fatal("invalid stripe params")
	}

	mdu := make([]byte, types.MDU_SIZE)
	for blob := 0; blob < types.BLOBS_PER_MDU; blob++ {
		fill := byte(blob % 256)
		start := blob * types.BLOB_SIZE
		for i := 0; i < types.BLOB_SIZE; i++ {
			mdu[start+i] = fill
		}
	}

	_, shards, err := crypto_ffi.ExpandMduRs(mdu, k, m)
	if err != nil {
		t.Fatalf("expand failed: %v", err)
	}
	if len(shards) != k+m {
		t.Fatalf("expected %d shards, got %d", k+m, len(shards))
	}

	present := make([]bool, k+m)
	for i := range present {
		present[i] = true
	}

	// Drop up to M shards (including data slots) and ensure reconstruction still succeeds.
	shards[0] = nil
	present[0] = false
	shards[3] = nil
	present[3] = false
	shards[9] = nil
	present[9] = false

	reconstructed, err := crypto_ffi.ReconstructMduRs(shards, present, k, m)
	if err != nil {
		t.Fatalf("reconstruct failed: %v", err)
	}
	if !bytes.Equal(reconstructed, mdu) {
		t.Fatal("reconstructed MDU does not match original")
	}
}

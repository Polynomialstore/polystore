package main

import (
	"bytes"
	"testing"

	"nilchain/x/nilchain/types"
)

func TestReconstructMduFromDataShards(t *testing.T) {
	const dataShards = 8
	rows := types.BLOBS_PER_MDU / dataShards
	if rows == 0 {
		t.Fatal("invalid rows")
	}

	mdu := make([]byte, types.MDU_SIZE)
	for blob := 0; blob < types.BLOBS_PER_MDU; blob++ {
		fill := byte(blob % 256)
		start := blob * types.BLOB_SIZE
		for i := 0; i < types.BLOB_SIZE; i++ {
			mdu[start+i] = fill
		}
	}

	shardSize := rows * types.BLOB_SIZE
	shards := make([][]byte, dataShards)
	for slot := 0; slot < dataShards; slot++ {
		shards[slot] = make([]byte, shardSize)
	}

	for row := 0; row < rows; row++ {
		rowOffset := row * types.BLOB_SIZE
		for slot := 0; slot < dataShards; slot++ {
			blobIndex := row*dataShards + slot
			srcStart := blobIndex * types.BLOB_SIZE
			copy(shards[slot][rowOffset:rowOffset+types.BLOB_SIZE], mdu[srcStart:srcStart+types.BLOB_SIZE])
		}
	}

	reconstructed, err := reconstructMduFromDataShards(shards, uint64(dataShards), uint64(rows))
	if err != nil {
		t.Fatalf("reconstruct failed: %v", err)
	}
	if !bytes.Equal(reconstructed, mdu) {
		t.Fatal("reconstructed MDU does not match original")
	}
}

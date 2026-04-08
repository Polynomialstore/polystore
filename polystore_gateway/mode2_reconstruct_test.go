package main

import (
	"bytes"
	"reflect"
	"strconv"
	"sync/atomic"
	"testing"

	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/types"
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

func TestMode2FallbackProviders_OrderAndDedup(t *testing.T) {
	slots := []mode2SlotAssignment{
		{Provider: " p2 ", Status: 1},
		{Provider: "p2", PendingProvider: "p1", Status: 2},
		{Provider: "p3", PendingProvider: "p2", Status: 2},
		{Provider: "p3", PendingProvider: "  ", Status: 0},
	}

	got := mode2FallbackProviders(slots)
	want := []string{"p2", "p1", "p3"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected provider order: got=%v want=%v", got, want)
	}
}

func TestMode2ReconstructSnapshotForStatus(t *testing.T) {
	resetMode2ReconstructStatsForTest()

	atomic.AddUint64(&mode2ReconstructStats.localShardHits, 3)
	atomic.AddUint64(&mode2ReconstructStats.assignedProviderAttempts, 4)
	atomic.AddUint64(&mode2ReconstructStats.assignedProviderFailures, 1)
	atomic.AddUint64(&mode2ReconstructStats.fallbackProviderAttempts, 2)
	atomic.AddUint64(&mode2ReconstructStats.fallbackProviderSuccesses, 1)
	atomic.AddUint64(&mode2ReconstructStats.fallbackProviderFailures, 1)
	atomic.AddUint64(&mode2ReconstructStats.notEnoughShardsFailures, 5)

	snapshot := mode2ReconstructSnapshotForStatus()
	expect := map[string]uint64{
		"mode2_reconstruct_local_shard_hits":            3,
		"mode2_reconstruct_assigned_provider_attempts":  4,
		"mode2_reconstruct_assigned_provider_failures":  1,
		"mode2_reconstruct_fallback_provider_attempts":  2,
		"mode2_reconstruct_fallback_provider_successes": 1,
		"mode2_reconstruct_fallback_provider_failures":  1,
		"mode2_reconstruct_not_enough_shards_failures":  5,
	}

	for key, want := range expect {
		gotRaw, ok := snapshot[key]
		if !ok {
			t.Fatalf("missing snapshot key %q", key)
		}
		got, err := strconv.ParseUint(gotRaw, 10, 64)
		if err != nil {
			t.Fatalf("snapshot value %q is not uint: %v", key, err)
		}
		if got != want {
			t.Fatalf("snapshot mismatch for %q: got=%d want=%d", key, got, want)
		}
	}
}

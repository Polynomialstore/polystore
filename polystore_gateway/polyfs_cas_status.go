package main

import (
	"strconv"
	"sync/atomic"
)

var polyfsCASStatusCounters struct {
	preflightConflictsTotal  uint64
	preflightConflictsLegacy uint64
	preflightConflictsEvm    uint64
	preflightConflictsUpload uint64
}

type polyfsCASPreflightConflictKind string

const (
	polyfsCASPreflightConflictLegacy polyfsCASPreflightConflictKind = "legacy"
	polyfsCASPreflightConflictEvm    polyfsCASPreflightConflictKind = "evm"
	polyfsCASPreflightConflictUpload polyfsCASPreflightConflictKind = "upload"
)

func recordPolyfsCASPreflightConflict(kind polyfsCASPreflightConflictKind) {
	atomic.AddUint64(&polyfsCASStatusCounters.preflightConflictsTotal, 1)
	switch kind {
	case polyfsCASPreflightConflictEvm:
		atomic.AddUint64(&polyfsCASStatusCounters.preflightConflictsEvm, 1)
	case polyfsCASPreflightConflictUpload:
		atomic.AddUint64(&polyfsCASStatusCounters.preflightConflictsUpload, 1)
	default:
		atomic.AddUint64(&polyfsCASStatusCounters.preflightConflictsLegacy, 1)
	}
}

func polyfsCASStatusSnapshotForStatus() map[string]string {
	return map[string]string{
		"polyfs_cas_preflight_conflicts_total":  strconv.FormatUint(atomic.LoadUint64(&polyfsCASStatusCounters.preflightConflictsTotal), 10),
		"polyfs_cas_preflight_conflicts_legacy": strconv.FormatUint(atomic.LoadUint64(&polyfsCASStatusCounters.preflightConflictsLegacy), 10),
		"polyfs_cas_preflight_conflicts_evm":    strconv.FormatUint(atomic.LoadUint64(&polyfsCASStatusCounters.preflightConflictsEvm), 10),
		"polyfs_cas_preflight_conflicts_upload": strconv.FormatUint(atomic.LoadUint64(&polyfsCASStatusCounters.preflightConflictsUpload), 10),
	}
}

func resetPolyfsCASStatusCountersForTest() {
	atomic.StoreUint64(&polyfsCASStatusCounters.preflightConflictsTotal, 0)
	atomic.StoreUint64(&polyfsCASStatusCounters.preflightConflictsLegacy, 0)
	atomic.StoreUint64(&polyfsCASStatusCounters.preflightConflictsEvm, 0)
	atomic.StoreUint64(&polyfsCASStatusCounters.preflightConflictsUpload, 0)
}

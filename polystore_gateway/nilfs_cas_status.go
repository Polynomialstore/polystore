package main

import (
	"strconv"
	"sync/atomic"
)

var nilfsCASStatusCounters struct {
	preflightConflictsTotal  uint64
	preflightConflictsLegacy uint64
	preflightConflictsEvm    uint64
	preflightConflictsUpload uint64
}

type nilfsCASPreflightConflictKind string

const (
	nilfsCASPreflightConflictLegacy nilfsCASPreflightConflictKind = "legacy"
	nilfsCASPreflightConflictEvm    nilfsCASPreflightConflictKind = "evm"
	nilfsCASPreflightConflictUpload nilfsCASPreflightConflictKind = "upload"
)

func recordNilfsCASPreflightConflict(kind nilfsCASPreflightConflictKind) {
	atomic.AddUint64(&nilfsCASStatusCounters.preflightConflictsTotal, 1)
	switch kind {
	case nilfsCASPreflightConflictEvm:
		atomic.AddUint64(&nilfsCASStatusCounters.preflightConflictsEvm, 1)
	case nilfsCASPreflightConflictUpload:
		atomic.AddUint64(&nilfsCASStatusCounters.preflightConflictsUpload, 1)
	default:
		atomic.AddUint64(&nilfsCASStatusCounters.preflightConflictsLegacy, 1)
	}
}

func nilfsCASStatusSnapshotForStatus() map[string]string {
	return map[string]string{
		"nilfs_cas_preflight_conflicts_total":  strconv.FormatUint(atomic.LoadUint64(&nilfsCASStatusCounters.preflightConflictsTotal), 10),
		"nilfs_cas_preflight_conflicts_legacy": strconv.FormatUint(atomic.LoadUint64(&nilfsCASStatusCounters.preflightConflictsLegacy), 10),
		"nilfs_cas_preflight_conflicts_evm":    strconv.FormatUint(atomic.LoadUint64(&nilfsCASStatusCounters.preflightConflictsEvm), 10),
		"nilfs_cas_preflight_conflicts_upload": strconv.FormatUint(atomic.LoadUint64(&nilfsCASStatusCounters.preflightConflictsUpload), 10),
	}
}

func resetNilfsCASStatusCountersForTest() {
	atomic.StoreUint64(&nilfsCASStatusCounters.preflightConflictsTotal, 0)
	atomic.StoreUint64(&nilfsCASStatusCounters.preflightConflictsLegacy, 0)
	atomic.StoreUint64(&nilfsCASStatusCounters.preflightConflictsEvm, 0)
	atomic.StoreUint64(&nilfsCASStatusCounters.preflightConflictsUpload, 0)
}

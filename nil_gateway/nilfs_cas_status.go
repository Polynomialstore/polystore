package main

import (
	"strconv"
	"sync/atomic"
)

var nilfsCASStatusCounters struct {
	preflightConflictsTotal  uint64
	preflightConflictsLegacy uint64
	preflightConflictsEvm    uint64
}

func recordNilfsCASPreflightConflict(isEvm bool) {
	atomic.AddUint64(&nilfsCASStatusCounters.preflightConflictsTotal, 1)
	if isEvm {
		atomic.AddUint64(&nilfsCASStatusCounters.preflightConflictsEvm, 1)
		return
	}
	atomic.AddUint64(&nilfsCASStatusCounters.preflightConflictsLegacy, 1)
}

func nilfsCASStatusSnapshotForStatus() map[string]string {
	return map[string]string{
		"nilfs_cas_preflight_conflicts_total":  strconv.FormatUint(atomic.LoadUint64(&nilfsCASStatusCounters.preflightConflictsTotal), 10),
		"nilfs_cas_preflight_conflicts_legacy": strconv.FormatUint(atomic.LoadUint64(&nilfsCASStatusCounters.preflightConflictsLegacy), 10),
		"nilfs_cas_preflight_conflicts_evm":    strconv.FormatUint(atomic.LoadUint64(&nilfsCASStatusCounters.preflightConflictsEvm), 10),
	}
}

func resetNilfsCASStatusCountersForTest() {
	atomic.StoreUint64(&nilfsCASStatusCounters.preflightConflictsTotal, 0)
	atomic.StoreUint64(&nilfsCASStatusCounters.preflightConflictsLegacy, 0)
	atomic.StoreUint64(&nilfsCASStatusCounters.preflightConflictsEvm, 0)
}

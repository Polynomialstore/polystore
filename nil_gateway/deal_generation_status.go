package main

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type dealGenerationStatusSnapshot struct {
	Deals              uint64
	Active             uint64
	Provisional        uint64
	ProvisionalRecent  uint64
	ProvisionalExpired uint64
	Incomplete         uint64
	Invalid            uint64
	BytesActive        uint64
	BytesProvisional   uint64
	BytesTotal         uint64
	RetentionTTL       time.Duration
}

func dealGenerationStatusSnapshotForStatus() map[string]string {
	return dealGenerationStatusSnapshotAt(time.Now().UTC()).toStatusMap()
}

func (s dealGenerationStatusSnapshot) toStatusMap() map[string]string {
	return map[string]string{
		"nilfs_generation_deals":                             strconv.FormatUint(s.Deals, 10),
		"nilfs_generation_active":                            strconv.FormatUint(s.Active, 10),
		"nilfs_generation_provisional":                       strconv.FormatUint(s.Provisional, 10),
		"nilfs_generation_provisional_recent":                strconv.FormatUint(s.ProvisionalRecent, 10),
		"nilfs_generation_provisional_expired":               strconv.FormatUint(s.ProvisionalExpired, 10),
		"nilfs_generation_incomplete":                        strconv.FormatUint(s.Incomplete, 10),
		"nilfs_generation_invalid":                           strconv.FormatUint(s.Invalid, 10),
		"nilfs_generation_bytes_active":                      strconv.FormatUint(s.BytesActive, 10),
		"nilfs_generation_bytes_provisional":                 strconv.FormatUint(s.BytesProvisional, 10),
		"nilfs_generation_bytes_total":                       strconv.FormatUint(s.BytesTotal, 10),
		"nilfs_generation_provisional_retention_ttl_seconds": strconv.FormatInt(int64(s.RetentionTTL/time.Second), 10),
	}
}

func dealGenerationStatusSnapshotAt(now time.Time) dealGenerationStatusSnapshot {
	snapshot := dealGenerationStatusSnapshot{
		RetentionTTL: configuredProvisionalGenerationRetentionTTL(),
	}
	baseDealsDir := filepath.Join(uploadDir, "deals")
	dealEntries, err := os.ReadDir(baseDealsDir)
	if err != nil {
		return snapshot
	}

	for _, dealEntry := range dealEntries {
		if !dealEntry.IsDir() {
			continue
		}
		if _, err := strconv.ParseUint(strings.TrimSpace(dealEntry.Name()), 10, 64); err != nil {
			continue
		}

		dealHasGeneration := false
		dealDir := filepath.Join(baseDealsDir, dealEntry.Name())
		generationEntries, err := os.ReadDir(dealDir)
		if err != nil {
			continue
		}
		for _, generationEntry := range generationEntries {
			if !generationEntry.IsDir() {
				continue
			}
			name := strings.TrimSpace(generationEntry.Name())
			if !isManifestRootDirName(name) {
				continue
			}
			dealHasGeneration = true
			generationDir := filepath.Join(dealDir, name)
			classifyDealGenerationStatus(&snapshot, generationDir, now)
		}
		if dealHasGeneration {
			snapshot.Deals++
		}
	}

	snapshot.BytesTotal = snapshot.BytesActive + snapshot.BytesProvisional
	return snapshot
}

func classifyDealGenerationStatus(snapshot *dealGenerationStatusSnapshot, generationDir string, now time.Time) {
	if snapshot == nil {
		return
	}
	if _, err := os.Stat(filepath.Join(generationDir, mode2SlabCompleteMarker)); err != nil {
		snapshot.Incomplete++
		return
	}
	meta, err := loadSlabMetadataWithFallback(generationDir)
	if err != nil {
		snapshot.Invalid++
		return
	}
	sizeBytes := dirSizeBytes(generationDir)
	switch strings.TrimSpace(meta.GenerationState) {
	case "", slabGenerationStateActive:
		snapshot.Active++
		snapshot.BytesActive += sizeBytes
	case slabGenerationStateProvisional:
		snapshot.Provisional++
		snapshot.BytesProvisional += sizeBytes
		createdAt, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(meta.CreatedAt))
		if err != nil {
			snapshot.Invalid++
			return
		}
		if snapshot.RetentionTTL > 0 && now.Sub(createdAt) > snapshot.RetentionTTL {
			snapshot.ProvisionalExpired++
		} else {
			snapshot.ProvisionalRecent++
		}
	default:
		snapshot.Invalid++
	}
}

func dirSizeBytes(root string) uint64 {
	var total uint64
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d == nil || d.IsDir() {
			return nil
		}
		info, statErr := d.Info()
		if statErr != nil {
			return nil
		}
		if info.Size() > 0 {
			total += uint64(info.Size())
		}
		return nil
	})
	return total
}

func formatDealGenerationStatusSummary(snapshot dealGenerationStatusSnapshot) string {
	return fmt.Sprintf(
		"deals=%d active=%d provisional=%d recent=%d expired=%d incomplete=%d invalid=%d bytes_total=%d",
		snapshot.Deals,
		snapshot.Active,
		snapshot.Provisional,
		snapshot.ProvisionalRecent,
		snapshot.ProvisionalExpired,
		snapshot.Incomplete,
		snapshot.Invalid,
		snapshot.BytesTotal,
	)
}

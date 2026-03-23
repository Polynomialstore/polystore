package main

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
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

type dealGenerationDetail struct {
	ManifestRoot         string  `json:"manifest_root"`
	Status               string  `json:"status"`
	GenerationState      string  `json:"generation_state,omitempty"`
	PreviousManifestRoot string  `json:"previous_manifest_root,omitempty"`
	Source               string  `json:"source,omitempty"`
	CreatedAt            string  `json:"created_at,omitempty"`
	LastValidatedAt      *string `json:"last_validated_at,omitempty"`
	TotalMdus            uint64  `json:"total_mdus,omitempty"`
	WitnessMdus          uint64  `json:"witness_mdus,omitempty"`
	UserMdus             uint64  `json:"user_mdus,omitempty"`
	FileCount            int     `json:"file_count"`
	BytesTotal           uint64  `json:"bytes_total"`
	Ready                bool    `json:"ready"`
	Expired              bool    `json:"expired"`
	ActivePointer        bool    `json:"active_pointer"`
}

type dealGenerationListResponse struct {
	DealID                      uint64                 `json:"deal_id"`
	ActiveGeneration            string                 `json:"active_generation,omitempty"`
	ProvisionalRetentionSeconds int64                  `json:"provisional_retention_ttl_seconds"`
	Generations                 []dealGenerationDetail `json:"generations"`
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

func listDealGenerationDetails(dealID uint64, now time.Time) ([]dealGenerationDetail, ManifestRoot, error) {
	baseDealDir := dealScopedBaseDir(dealID)
	entries, err := os.ReadDir(baseDealDir)
	if err != nil {
		return nil, ManifestRoot{}, err
	}

	activeRoot, activeErr := readActiveDealGeneration(dealID)
	activeKey := ""
	if activeErr == nil {
		activeKey = activeRoot.Key
	}
	retentionTTL := configuredProvisionalGenerationRetentionTTL()
	details := make([]dealGenerationDetail, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := strings.TrimSpace(entry.Name())
		if !isManifestRootDirName(name) {
			continue
		}
		detail := describeDealGenerationDir(filepath.Join(baseDealDir, name), activeKey, now, retentionTTL)
		if detail.ManifestRoot == "" {
			continue
		}
		details = append(details, detail)
	}

	sort.SliceStable(details, func(i, j int) bool {
		if details[i].ActivePointer != details[j].ActivePointer {
			return details[i].ActivePointer
		}
		if details[i].Status != details[j].Status {
			return details[i].Status < details[j].Status
		}
		if details[i].CreatedAt != details[j].CreatedAt {
			return details[i].CreatedAt > details[j].CreatedAt
		}
		return details[i].ManifestRoot < details[j].ManifestRoot
	})

	if activeErr != nil {
		return details, ManifestRoot{}, nil
	}
	return details, activeRoot, nil
}

func describeDealGenerationDir(generationDir string, activeKey string, now time.Time, retentionTTL time.Duration) dealGenerationDetail {
	manifestRoot := inferManifestRootForDealDir(generationDir)
	detail := dealGenerationDetail{
		ManifestRoot:  manifestRoot,
		BytesTotal:    dirSizeBytes(generationDir),
		Ready:         mode2DirLooksComplete(generationDir),
		ActivePointer: activeKey != "" && strings.EqualFold(activeKey, filepath.Base(generationDir)),
		Status:        "incomplete",
	}
	if !detail.Ready {
		return detail
	}

	meta, err := loadSlabMetadataWithFallback(generationDir)
	if err != nil {
		detail.Status = "invalid"
		return detail
	}

	detail.GenerationState = strings.TrimSpace(meta.GenerationState)
	if detail.GenerationState == "" {
		detail.GenerationState = slabGenerationStateActive
	}
	detail.PreviousManifestRoot = strings.TrimSpace(meta.PreviousManifestRoot)
	detail.Source = strings.TrimSpace(meta.Source)
	detail.CreatedAt = strings.TrimSpace(meta.CreatedAt)
	detail.LastValidatedAt = meta.LastValidatedAt
	detail.TotalMdus = meta.TotalMdus
	detail.WitnessMdus = meta.WitnessMdus
	detail.UserMdus = meta.UserMdus
	detail.FileCount = len(meta.FileRecords)

	switch detail.GenerationState {
	case slabGenerationStateActive:
		detail.Status = slabGenerationStateActive
	case slabGenerationStateProvisional:
		detail.Status = "provisional_recent"
		if createdAt, parseErr := time.Parse(time.RFC3339Nano, detail.CreatedAt); parseErr != nil {
			detail.Status = "invalid"
		} else if retentionTTL > 0 && now.Sub(createdAt) > retentionTTL {
			detail.Status = "provisional_expired"
			detail.Expired = true
		}
	default:
		detail.Status = "invalid"
	}

	return detail
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

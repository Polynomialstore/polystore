package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"nilchain/x/crypto_ffi"
)

const (
	slabMetadataSchemaVersion      = 1
	slabMetadataFileName           = "slab_meta.json"
	slabGenerationStateActive      = "active"
	slabGenerationStateProvisional = "provisional"
)

type slabMetadataRedundancy struct {
	K uint64 `json:"k,omitempty"`
	M uint64 `json:"m,omitempty"`
	N uint64 `json:"n,omitempty"`
}

type slabMetadataFileRecord struct {
	Path        string `json:"path"`
	StartOffset uint64 `json:"start_offset"`
	SizeBytes   uint64 `json:"size_bytes"`
	Flags       uint8  `json:"flags"`
}

type slabMetadataDocument struct {
	SchemaVersion        int                      `json:"schema_version"`
	GenerationID         string                   `json:"generation_id"`
	GenerationState      string                   `json:"generation_state,omitempty"`
	DealID               *uint64                  `json:"deal_id,omitempty"`
	ManifestRoot         string                   `json:"manifest_root"`
	PreviousManifestRoot string                   `json:"previous_manifest_root,omitempty"`
	Owner                string                   `json:"owner,omitempty"`
	Redundancy           *slabMetadataRedundancy  `json:"redundancy,omitempty"`
	Source               string                   `json:"source"`
	CreatedAt            string                   `json:"created_at"`
	LastValidatedAt      *string                  `json:"last_validated_at"`
	WitnessMdus          uint64                   `json:"witness_mdus"`
	UserMdus             uint64                   `json:"user_mdus"`
	TotalMdus            uint64                   `json:"total_mdus"`
	FileRecords          []slabMetadataFileRecord `json:"file_records"`
}

type slabMetadataBuildOptions struct {
	GenerationID         string
	GenerationState      string
	DealID               *uint64
	ManifestRoot         string
	PreviousManifestRoot string
	Owner                string
	Redundancy           *slabMetadataRedundancy
	Source               string
	CreatedAt            time.Time
	LastValidatedAt      *time.Time
	WitnessMdus          *uint64
	UserMdus             *uint64
	TotalMdus            *uint64
	FileRecords          []slabMetadataFileRecord
}

func slabMetadataPathForDealDir(dealDir string) string {
	return filepath.Join(dealDir, slabMetadataFileName)
}

func inferGenerationIDForDealDir(dealDir string) string {
	gen := strings.TrimSpace(filepath.Base(dealDir))
	if gen == "" || gen == "." {
		return "unknown"
	}
	return gen
}

func inferManifestRootForDealDir(dealDir string) string {
	base := strings.TrimSpace(filepath.Base(dealDir))
	if base == "" || base == "." {
		return ""
	}
	if parsed, err := parseManifestRoot(base); err == nil {
		return parsed.Canonical
	}
	if parsed, err := parseManifestRoot("0x" + base); err == nil {
		return parsed.Canonical
	}
	return base
}

func slabMetadataManifestKey(raw string) (string, bool) {
	parsed, err := parseManifestRoot(strings.TrimSpace(raw))
	if err != nil {
		return "", false
	}
	return parsed.Key, true
}

func slabMetadataManifestMatchesDealDir(manifestRoot string, dealDir string) bool {
	manifestKey, ok := slabMetadataManifestKey(manifestRoot)
	if !ok {
		return false
	}
	dirKey, ok := slabMetadataManifestKey(inferManifestRootForDealDir(dealDir))
	if !ok {
		return false
	}
	return manifestKey == dirKey
}

func inferDealIDFromDealDir(dealDir string) *uint64 {
	parent := strings.TrimSpace(filepath.Base(filepath.Dir(filepath.Clean(dealDir))))
	if parent == "" {
		return nil
	}
	dealID, err := strconv.ParseUint(parent, 10, 64)
	if err != nil {
		return nil
	}
	return &dealID
}

func normalizeSlabMetadataFileRecords(records []slabMetadataFileRecord) []slabMetadataFileRecord {
	latest := make(map[string]slabMetadataFileRecord, len(records))
	order := make([]string, 0, len(records))
	for _, rec := range records {
		path := strings.TrimSpace(rec.Path)
		if path == "" {
			continue
		}
		rec.Path = path
		if _, ok := latest[path]; !ok {
			order = append(order, path)
		}
		latest[path] = rec
	}
	out := make([]slabMetadataFileRecord, 0, len(order))
	for _, path := range order {
		out = append(out, latest[path])
	}
	return out
}

func slabMetadataMaxEnd(records []slabMetadataFileRecord) uint64 {
	var maxEnd uint64
	for _, rec := range records {
		end := rec.StartOffset + rec.SizeBytes
		if end > maxEnd {
			maxEnd = end
		}
	}
	return maxEnd
}

func slabMetadataFileRecordsFromBuilder(b *crypto_ffi.Mdu0Builder) []slabMetadataFileRecord {
	if b == nil {
		return nil
	}
	records := make([]slabMetadataFileRecord, 0, b.GetRecordCount())
	count := b.GetRecordCount()
	for i := uint32(0); i < count; i++ {
		rec, err := b.GetRecord(i)
		if err != nil {
			continue
		}
		if rec.Path[0] == 0 {
			continue
		}
		path := string(bytes.TrimRight(rec.Path[:], "\x00"))
		if path == "" {
			continue
		}
		sizeBytes, flags := crypto_ffi.UnpackLengthAndFlags(rec.LengthAndFlags)
		records = append(records, slabMetadataFileRecord{
			Path:        path,
			StartOffset: rec.StartOffset,
			SizeBytes:   sizeBytes,
			Flags:       flags,
		})
	}
	return normalizeSlabMetadataFileRecords(records)
}

func validateSlabMetadataDocument(meta *slabMetadataDocument) error {
	if meta == nil {
		return errors.New("slab metadata is nil")
	}
	if meta.SchemaVersion < slabMetadataSchemaVersion {
		return fmt.Errorf("unsupported slab metadata schema_version=%d", meta.SchemaVersion)
	}
	if strings.TrimSpace(meta.GenerationID) == "" {
		return errors.New("slab metadata generation_id is required")
	}
	state := strings.TrimSpace(meta.GenerationState)
	if state == "" {
		state = slabGenerationStateActive
	}
	if state != slabGenerationStateActive && state != slabGenerationStateProvisional {
		return fmt.Errorf("invalid slab metadata generation_state=%q", meta.GenerationState)
	}
	if strings.TrimSpace(meta.ManifestRoot) == "" {
		return errors.New("slab metadata manifest_root is required")
	}
	if previous := strings.TrimSpace(meta.PreviousManifestRoot); previous != "" {
		if _, err := parseManifestRoot(previous); err != nil {
			return fmt.Errorf("invalid slab metadata previous_manifest_root: %w", err)
		}
	}
	if strings.TrimSpace(meta.Source) == "" {
		return errors.New("slab metadata source is required")
	}
	if strings.TrimSpace(meta.CreatedAt) == "" {
		return errors.New("slab metadata created_at is required")
	}
	if meta.TotalMdus != 1+meta.WitnessMdus+meta.UserMdus {
		return fmt.Errorf(
			"invalid slab metadata counts: total_mdus=%d witness_mdus=%d user_mdus=%d",
			meta.TotalMdus,
			meta.WitnessMdus,
			meta.UserMdus,
		)
	}
	for i, rec := range meta.FileRecords {
		if strings.TrimSpace(rec.Path) == "" {
			return fmt.Errorf("slab metadata file_records[%d].path is required", i)
		}
	}
	if meta.LastValidatedAt != nil && strings.TrimSpace(*meta.LastValidatedAt) == "" {
		return errors.New("slab metadata last_validated_at must be null or non-empty")
	}
	return nil
}

func newSlabMetadataDocument(opts slabMetadataBuildOptions) (*slabMetadataDocument, error) {
	records := normalizeSlabMetadataFileRecords(opts.FileRecords)

	witnessMdus := uint64(0)
	if opts.WitnessMdus != nil {
		witnessMdus = *opts.WitnessMdus
	}

	userMdus := uint64(0)
	if opts.UserMdus != nil {
		userMdus = *opts.UserMdus
	} else if maxEnd := slabMetadataMaxEnd(records); maxEnd > 0 {
		userMdus = (maxEnd + RawMduCapacity - 1) / RawMduCapacity
	}

	totalMdus := uint64(1) + witnessMdus + userMdus
	if opts.TotalMdus != nil {
		totalMdus = *opts.TotalMdus
	}

	createdAt := opts.CreatedAt
	if createdAt.IsZero() {
		createdAt = time.Now().UTC()
	}

	var lastValidatedAt *string
	if opts.LastValidatedAt != nil {
		ts := opts.LastValidatedAt.UTC().Format(time.RFC3339Nano)
		lastValidatedAt = &ts
	}

	manifestRoot := strings.TrimSpace(opts.ManifestRoot)
	source := strings.TrimSpace(opts.Source)
	if source == "" {
		source = "unknown"
	}
	meta := &slabMetadataDocument{
		SchemaVersion:        slabMetadataSchemaVersion,
		GenerationID:         strings.TrimSpace(opts.GenerationID),
		GenerationState:      strings.TrimSpace(opts.GenerationState),
		DealID:               opts.DealID,
		ManifestRoot:         manifestRoot,
		PreviousManifestRoot: strings.TrimSpace(opts.PreviousManifestRoot),
		Owner:                strings.TrimSpace(opts.Owner),
		Redundancy:           opts.Redundancy,
		Source:               source,
		CreatedAt:            createdAt.Format(time.RFC3339Nano),
		LastValidatedAt:      lastValidatedAt,
		WitnessMdus:          witnessMdus,
		UserMdus:             userMdus,
		TotalMdus:            totalMdus,
		FileRecords:          records,
	}
	if err := validateSlabMetadataDocument(meta); err != nil {
		return nil, err
	}
	return meta, nil
}

func buildSlabMetadataFromBuilder(b *crypto_ffi.Mdu0Builder, opts slabMetadataBuildOptions) (*slabMetadataDocument, error) {
	if b == nil {
		return nil, errors.New("nil mdu0 builder")
	}
	if len(opts.FileRecords) == 0 {
		opts.FileRecords = slabMetadataFileRecordsFromBuilder(b)
	}
	return newSlabMetadataDocument(opts)
}

func readSlabMetadataFile(dealDir string) (*slabMetadataDocument, error) {
	data, err := os.ReadFile(slabMetadataPathForDealDir(dealDir))
	if err != nil {
		return nil, err
	}
	var meta slabMetadataDocument
	if err := json.Unmarshal(data, &meta); err != nil {
		return nil, err
	}
	meta.GenerationID = strings.TrimSpace(meta.GenerationID)
	meta.GenerationState = strings.TrimSpace(meta.GenerationState)
	meta.ManifestRoot = strings.TrimSpace(meta.ManifestRoot)
	meta.PreviousManifestRoot = strings.TrimSpace(meta.PreviousManifestRoot)
	meta.Owner = strings.TrimSpace(meta.Owner)
	meta.Source = strings.TrimSpace(meta.Source)
	meta.CreatedAt = strings.TrimSpace(meta.CreatedAt)
	if meta.LastValidatedAt != nil {
		trimmed := strings.TrimSpace(*meta.LastValidatedAt)
		meta.LastValidatedAt = &trimmed
	}
	meta.FileRecords = normalizeSlabMetadataFileRecords(meta.FileRecords)
	if err := validateSlabMetadataDocument(&meta); err != nil {
		return nil, err
	}
	return &meta, nil
}

func writeSlabMetadataFile(dealDir string, meta *slabMetadataDocument) error {
	if meta == nil {
		return errors.New("nil slab metadata")
	}
	copyMeta := *meta
	if copyMeta.SchemaVersion == 0 {
		copyMeta.SchemaVersion = slabMetadataSchemaVersion
	}
	if copyMeta.GenerationID == "" {
		copyMeta.GenerationID = inferGenerationIDForDealDir(dealDir)
	}
	if copyMeta.ManifestRoot == "" {
		copyMeta.ManifestRoot = inferManifestRootForDealDir(dealDir)
	}
	if copyMeta.DealID == nil {
		copyMeta.DealID = inferDealIDFromDealDir(dealDir)
	}
	if copyMeta.Source == "" {
		copyMeta.Source = "unknown"
	}
	if copyMeta.CreatedAt == "" {
		copyMeta.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	copyMeta.GenerationID = strings.TrimSpace(copyMeta.GenerationID)
	copyMeta.GenerationState = strings.TrimSpace(copyMeta.GenerationState)
	copyMeta.ManifestRoot = strings.TrimSpace(copyMeta.ManifestRoot)
	copyMeta.PreviousManifestRoot = strings.TrimSpace(copyMeta.PreviousManifestRoot)
	copyMeta.Owner = strings.TrimSpace(copyMeta.Owner)
	copyMeta.Source = strings.TrimSpace(copyMeta.Source)
	copyMeta.CreatedAt = strings.TrimSpace(copyMeta.CreatedAt)
	copyMeta.FileRecords = normalizeSlabMetadataFileRecords(copyMeta.FileRecords)
	if copyMeta.TotalMdus == 0 {
		copyMeta.TotalMdus = 1 + copyMeta.WitnessMdus + copyMeta.UserMdus
	}
	if err := validateSlabMetadataDocument(&copyMeta); err != nil {
		return err
	}
	encoded, err := json.MarshalIndent(&copyMeta, "", "  ")
	if err != nil {
		return err
	}
	encoded = append(encoded, '\n')
	return os.WriteFile(slabMetadataPathForDealDir(dealDir), encoded, 0o644)
}

func synthesizeSlabMetadataFromMdu0(dealDir string) (*slabMetadataDocument, error) {
	mdu0Path := filepath.Join(dealDir, "mdu_0.bin")
	mdu0Bytes, err := os.ReadFile(mdu0Path)
	if err != nil {
		return nil, err
	}
	b, err := crypto_ffi.LoadMdu0Builder(mdu0Bytes, 1)
	if err != nil {
		return nil, err
	}
	defer b.Free()

	witnessMdus, err := inferWitnessCount(dealDir, b)
	if err != nil {
		return nil, err
	}
	records := slabMetadataFileRecordsFromBuilder(b)
	userMdus := uint64(0)
	if maxEnd := slabMetadataMaxEnd(records); maxEnd > 0 {
		userMdus = (maxEnd + RawMduCapacity - 1) / RawMduCapacity
	}
	totalMdus := uint64(1) + witnessMdus + userMdus

	return newSlabMetadataDocument(slabMetadataBuildOptions{
		GenerationID: inferGenerationIDForDealDir(dealDir),
		DealID:       inferDealIDFromDealDir(dealDir),
		ManifestRoot: inferManifestRootForDealDir(dealDir),
		Source:       "gateway_fallback_mdu0",
		WitnessMdus:  &witnessMdus,
		UserMdus:     &userMdus,
		TotalMdus:    &totalMdus,
		FileRecords:  records,
	})
}

func loadSlabMetadataWithFallback(dealDir string) (*slabMetadataDocument, error) {
	meta, err := readSlabMetadataFile(dealDir)
	if err == nil {
		return meta, nil
	}

	metaPath := slabMetadataPathForDealDir(dealDir)
	metaExists := false
	if _, statErr := os.Stat(metaPath); statErr == nil {
		metaExists = true
		log.Printf("loadSlabMetadataWithFallback: unreadable slab metadata at %s (using synthesized fallback): %v", metaPath, err)
	}

	synthesized, synthErr := synthesizeSlabMetadataFromMdu0(dealDir)
	if synthErr != nil {
		return nil, synthErr
	}

	// Preserve existing metadata files (including forward-compatible schemas) on read fallback.
	if metaExists {
		return synthesized, nil
	}

	if writeErr := writeSlabMetadataFile(dealDir, synthesized); writeErr != nil {
		log.Printf("loadSlabMetadataWithFallback: failed to persist synthesized metadata at %s: %v", metaPath, writeErr)
	}
	return synthesized, nil
}

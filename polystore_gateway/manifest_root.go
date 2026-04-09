package main

import (
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	gnarkBls12381 "github.com/consensys/gnark-crypto/ecc/bls12-381"
)

var (
	ErrInvalidManifestRoot    = errors.New("invalid manifest_root")
	ErrDealDirConflict        = errors.New("deal directory conflict")
	ErrDealGenerationNotReady = errors.New("deal generation not ready")
)

const provisionalGenerationRetentionTTL = 24 * time.Hour
const defaultProvisionalGenerationRetentionTTL = 24 * time.Hour

func configuredProvisionalGenerationRetentionTTL() time.Duration {
	raw := strings.TrimSpace(envDefault("POLYSTORE_PROVISIONAL_GENERATION_RETENTION_TTL", defaultProvisionalGenerationRetentionTTL.String()))
	if raw == "" {
		return defaultProvisionalGenerationRetentionTTL
	}
	ttl, err := time.ParseDuration(raw)
	if err != nil {
		log.Printf(
			"Gateway cache recovery: invalid POLYSTORE_PROVISIONAL_GENERATION_RETENTION_TTL=%q; falling back to %s",
			raw,
			defaultProvisionalGenerationRetentionTTL,
		)
		return defaultProvisionalGenerationRetentionTTL
	}
	if ttl < 0 {
		log.Printf(
			"Gateway cache recovery: negative POLYSTORE_PROVISIONAL_GENERATION_RETENTION_TTL=%q; falling back to %s",
			raw,
			defaultProvisionalGenerationRetentionTTL,
		)
		return defaultProvisionalGenerationRetentionTTL
	}
	return ttl
}

type ManifestRoot struct {
	Bytes     [48]byte
	Canonical string // 0x + lowercase hex (96 chars)
	Key       string // lowercase hex (96 chars), no 0x
}

func parseManifestRoot(raw string) (ManifestRoot, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ManifestRoot{}, fmt.Errorf("%w: empty", ErrInvalidManifestRoot)
	}
	trimmed = strings.TrimPrefix(trimmed, "0x")
	if len(trimmed) != 96 {
		return ManifestRoot{}, fmt.Errorf("%w: expected 96 hex chars (48 bytes), got %d", ErrInvalidManifestRoot, len(trimmed))
	}
	decoded, err := hex.DecodeString(trimmed)
	if err != nil {
		return ManifestRoot{}, fmt.Errorf("%w: invalid hex: %v", ErrInvalidManifestRoot, err)
	}
	if len(decoded) != 48 {
		return ManifestRoot{}, fmt.Errorf("%w: decoded length %d (expected 48)", ErrInvalidManifestRoot, len(decoded))
	}

	var point gnarkBls12381.G1Affine
	if _, err := point.SetBytes(decoded); err != nil {
		return ManifestRoot{}, fmt.Errorf("%w: invalid compressed G1: %v", ErrInvalidManifestRoot, err)
	}

	normalized := point.Bytes()
	key := hex.EncodeToString(normalized[:])
	var out ManifestRoot
	copy(out.Bytes[:], normalized[:])
	out.Key = key
	out.Canonical = "0x" + key
	return out, nil
}

func resolveDealDir(root ManifestRoot, rawParam string) (string, error) {
	canonicalDir := filepath.Join(uploadDir, root.Key)
	legacyCandidates := []string{
		filepath.Join(uploadDir, root.Canonical),
	}

	rawTrimmed := strings.TrimSpace(rawParam)
	if rawTrimmed != "" {
		legacyCandidates = append(legacyCandidates, filepath.Join(uploadDir, rawTrimmed))
		if lower := strings.ToLower(rawTrimmed); lower != rawTrimmed {
			legacyCandidates = append(legacyCandidates, filepath.Join(uploadDir, lower))
		}
	}

	existingLegacy := make([]string, 0, len(legacyCandidates))
	for _, cand := range legacyCandidates {
		if cand == canonicalDir {
			continue
		}
		if info, err := os.Stat(cand); err == nil && info.IsDir() {
			existingLegacy = append(existingLegacy, cand)
		}
	}

	if info, err := os.Stat(canonicalDir); err == nil && info.IsDir() {
		if len(existingLegacy) > 0 {
			return "", fmt.Errorf("%w: canonical=%s legacy=%v", ErrDealDirConflict, canonicalDir, existingLegacy)
		}
		return canonicalDir, nil
	}

	if len(existingLegacy) == 1 {
		if err := os.Rename(existingLegacy[0], canonicalDir); err != nil {
			return "", fmt.Errorf("failed to canonicalize deal dir: %w", err)
		}
		return canonicalDir, nil
	}
	if len(existingLegacy) > 1 {
		return "", fmt.Errorf("%w: multiple legacy dirs found for manifest_root_key=%s: %v", ErrDealDirConflict, root.Key, existingLegacy)
	}

	return canonicalDir, os.ErrNotExist
}

func dealScopedDir(dealID uint64, root ManifestRoot) string {
	return filepath.Join(uploadDir, "deals", strconv.FormatUint(dealID, 10), root.Key)
}

func dealScopedBaseDir(dealID uint64) string {
	return filepath.Join(uploadDir, "deals", strconv.FormatUint(dealID, 10))
}

func activeDealGenerationPointerPath(dealID uint64) string {
	return filepath.Join(dealScopedBaseDir(dealID), ".active_generation")
}

func readActiveDealGeneration(dealID uint64) (ManifestRoot, error) {
	data, err := os.ReadFile(activeDealGenerationPointerPath(dealID))
	if err != nil {
		return ManifestRoot{}, err
	}
	raw := strings.TrimSpace(string(data))
	if raw == "" {
		return ManifestRoot{}, os.ErrNotExist
	}
	if !strings.HasPrefix(strings.ToLower(raw), "0x") {
		raw = "0x" + raw
	}
	return parseManifestRoot(raw)
}

func writeActiveDealGeneration(dealID uint64, root ManifestRoot) error {
	base := dealScopedBaseDir(dealID)
	if err := os.MkdirAll(base, 0o755); err != nil {
		return err
	}
	tmpPath := filepath.Join(base, fmt.Sprintf(".active_generation.%d.tmp", time.Now().UnixNano()))
	if err := os.WriteFile(tmpPath, []byte(root.Canonical+"\n"), 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, activeDealGenerationPointerPath(dealID)); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	return nil
}

func clearActiveDealGeneration(dealID uint64) {
	_ = os.Remove(activeDealGenerationPointerPath(dealID))
}

func validateDealGenerationReadyStrict(dealDir string) error {
	if !mode2DirLooksComplete(dealDir) {
		return fmt.Errorf("slab core files are incomplete")
	}
	meta, err := loadSlabMetadataWithFallback(dealDir)
	if err != nil {
		return fmt.Errorf("failed to load slab metadata: %w", err)
	}
	if !slabMetadataManifestMatchesDealDir(meta.ManifestRoot, dealDir) {
		return fmt.Errorf("slab metadata manifest_root does not match generation directory")
	}
	requiredLocalMdus := uint64(1) + meta.WitnessMdus
	if requiredLocalMdus == 0 {
		requiredLocalMdus = 1
	}
	for i := uint64(0); i < requiredLocalMdus; i++ {
		path := filepath.Join(dealDir, fmt.Sprintf("mdu_%d.bin", i))
		info, statErr := os.Stat(path)
		if statErr != nil {
			return fmt.Errorf("missing mdu_%d.bin: %w", i, statErr)
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("mdu_%d.bin is not a regular file", i)
		}
	}
	return nil
}

func validateDealGenerationReadyBestEffort(dealDir string) error {
	if mode2DirLooksComplete(dealDir) {
		return validateDealGenerationReadyStrict(dealDir)
	}
	mdu0Path := filepath.Join(dealDir, "mdu_0.bin")
	info, err := os.Stat(mdu0Path)
	if err != nil {
		return fmt.Errorf("missing mdu_0.bin: %w", err)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("mdu_0.bin is not a regular file")
	}
	return nil
}

func cleanupInterruptedDealGenerations(dealID uint64) {
	baseDealDir := dealScopedBaseDir(dealID)
	entries, err := os.ReadDir(baseDealDir)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("Gateway cache recovery: failed to list deal dir deal_id=%d err=%v", dealID, err)
		}
		return
	}

	activeRoot := ""
	if root, err := readActiveDealGeneration(dealID); err == nil {
		activeRoot = root.Key
	} else if err != nil && !os.IsNotExist(err) {
		log.Printf("Gateway cache recovery: invalid active pointer deal_id=%d err=%v", dealID, err)
		clearActiveDealGeneration(dealID)
	}

	for _, entry := range entries {
		name := strings.TrimSpace(entry.Name())
		if name == "" {
			continue
		}
		fullPath := filepath.Join(baseDealDir, name)
		if !entry.IsDir() && strings.HasPrefix(name, ".") && strings.HasSuffix(name, ".lock") {
			lockInfo, statErr := os.Stat(fullPath)
			if statErr != nil || lockInfo.IsDir() {
				continue
			}
			targetRoot := strings.TrimSuffix(strings.TrimPrefix(name, "."), ".lock")
			targetDir := filepath.Join(baseDealDir, targetRoot)
			if time.Since(lockInfo.ModTime()) > 2*time.Minute && !mode2DirLooksComplete(targetDir) {
				_ = os.Remove(fullPath)
			}
			continue
		}
		if !entry.IsDir() {
			continue
		}
		if strings.HasPrefix(name, "staging-") || strings.HasPrefix(name, ".staging-") || strings.HasPrefix(name, ".tmp-") {
			if err := os.RemoveAll(fullPath); err != nil && !os.IsNotExist(err) {
				log.Printf("Gateway cache recovery: failed to remove staging dir deal_id=%d dir=%s err=%v", dealID, name, err)
			}
			continue
		}
		if !isManifestRootDirName(name) {
			continue
		}
		if activeRoot != "" && name == activeRoot {
			continue
		}
		if _, markerErr := os.Stat(filepath.Join(fullPath, mode2SlabCompleteMarker)); markerErr != nil {
			continue
		}
		if err := validateDealGenerationReadyStrict(fullPath); err != nil {
			if rmErr := os.RemoveAll(fullPath); rmErr != nil && !os.IsNotExist(rmErr) {
				log.Printf("Gateway cache recovery: failed to remove incomplete generation deal_id=%d generation=%s err=%v", dealID, name, rmErr)
			}
			continue
		}
		meta, metaErr := loadSlabMetadataWithFallback(fullPath)
		if metaErr != nil {
			log.Printf("Gateway cache recovery: failed to load generation metadata deal_id=%d generation=%s err=%v", dealID, name, metaErr)
			continue
		}
		if strings.TrimSpace(meta.GenerationState) != slabGenerationStateProvisional {
			continue
		}
		createdAt, parseErr := time.Parse(time.RFC3339Nano, strings.TrimSpace(meta.CreatedAt))
		if parseErr != nil {
			log.Printf("Gateway cache recovery: invalid provisional generation timestamp deal_id=%d generation=%s created_at=%q err=%v", dealID, name, meta.CreatedAt, parseErr)
			continue
		}
		retentionTTL := configuredProvisionalGenerationRetentionTTL()
		if retentionTTL <= 0 {
			continue
		}
		if time.Since(createdAt) <= retentionTTL {
			continue
		}
		if err := os.RemoveAll(fullPath); err != nil && !os.IsNotExist(err) {
			log.Printf(
				"Gateway cache recovery: failed to remove expired provisional generation deal_id=%d generation=%s err=%v",
				dealID,
				name,
				err,
			)
		} else {
			log.Printf(
				"Gateway cache recovery: removed expired provisional generation deal_id=%d generation=%s age=%s",
				dealID,
				name,
				time.Since(createdAt).Round(time.Second),
			)
		}
	}
}

func recoverDealGenerationStateOnStartup() {
	baseDealsDir := filepath.Join(uploadDir, "deals")
	entries, err := os.ReadDir(baseDealsDir)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("Gateway cache recovery: failed to list base deal dir %s err=%v", baseDealsDir, err)
		}
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		dealID, parseErr := strconv.ParseUint(strings.TrimSpace(entry.Name()), 10, 64)
		if parseErr != nil {
			continue
		}
		cleanupInterruptedDealGenerations(dealID)
	}
}

func resolveDealDirForDeal(dealID uint64, root ManifestRoot, rawParam string) (string, error) {
	cleanupInterruptedDealGenerations(dealID)
	requestedDir := dealScopedDir(dealID, root)

	if activeRoot, err := readActiveDealGeneration(dealID); err == nil {
		activeDir := dealScopedDir(dealID, activeRoot)
		if _, markerErr := os.Stat(filepath.Join(activeDir, mode2SlabCompleteMarker)); markerErr == nil {
			if activeRoot.Key != root.Key {
				if info, statErr := os.Stat(requestedDir); statErr == nil && info.IsDir() {
					if readyErr := validateDealGenerationReadyStrict(requestedDir); readyErr != nil {
						return "", fmt.Errorf("%w: %v", ErrDealGenerationNotReady, readyErr)
					}
					if setErr := writeActiveDealGeneration(dealID, root); setErr != nil {
						return "", fmt.Errorf("failed to update active generation pointer: %w", setErr)
					}
					return requestedDir, nil
				}
				return "", os.ErrNotExist
			}

			if info, statErr := os.Stat(activeDir); statErr == nil && info.IsDir() {
				if readyErr := validateDealGenerationReadyStrict(activeDir); readyErr != nil {
					return "", fmt.Errorf("%w: %v", ErrDealGenerationNotReady, readyErr)
				}
				return activeDir, nil
			}
		}
		clearActiveDealGeneration(dealID)
	}

	if info, err := os.Stat(requestedDir); err == nil && info.IsDir() {
		if readyErr := validateDealGenerationReadyBestEffort(requestedDir); readyErr != nil {
			return "", fmt.Errorf("%w: %v", ErrDealGenerationNotReady, readyErr)
		}
		if _, markerErr := os.Stat(filepath.Join(requestedDir, mode2SlabCompleteMarker)); markerErr == nil {
			if setErr := writeActiveDealGeneration(dealID, root); setErr != nil {
				return "", fmt.Errorf("failed to set active generation pointer: %w", setErr)
			}
		}
		return requestedDir, nil
	}

	legacyDir, err := resolveDealDir(root, rawParam)
	if err != nil {
		return "", err
	}
	if readyErr := validateDealGenerationReadyBestEffort(legacyDir); readyErr != nil {
		return "", fmt.Errorf("%w: %v", ErrDealGenerationNotReady, readyErr)
	}
	return legacyDir, nil
}

func isManifestRootDirName(name string) bool {
	if len(name) != 96 {
		return false
	}
	_, err := hex.DecodeString(name)
	return err == nil
}

func markDealGenerationActive(dealDir string) {
	meta, err := loadSlabMetadataWithFallback(dealDir)
	if err != nil {
		log.Printf("Gateway cache cleanup: failed to load slab metadata for active promotion dir=%s err=%v", dealDir, err)
		return
	}
	meta.GenerationState = slabGenerationStateActive
	if err := writeSlabMetadataFile(dealDir, meta); err != nil {
		log.Printf("Gateway cache cleanup: failed to persist active slab metadata dir=%s err=%v", dealDir, err)
	}
}

func cleanupStaleDealGenerations(dealID uint64, keepRoot ManifestRoot) {
	baseDealDir := filepath.Join(uploadDir, "deals", strconv.FormatUint(dealID, 10))
	entries, err := os.ReadDir(baseDealDir)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("Gateway cache cleanup: failed to list deal dir deal_id=%d err=%v", dealID, err)
		}
		return
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := strings.TrimSpace(entry.Name())
		if name == "" || name == keepRoot.Key {
			continue
		}
		if strings.HasPrefix(name, "staging-") || strings.HasPrefix(name, ".") {
			continue
		}
		if !isManifestRootDirName(name) {
			continue
		}

		srcDir := filepath.Join(baseDealDir, name)
		quarantineDir := filepath.Join(baseDealDir, fmt.Sprintf(".gc-%s-%d", name, time.Now().UnixNano()))
		if err := os.Rename(srcDir, quarantineDir); err != nil {
			if os.IsNotExist(err) {
				continue
			}
			log.Printf(
				"Gateway cache cleanup: failed to quarantine stale generation deal_id=%d stale_manifest_root=%s err=%v",
				dealID,
				name,
				err,
			)
			continue
		}
		if err := os.RemoveAll(quarantineDir); err != nil && !os.IsNotExist(err) {
			log.Printf(
				"Gateway cache cleanup: failed to remove stale generation deal_id=%d stale_manifest_root=%s err=%v",
				dealID,
				name,
				err,
			)
			continue
		}
		log.Printf(
			"Gateway cache cleanup: removed stale generation deal_id=%d stale_manifest_root=%s keep_manifest_root=%s",
			dealID,
			name,
			keepRoot.Key,
		)
	}

	if err := writeActiveDealGeneration(dealID, keepRoot); err != nil {
		log.Printf("Gateway cache cleanup: failed to persist active generation pointer deal_id=%d manifest_root=%s err=%v", dealID, keepRoot.Key, err)
	}
	markDealGenerationActive(dealScopedDir(dealID, keepRoot))
}

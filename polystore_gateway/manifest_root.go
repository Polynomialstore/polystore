package main

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"polystorechain/x/polystorechain/types"
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
	Bytes     [types.POLYFS_ROOT_SIZE]byte
	Canonical string // 0x + lowercase hex (64 chars)
	Key       string // lowercase hex (64 chars), no 0x
}

func parseManifestRoot(raw string) (ManifestRoot, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ManifestRoot{}, fmt.Errorf("%w: empty", ErrInvalidManifestRoot)
	}
	trimmed = strings.TrimPrefix(trimmed, "0x")
	expectedHexLen := types.POLYFS_ROOT_SIZE * 2
	if len(trimmed) != expectedHexLen {
		return ManifestRoot{}, fmt.Errorf("%w: expected %d hex chars (%d bytes), got %d", ErrInvalidManifestRoot, expectedHexLen, types.POLYFS_ROOT_SIZE, len(trimmed))
	}
	decoded, err := hex.DecodeString(trimmed)
	if err != nil {
		return ManifestRoot{}, fmt.Errorf("%w: invalid hex: %v", ErrInvalidManifestRoot, err)
	}
	if len(decoded) != types.POLYFS_ROOT_SIZE {
		return ManifestRoot{}, fmt.Errorf("%w: decoded length %d (expected %d)", ErrInvalidManifestRoot, len(decoded), types.POLYFS_ROOT_SIZE)
	}

	key := hex.EncodeToString(decoded)
	var out ManifestRoot
	copy(out.Bytes[:], decoded)
	out.Key = key
	out.Canonical = "0x" + key
	return out, nil
}

// legacyGenerationPaths only accepts aliases of the already validated root.
func legacyGenerationPaths(root ManifestRoot, rawParam string) []string {
	paths := []string{filepath.Join(uploadDir, root.Key), filepath.Join(uploadDir, root.Canonical)}
	raw := strings.TrimSpace(rawParam)
	if parsed, err := parseManifestRoot(raw); err == nil && parsed == root {
		candidate := filepath.Join(uploadDir, raw)
		if candidate != paths[0] && candidate != paths[1] {
			paths = append(paths, candidate)
		}
	}
	return paths
}

func resolveDealDir(root ManifestRoot, rawParam string) (string, error) {
	paths := legacyGenerationPaths(root, rawParam)
	found := ""
	for _, path := range paths {
		info, err := os.Lstat(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return "", err
		}
		if !info.IsDir() {
			return "", fmt.Errorf("%w: generation is not a directory", ErrDealDirConflict)
		}
		if found != "" {
			return "", fmt.Errorf("%w: multiple generation aliases", ErrDealDirConflict)
		}
		found = path
	}
	if found == "" {
		return paths[0], os.ErrNotExist
	}
	return found, nil // Reading a historical alias never renames or promotes it.
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
	if err := reconcileDealGenerations(context.Background(), []uint64{dealID}); err != nil {
		log.Printf("Generation retention: preserving deal_id=%d: %v", dealID, err)
	}
}

func startGenerationRetention() {
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			recoverDealGenerationStateOnStartup()
			<-ticker.C
		}
	}()
}

func recoverDealGenerationStateOnStartup() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	dir, err := os.Open(filepath.Join(uploadDir, "deals"))
	if err != nil {
		return
	}
	defer dir.Close()
	for ctx.Err() == nil {
		entries, err := dir.ReadDir(maxRetentionDealsPerPass)
		if err != nil && !errors.Is(err, io.EOF) {
			return
		}
		ids := make([]uint64, 0, len(entries))
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			id, err := strconv.ParseUint(entry.Name(), 10, 64)
			if err == nil && strconv.FormatUint(id, 10) == entry.Name() {
				ids = append(ids, id)
			}
		}
		if len(ids) > 0 {
			if err := reconcileDealGenerations(ctx, ids); err != nil {
				log.Printf("Generation retention: preserving unavailable inventory: %v", err)
				return
			}
		}
		if len(entries) < maxRetentionDealsPerPass {
			return
		}
	}
}

func lookupDealGeneration(dealID uint64, root ManifestRoot, rawParam string) (string, error) {
	dir := dealScopedDir(dealID, root)
	info, err := os.Lstat(dir)
	if errors.Is(err, os.ErrNotExist) {
		dir, err = resolveDealDir(root, rawParam)
	} else if err == nil && !info.IsDir() {
		return "", fmt.Errorf("%w: generation is not a directory", ErrDealDirConflict)
	}
	if err != nil {
		return "", err
	}
	return dir, nil
}

func resolveDealDirForDeal(dealID uint64, root ManifestRoot, rawParam string) (string, error) {
	dir, err := lookupDealGeneration(dealID, root, rawParam)
	if err != nil {
		return "", err
	}
	if err := validateDealGenerationReadyBestEffort(dir); err != nil {
		return "", fmt.Errorf("%w: %v", ErrDealGenerationNotReady, err)
	}
	return dir, nil
}

func isManifestRootDirName(name string) bool {
	if len(name) != types.POLYFS_ROOT_SIZE*2 {
		return false
	}
	_, err := hex.DecodeString(name)
	return err == nil
}

// The requested root is a lookup hint, never retention or promotion authority.
func cleanupStaleDealGenerations(dealID uint64, _ ManifestRoot) {
	cleanupInterruptedDealGenerations(dealID)
}

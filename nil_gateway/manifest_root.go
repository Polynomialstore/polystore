package main

import (
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	gnarkBls12381 "github.com/consensys/gnark-crypto/ecc/bls12-381"
)

var (
	ErrInvalidManifestRoot = errors.New("invalid manifest_root")
	ErrDealDirConflict     = errors.New("deal directory conflict")
)

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

func resolveDealDirForDeal(dealID uint64, root ManifestRoot, rawParam string) (string, error) {
	cand := dealScopedDir(dealID, root)
	if info, err := os.Stat(cand); err == nil && info.IsDir() {
		return cand, nil
	}
	return resolveDealDir(root, rawParam)
}

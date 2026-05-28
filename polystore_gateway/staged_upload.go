package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode"
)

const polystoreUploadGenerationHeader = "X-PolyStore-Upload-Generation"

func normalizeUploadGenerationID(raw string) (string, error) {
	generation := strings.TrimSpace(raw)
	if generation == "" {
		return "", nil
	}
	if len(generation) > 96 {
		return "", fmt.Errorf("upload generation id is too long")
	}
	for _, r := range generation {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '-' || r == '_' || r == '.' {
			continue
		}
		return "", fmt.Errorf("upload generation id contains invalid character %q", r)
	}
	if generation == "." || generation == ".." || strings.Contains(generation, "..") {
		return "", fmt.Errorf("upload generation id must not contain path traversal")
	}
	return generation, nil
}

func stagedUploadDir(dealID uint64, generationID string) string {
	return filepath.Join(uploadDir, "deals", strconv.FormatUint(dealID, 10), "staging", generationID)
}

func promoteStagedUploadGeneration(dealID uint64, generationID string, finalDir string) error {
	stageDir := stagedUploadDir(dealID, generationID)
	entries, err := os.ReadDir(stageDir)
	if err != nil {
		return fmt.Errorf("read staged upload generation: %w", err)
	}
	if err := ensureUploadRootDir(finalDir); err != nil {
		return fmt.Errorf("create final slab directory: %w", err)
	}
	for _, entry := range entries {
		if entry.IsDir() {
			return fmt.Errorf("staged upload generation contains unexpected directory %q", entry.Name())
		}
		src := filepath.Join(stageDir, entry.Name())
		dst := filepath.Join(finalDir, entry.Name())
		if err := os.Remove(dst); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("replace existing staged artifact %q: %w", entry.Name(), err)
		}
		if err := os.Rename(src, dst); err != nil {
			return fmt.Errorf("promote staged artifact %q: %w", entry.Name(), err)
		}
	}
	_ = os.Remove(stageDir)
	return nil
}

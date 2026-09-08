package main

import (
	"fmt"
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
	return publishImmutableGeneration(stagedUploadDir(dealID, generationID), finalDir)
}

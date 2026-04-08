package main

import (
	"fmt"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"
)

const nilfsRecordPathMaxBytes = 232

func validateNilfsFilePath(raw string) (string, error) {
	filePath := strings.TrimSpace(raw)
	if filePath == "" {
		return "", fmt.Errorf("file_path is required")
	}
	if strings.HasPrefix(filePath, "/") {
		return "", fmt.Errorf("file_path must be relative (no leading /)")
	}
	if strings.Contains(filePath, "\\") {
		return "", fmt.Errorf("file_path must not contain \\\\ separators")
	}
	if strings.Contains(filePath, "\x00") {
		return "", fmt.Errorf("file_path contains NUL byte")
	}
	for _, r := range filePath {
		if r == unicode.ReplacementChar {
			continue
		}
		if r < 0x20 || r == 0x7f {
			return "", fmt.Errorf("file_path contains control characters")
		}
	}
	for _, part := range strings.Split(filePath, "/") {
		if part == ".." {
			return "", fmt.Errorf("file_path must not contain traversal segments (..)")
		}
	}
	return filePath, nil
}

func truncateUTF8ByBytes(value string, maxBytes int) string {
	if maxBytes <= 0 || len(value) == 0 || len(value) <= maxBytes {
		return value
	}

	var builder strings.Builder
	builder.Grow(maxBytes)
	written := 0
	for _, r := range value {
		runeLen := utf8.RuneLen(r)
		if runeLen <= 0 {
			continue
		}
		if written+runeLen > maxBytes {
			break
		}
		builder.WriteRune(r)
		written += runeLen
	}
	return builder.String()
}

func normalizeNilfsRecordBasename(recordPath, fallbackPath string) string {
	baseName := strings.TrimSpace(recordPath)
	if baseName == "" {
		baseName = filepath.Base(strings.TrimSpace(fallbackPath))
	}
	baseName = strings.ReplaceAll(baseName, "\\", "/")
	if strings.Contains(baseName, "/") {
		parts := strings.Split(baseName, "/")
		for i := len(parts) - 1; i >= 0; i-- {
			part := strings.TrimSpace(parts[i])
			if part != "" {
				baseName = part
				break
			}
		}
	}
	baseName = strings.TrimSpace(baseName)
	if baseName == "" {
		baseName = "file"
	}

	baseName = truncateUTF8ByBytes(baseName, nilfsRecordPathMaxBytes)
	baseName = strings.TrimSpace(baseName)
	if baseName == "" {
		baseName = "file"
	}
	return baseName
}

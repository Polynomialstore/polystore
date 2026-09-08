package main

import (
	"fmt"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

const polyfsRecordPathMaxBytes = 232

func validatePolyfsFilePath(raw string) (string, error) {
	if raw == "" || strings.TrimSpace(raw) != raw {
		return "", fmt.Errorf("file_path is empty or has outer whitespace")
	}
	if !utf8.ValidString(raw) || len(raw) > polyfsRecordPathMaxBytes {
		return "", fmt.Errorf("file_path must be valid UTF-8 of at most %d bytes", polyfsRecordPathMaxBytes)
	}
	if strings.HasPrefix(raw, "/") || strings.Contains(raw, "\\") {
		return "", fmt.Errorf("file_path must be relative with forward slash separators")
	}
	for _, ch := range raw {
		if ch < 0x20 || ch == 0x7f {
			return "", fmt.Errorf("file_path contains control characters")
		}
	}
	for _, part := range strings.Split(raw, "/") {
		if part == ".." {
			return "", fmt.Errorf("file_path must not contain traversal segments (..)")
		}
	}
	return raw, nil
}

// An explicit record path is preserved. Only an absent path takes the basename
// of the local source file; neither case truncates or repairs a filename.
func normalizePolyfsRecordBasename(recordPath, fallbackPath string) (string, error) {
	if recordPath == "" {
		recordPath = filepath.Base(fallbackPath)
	}
	return validatePolyfsFilePath(recordPath)
}

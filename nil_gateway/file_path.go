package main

import (
	"fmt"
	"strings"
	"unicode"
)

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


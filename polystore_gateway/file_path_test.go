package main

import (
	"strings"
	"testing"
)

func TestPolyfsPathsPreserveBytesAndRejectLoss(t *testing.T) {
	for _, path := range []string{"dir/é.txt", "a//./b", "\ufefffile", strings.Repeat("é", 116), strings.Repeat("x", 232)} {
		got, err := validatePolyfsFilePath(path)
		if err != nil || got != path {
			t.Fatalf("changed path %q: %q %v", path, got, err)
		}
		got, err = normalizePolyfsRecordBasename(path, "/tmp/source")
		if err != nil || got != path {
			t.Fatalf("changed explicit path: %q %v", got, err)
		}
	}
	for _, path := range []string{"", " x", "x\u0085", "x\x00y", "/x", "a/../b", "a\\b", string([]byte{255}), strings.Repeat("x", 233)} {
		if _, err := validatePolyfsFilePath(path); err == nil {
			t.Fatalf("accepted %q", path)
		}
	}
	got, err := normalizePolyfsRecordBasename("", "/tmp/source")
	if err != nil || got != "source" {
		t.Fatalf("local source basename: %q %v", got, err)
	}
}

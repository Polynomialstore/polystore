package main

import (
	"testing"
	"time"
)

func TestMode2UploadProfileReleaseClearsState(t *testing.T) {
	profile := newMode2UploadProfile()
	profile.addDuration("body_copy_ms", 12*time.Millisecond)
	profile.setCount("stored_size_bytes", 123)

	releaseMode2UploadProfile(profile)

	reused := newMode2UploadProfile()
	defer releaseMode2UploadProfile(reused)

	ms, counts := reused.snapshots()
	if len(ms) != 0 {
		t.Fatalf("expected cleared duration map, got %v", ms)
	}
	if len(counts) != 0 {
		t.Fatalf("expected cleared count map, got %v", counts)
	}
}

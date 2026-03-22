package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func writeSparseTestFile(t *testing.T, name string, body []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, body, 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}
	return path
}

func TestMode2SparsePayloadLength_TrimsTrailingZeros(t *testing.T) {
	path := writeSparseTestFile(t, "trim.bin", []byte{1, 2, 3, 0, 0, 0})

	full, send, err := mode2SparsePayloadLength(path, 0)
	if err != nil {
		t.Fatalf("mode2SparsePayloadLength returned error: %v", err)
	}
	if full != 6 {
		t.Fatalf("full size mismatch: got=%d want=6", full)
	}
	if send != 3 {
		t.Fatalf("send size mismatch: got=%d want=3", send)
	}
}

func TestMode2SparsePayloadLength_AllZerosKeepsNonEmptyBody(t *testing.T) {
	path := writeSparseTestFile(t, "zeros.bin", make([]byte, 4096))

	full, send, err := mode2SparsePayloadLength(path, 0)
	if err != nil {
		t.Fatalf("mode2SparsePayloadLength returned error: %v", err)
	}
	if full != 4096 {
		t.Fatalf("full size mismatch: got=%d want=4096", full)
	}
	if send != 1 {
		t.Fatalf("send size mismatch: got=%d want=1", send)
	}
}

func TestMode2SparsePayloadLength_RespectsMaxBytes(t *testing.T) {
	path := writeSparseTestFile(t, "limit.bin", make([]byte, 8))

	if _, _, err := mode2SparsePayloadLength(path, 4); err == nil {
		t.Fatal("expected max-bytes error, got nil")
	}
}

func TestMode2SparsePayloadLength_EmptyFile(t *testing.T) {
	path := writeSparseTestFile(t, "empty.bin", nil)

	full, send, err := mode2SparsePayloadLength(path, 0)
	if err != nil {
		t.Fatalf("mode2SparsePayloadLength returned error: %v", err)
	}
	if full != 0 || send != 0 {
		t.Fatalf("expected empty sizes, got full=%d send=%d", full, send)
	}
}

func TestWriteSparseArtifactFile_PreservesLogicalBytes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "artifact.bin")
	payload := []byte{1, 2, 3, 0, 0, 0, 0, 0}

	if err := writeSparseArtifactFile(path, payload, int64(len(payload)), 0o644); err != nil {
		t.Fatalf("writeSparseArtifactFile returned error: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat returned error: %v", err)
	}
	if info.Size() != int64(len(payload)) {
		t.Fatalf("logical size mismatch: got=%d want=%d", info.Size(), len(payload))
	}

	full, send, err := mode2SparsePayloadLength(path, 0)
	if err != nil {
		t.Fatalf("mode2SparsePayloadLength returned error: %v", err)
	}
	if full != int64(len(payload)) {
		t.Fatalf("full size mismatch: got=%d want=%d", full, len(payload))
	}
	if send != 3 {
		t.Fatalf("send size mismatch: got=%d want=3", send)
	}

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile returned error: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("logical payload mismatch: got=%v want=%v", got, payload)
	}
}

func TestWriteSparseArtifactFile_AllZerosKeepsLogicalSize(t *testing.T) {
	path := filepath.Join(t.TempDir(), "zeros.bin")
	payload := make([]byte, 4096)

	if err := writeSparseArtifactFile(path, payload, int64(len(payload)), 0o644); err != nil {
		t.Fatalf("writeSparseArtifactFile returned error: %v", err)
	}

	full, send, err := mode2SparsePayloadLength(path, 0)
	if err != nil {
		t.Fatalf("mode2SparsePayloadLength returned error: %v", err)
	}
	if full != int64(len(payload)) {
		t.Fatalf("full size mismatch: got=%d want=%d", full, len(payload))
	}
	if send != 1 {
		t.Fatalf("send size mismatch: got=%d want=1", send)
	}

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile returned error: %v", err)
	}
	if len(got) != len(payload) {
		t.Fatalf("logical zero payload mismatch: got=%d want=%d", len(got), len(payload))
	}
}

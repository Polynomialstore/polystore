package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestPolyceZstd_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "hello.txt")
	plain := []byte("hello hello hello hello hello hello hello hello\n")
	if err := os.WriteFile(src, plain, 0o644); err != nil {
		t.Fatalf("write src: %v", err)
	}

	res, err := maybeWrapPolyceZstd(context.Background(), src, 100, 32) // low threshold for test
	if err != nil {
		t.Fatalf("wrap: %v", err)
	}
	if res.Encoding != polyceEncodingZstd {
		t.Fatalf("expected zstd encoding, got %d", res.Encoding)
	}
	t.Cleanup(func() { _ = os.Remove(res.Path) })

	wrapped, err := os.ReadFile(res.Path)
	if err != nil {
		t.Fatalf("read wrapped: %v", err)
	}
	out, hdr, ok, err := decodePolyceV1Bytes(wrapped)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !ok {
		t.Fatalf("expected ok header")
	}
	if hdr.Encoding != polyceEncodingZstd {
		t.Fatalf("expected zstd hdr")
	}
	if hdr.UncompressedLen != uint64(len(plain)) {
		t.Fatalf("unexpected uncompressed_len: got %d want %d", hdr.UncompressedLen, len(plain))
	}
	if string(out) != string(plain) {
		t.Fatalf("roundtrip mismatch")
	}
}

func TestPolyceZstd_SkipsIncompressible(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "random.bin")
	// Small incompressible-ish payload.
	plain := make([]byte, 1024)
	seed := uint32(1)
	for i := range plain {
		seed = seed*1103515245 + 12345
		plain[i] = byte(seed >> 24)
	}
	if err := os.WriteFile(src, plain, 0o644); err != nil {
		t.Fatalf("write src: %v", err)
	}

	res, err := maybeWrapPolyceZstd(context.Background(), src, 500, 1024)
	if err != nil {
		t.Fatalf("wrap: %v", err)
	}
	if res.Path != src {
		t.Fatalf("expected no wrapping for incompressible input")
	}
	if res.Encoding != polyceEncodingNone {
		t.Fatalf("expected NONE encoding")
	}
}

package main

import (
	"context"
	"crypto/sha256"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"polystorechain/pkg/retrievalchallenge"
)

func writeIntegrityLeavesFixtureV3(t *testing.T, dir string, count uint64) ([][32]byte, retrievalGenerationKey) {
	t.Helper()
	leaves := make([][32]byte, count)
	wire := make([]byte, count*32)
	for i := range leaves {
		leaves[i] = sha256.Sum256([]byte{byte(i), byte(i >> 8), byte(i >> 16)})
		copy(wire[i*32:], leaves[i][:])
	}
	if err := os.WriteFile(filepath.Join(dir, integrityLeavesV3File), wire, 0600); err != nil {
		t.Fatal(err)
	}
	root, err := retrievalchallenge.IntegrityRootV3(leaves)
	if err != nil {
		t.Fatal(err)
	}
	return leaves, retrievalGenerationKey{Users: count / retrievalchallenge.IntegrityLeavesPerUserMDU, Integrity: root}
}

func TestIntegrityIndexV3BuildsCanonicalPathsAndRejectsCorruption(t *testing.T) {
	dir := t.TempDir()
	leaves, key := writeIntegrityLeavesFixtureV3(t, dir, retrievalchallenge.IntegrityLeavesPerUserMDU)
	index, err := ensureIntegrityIndexV3(t.Context(), dir, key)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateIntegrityIndexV3(index, uint64(len(leaves))); err != nil {
		t.Fatal(err)
	}
	for position, leaf := range leaves {
		path, err := readIntegrityPathV3(index, filepath.Join(dir, integrityLeavesV3File), uint64(position), uint64(len(leaves)))
		if err != nil || !retrievalchallenge.VerifyIntegrityPathV3(leaf, uint64(position), uint64(len(leaves)), path, key.Integrity) {
			t.Fatalf("position %d has invalid canonical path: %v", position, err)
		}
	}
	f, err := os.OpenFile(index, os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteAt([]byte{0xff}, int64(integrityIndexV3HeaderBytes+32)); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	path, err := readIntegrityPathV3(index, filepath.Join(dir, integrityLeavesV3File), 0, uint64(len(leaves)))
	if err != nil {
		t.Fatal(err)
	}
	if retrievalchallenge.VerifyIntegrityPathV3(leaves[0], 0, uint64(len(leaves)), path, key.Integrity) {
		t.Fatal("accepted a path through a corrupted derived index")
	}
}

func TestIntegrityIndexV3CancellationLeavesNoPublishedArtifact(t *testing.T) {
	dir := t.TempDir()
	_, key := writeIntegrityLeavesFixtureV3(t, dir, retrievalchallenge.IntegrityLeavesPerUserMDU)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := ensureIntegrityIndexV3(ctx, dir, key); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancellation, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, integrityIndexV3File)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("canceled build published an index: %v", err)
	}
	matches, err := filepath.Glob(filepath.Join(dir, ".integrity-index-v3-*"))
	if err != nil || len(matches) != 0 {
		t.Fatalf("canceled build retained temporary files: %v %v", matches, err)
	}
}

func TestIntegrityIndexV3RejectsWrongRootAndMalformedIndex(t *testing.T) {
	dir := t.TempDir()
	_, key := writeIntegrityLeavesFixtureV3(t, dir, retrievalchallenge.IntegrityLeavesPerUserMDU)
	wrong := key
	wrong.Integrity[0] ^= 1
	if _, err := ensureIntegrityIndexV3(t.Context(), dir, wrong); err == nil {
		t.Fatal("built an index for a mismatched authenticated root")
	}
	if err := os.WriteFile(filepath.Join(dir, integrityIndexV3File), make([]byte, 16), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := ensureIntegrityIndexV3(t.Context(), dir, key); err == nil {
		t.Fatal("replaced a malformed existing index")
	}
}

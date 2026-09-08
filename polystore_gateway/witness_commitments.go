package main

import (
	"fmt"
	"io"
)

func readWitnessCommitmentsForUserMdu(dealDir string, userOrdinal uint64, commitmentSpan uint64) ([]byte, error) {
	if commitmentSpan == 0 || commitmentSpan%48 != 0 || commitmentSpan > 16384*48 {
		return nil, fmt.Errorf("invalid witness commitment span %d", commitmentSpan)
	}
	meta, err := loadSlabIndex(dealDir)
	if err != nil {
		return nil, fmt.Errorf("load witness layout: %w", err)
	}
	if meta.userCount == 0 || meta.userCount > 65536 || userOrdinal >= meta.userCount {
		return nil, fmt.Errorf("user mdu ordinal %d out of range (user_mdus=%d)", userOrdinal, meta.userCount)
	}
	// A requested prefix is not the complete packed payload: only the actual
	// final scalar is right-aligned. This also applies without slab_meta.json.
	startOffset := userOrdinal * commitmentSpan
	totalWitnessLen := meta.userCount * commitmentSpan
	if meta.witnessCount > 65536 || totalWitnessLen > meta.witnessCount*RawMduCapacity {
		return nil, fmt.Errorf("witness payload exceeds metadata MDUs")
	}

	reader, err := newPolyfsDecodedReader(dealDir, 1, 0, totalWitnessLen, startOffset, commitmentSpan)
	if err != nil {
		return nil, err
	}
	witnessRaw, err := io.ReadAll(reader)
	_ = reader.Close()
	if err != nil {
		return nil, err
	}
	if uint64(len(witnessRaw)) != commitmentSpan {
		return nil, fmt.Errorf("invalid witness commitments length: got %d want %d", len(witnessRaw), commitmentSpan)
	}
	return witnessRaw, nil
}

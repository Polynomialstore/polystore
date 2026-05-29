package main

import (
	"fmt"
	"io"
)

func readWitnessCommitmentsForUserMdu(dealDir string, userOrdinal uint64, commitmentSpan uint64) ([]byte, error) {
	if commitmentSpan == 0 {
		return nil, fmt.Errorf("commitment span must be > 0")
	}
	startOffset := userOrdinal * commitmentSpan
	totalWitnessLen := commitmentSpan
	if meta, err := readSlabMetadataFile(dealDir); err == nil && meta.UserMdus > 0 {
		if userOrdinal >= meta.UserMdus {
			return nil, fmt.Errorf("user mdu ordinal %d out of range (user_mdus=%d)", userOrdinal, meta.UserMdus)
		}
		totalWitnessLen = meta.UserMdus * commitmentSpan
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

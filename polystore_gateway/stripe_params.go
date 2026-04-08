package main

import (
	"fmt"

	"nilchain/x/nilchain/types"
)

type stripeParams struct {
	mode      uint32
	k         uint64
	m         uint64
	rows      uint64
	leafCount uint64
	slotCount uint64
}

func stripeParamsFromHint(serviceHint string) (stripeParams, error) {
	parsed, err := types.ParseServiceHint(serviceHint)
	if err != nil {
		return stripeParams{}, err
	}
	rs, ok, err := types.RSParamsFromHint(parsed)
	if err != nil {
		return stripeParams{}, err
	}
	if !ok {
		return stripeParams{
			mode:      1,
			leafCount: types.BLOBS_PER_MDU,
		}, nil
	}
	return stripeParams{
		mode:      2,
		k:         rs.K,
		m:         rs.M,
		rows:      rs.Rows,
		leafCount: rs.LeafCount,
		slotCount: rs.K + rs.M,
	}, nil
}

func leafIndexForBlobIndex(blobIndex uint32, params stripeParams) (uint64, error) {
	if params.mode != 2 {
		return uint64(blobIndex), nil
	}
	if params.k == 0 || params.rows == 0 {
		return 0, fmt.Errorf("invalid stripe params")
	}
	row := uint64(blobIndex) / params.k
	col := uint64(blobIndex) % params.k
	return col*params.rows + row, nil
}

func slotForLeafIndex(leafIndex uint64, params stripeParams) (uint64, error) {
	if params.mode != 2 {
		return 0, nil
	}
	if params.rows == 0 {
		return 0, fmt.Errorf("invalid stripe params")
	}
	return leafIndex / params.rows, nil
}

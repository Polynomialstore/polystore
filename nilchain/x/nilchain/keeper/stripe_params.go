package keeper

import (
	"fmt"
	"strings"

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

func stripeParamsForDeal(deal types.Deal) (stripeParams, error) {
	parsed, err := types.ParseServiceHint(deal.ServiceHint)
	if err != nil {
		return stripeParams{}, err
	}
	params := stripeParams{
		mode:      1,
		k:         0,
		m:         0,
		rows:      0,
		leafCount: types.BlobsPerMdu,
		slotCount: 0,
	}
	rs, ok, err := types.RSParamsFromHint(parsed)
	if err != nil {
		return stripeParams{}, err
	}
	if !ok {
		return params, nil
	}

	params.mode = 2
	params.k = rs.K
	params.m = rs.M
	params.rows = rs.Rows
	params.leafCount = rs.LeafCount
	params.slotCount = rs.K + rs.M
	return params, nil
}

func providerSlotIndex(deal types.Deal, provider string) (uint64, bool) {
	target := strings.TrimSpace(provider)
	if target == "" {
		return 0, false
	}
	for i, p := range deal.Providers {
		if strings.TrimSpace(p) == target {
			return uint64(i), true
		}
	}
	return 0, false
}

func leafSlotIndex(leafIndex uint64, rows uint64) (uint64, error) {
	if rows == 0 {
		return 0, fmt.Errorf("rows must be > 0")
	}
	return leafIndex / rows, nil
}

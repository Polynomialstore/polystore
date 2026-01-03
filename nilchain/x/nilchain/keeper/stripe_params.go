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
	params := stripeParams{
		mode:      1,
		k:         0,
		m:         0,
		rows:      0,
		leafCount: types.BlobsPerMdu,
		slotCount: 0,
	}

	if deal.RedundancyMode == 2 && deal.Mode2Profile != nil && deal.Mode2Profile.K > 0 && deal.Mode2Profile.M > 0 {
		k := uint64(deal.Mode2Profile.K)
		m := uint64(deal.Mode2Profile.M)
		if k == 0 || m == 0 {
			return stripeParams{}, fmt.Errorf("invalid mode2_profile (K and M must be > 0)")
		}
		if 64%k != 0 {
			return stripeParams{}, fmt.Errorf("invalid mode2_profile (K must divide 64)")
		}
		rows := uint64(64) / k
		params.mode = 2
		params.k = k
		params.m = m
		params.rows = rows
		params.leafCount = (k + m) * rows
		params.slotCount = k + m
		return params, nil
	}

	parsed, err := types.ParseServiceHint(deal.ServiceHint)
	if err != nil {
		return stripeParams{}, err
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
	if deal.RedundancyMode == 2 && deal.Mode2Profile != nil && len(deal.Mode2Slots) > 0 {
		for _, slot := range deal.Mode2Slots {
			if slot == nil {
				continue
			}
			if strings.TrimSpace(slot.Provider) == target {
				return uint64(slot.Slot), true
			}
		}
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

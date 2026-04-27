package keeper

import (
	"fmt"
	"strings"

	sdk "github.com/cosmos/cosmos-sdk/types"

	"polystorechain/x/polystorechain/types"
)

const (
	minMode2Slots = uint64(3) // require >2 so repairs can exist
)

func normalizeServiceHintBase(base string) string {
	b := strings.TrimSpace(base)
	if b == "" {
		return "General"
	}
	return b
}

func providerMatchesBaseHint(provider types.Provider, baseHint string) bool {
	switch normalizeServiceHintBase(baseHint) {
	case "Hot":
		return provider.Capabilities == "General" || provider.Capabilities == "Edge"
	case "Cold":
		return provider.Capabilities == "Archive" || provider.Capabilities == "General"
	default:
		return true
	}
}

func preferProvidersForServiceHint(candidates []types.Provider, baseHint string, count uint64) []types.Provider {
	if normalizeServiceHintBase(baseHint) != "Hot" {
		return candidates
	}

	edgeProviders := make([]types.Provider, 0, len(candidates))
	for _, provider := range candidates {
		if provider.Capabilities == "Edge" {
			edgeProviders = append(edgeProviders, provider)
		}
	}
	if uint64(len(edgeProviders)) >= count {
		return edgeProviders
	}

	return candidates
}

func autoSelectMode2Profile(eligibleProviders uint64) (k uint64, m uint64, err error) {
	if eligibleProviders < minMode2Slots {
		return 0, 0, fmt.Errorf("not enough eligible providers for Mode 2 (need >= %d, got %d)", minMode2Slots, eligibleProviders)
	}

	available := eligibleProviders
	maxSlots := uint64(types.DealBaseReplication)
	if available > maxSlots {
		available = maxSlots
	}

	// Balanced default: prefer 8+4 when possible; otherwise choose the largest profile
	// that fits the available provider set.
	switch {
	case available >= 12:
		return 8, 4, nil
	case available >= 9:
		return 8, available - 8, nil
	case available >= 5:
		return 4, available - 4, nil
	default:
		// available is 3 or 4
		return 2, available - 2, nil
	}
}

func (k Keeper) eligibleProviderCountForBaseHint(ctx sdk.Context, baseHint string) (uint64, error) {
	serviceHint := normalizeServiceHintBase(baseHint)

	var count uint64
	if err := k.Providers.Walk(ctx, nil, func(_ string, provider types.Provider) (stop bool, err error) {
		if strings.TrimSpace(provider.Status) != "Active" {
			return false, nil
		}
		if provider.Draining {
			return false, nil
		}
		reason, err := k.providerHealthPlacementIneligibility(ctx, provider)
		if err != nil {
			return false, err
		}
		if reason != "" {
			return false, nil
		}
		if providerMatchesBaseHint(provider, serviceHint) {
			count++
		}
		return false, nil
	}); err != nil {
		return 0, err
	}
	return count, nil
}

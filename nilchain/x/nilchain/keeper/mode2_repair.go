package keeper

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"strings"

	sdk "github.com/cosmos/cosmos-sdk/types"

	"nilchain/x/nilchain/types"
)

func providerMatchesServiceHint(provider types.Provider, serviceHint string) bool {
	info, err := types.ParseServiceHint(serviceHint)
	base := strings.TrimSpace(serviceHint)
	if err == nil && strings.TrimSpace(info.Base) != "" {
		base = info.Base
	}
	base = strings.ToLower(strings.TrimSpace(base))

	switch base {
	case "hot":
		return provider.Capabilities == "General" || provider.Capabilities == "Edge"
	case "cold":
		return provider.Capabilities == "Archive" || provider.Capabilities == "General"
	default:
		return true
	}
}

func (k Keeper) selectMode2ReplacementProvider(ctx sdk.Context, deal types.Deal, slot uint32, epochID uint64) (string, error) {
	if len(deal.Mode2Slots) == 0 {
		return "", fmt.Errorf("mode2 slot map is empty")
	}

	outgoing := ""
	if int(slot) >= 0 && int(slot) < len(deal.Mode2Slots) {
		if s := deal.Mode2Slots[int(slot)]; s != nil {
			outgoing = strings.TrimSpace(s.Provider)
		}
	}

	exclude := make(map[string]struct{}, len(deal.Mode2Slots)*2)
	for _, s := range deal.Mode2Slots {
		if s == nil {
			continue
		}
		if addr := strings.TrimSpace(s.Provider); addr != "" {
			exclude[addr] = struct{}{}
		}
		if addr := strings.TrimSpace(s.PendingProvider); addr != "" {
			exclude[addr] = struct{}{}
		}
	}

	candidates := make([]string, 0, 8)
	if err := k.Providers.Walk(ctx, nil, func(addr string, provider types.Provider) (stop bool, err error) {
		if strings.TrimSpace(provider.Status) != "Active" {
			return false, nil
		}
		if provider.Draining {
			return false, nil
		}
		if !providerMatchesServiceHint(provider, deal.ServiceHint) {
			return false, nil
		}
		if _, blocked := exclude[strings.TrimSpace(provider.Address)]; blocked {
			return false, nil
		}
		candidates = append(candidates, provider.Address)
		return false, nil
	}); err != nil {
		return "", err
	}

	// Devnet/PoC fallback: when the network has exactly N=K+M providers and the deal
	// uses all of them, there may be no "unused" candidates to select from. In this
	// case, deterministically reuse another active provider (excluding the outgoing
	// one) so repairs remain possible without requiring extra providers.
	if len(candidates) == 0 {
		if err := k.Providers.Walk(ctx, nil, func(addr string, provider types.Provider) (stop bool, err error) {
			if strings.TrimSpace(provider.Status) != "Active" {
				return false, nil
			}
			if provider.Draining {
				return false, nil
			}
			if !providerMatchesServiceHint(provider, deal.ServiceHint) {
				return false, nil
			}
			cand := strings.TrimSpace(provider.Address)
			if cand == "" || cand == outgoing {
				return false, nil
			}
			candidates = append(candidates, cand)
			return false, nil
		}); err != nil {
			return "", err
		}
		if len(candidates) == 0 {
			return "", fmt.Errorf("no replacement provider candidates available")
		}
	}

	seed := k.getEpochSeed(ctx, epochID)
	buf := make([]byte, 0, 32+8+4+8)
	buf = append(buf, seed[:]...)
	buf = append(buf, sdk.Uint64ToBigEndian(deal.Id)...)
	var slotBytes [4]byte
	binary.BigEndian.PutUint32(slotBytes[:], slot)
	buf = append(buf, slotBytes[:]...)
	buf = append(buf, sdk.Uint64ToBigEndian(deal.CurrentGen)...)
	sum := sha256.Sum256(buf)

	idx := int(binary.BigEndian.Uint64(sum[:8]) % uint64(len(candidates)))
	return candidates[idx], nil
}

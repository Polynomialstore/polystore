package keeper

import (
	"strings"
	"unicode"

	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"
	ma "github.com/multiformats/go-multiaddr"
)

const maxProviderEndpoints = 8
const maxPairingIDLen = 128

func canonicalAddress(raw string, field string) (string, error) {
	if strings.TrimSpace(raw) == "" {
		return "", sdkerrors.ErrInvalidRequest.Wrapf("%s is required", field)
	}
	addr, err := sdk.AccAddressFromBech32(raw)
	if err != nil {
		return "", sdkerrors.ErrInvalidAddress.Wrapf("invalid %s address: %s", field, err)
	}
	return addr.String(), nil
}

func requireCanonicalAddress(raw string, field string) (string, error) {
	canonical, err := canonicalAddress(raw, field)
	if err != nil {
		return "", err
	}
	if raw != canonical {
		return "", sdkerrors.ErrInvalidRequest.Wrapf("%s must use canonical address string %q", field, canonical)
	}
	return canonical, nil
}

func canonicalProviderAddress(raw string) (string, error) {
	return canonicalAddress(raw, "creator")
}

func requireCanonicalProviderCreator(raw string) (string, error) {
	return requireCanonicalAddress(raw, "creator")
}

func validatePairingID(raw string) (string, error) {
	pairingID := strings.TrimSpace(raw)
	if pairingID == "" {
		return "", sdkerrors.ErrInvalidRequest.Wrap("pairing_id is required")
	}
	if len(pairingID) > maxPairingIDLen {
		return "", sdkerrors.ErrInvalidRequest.Wrapf("pairing_id too long (max %d)", maxPairingIDLen)
	}
	if strings.IndexFunc(pairingID, func(r rune) bool { return unicode.IsSpace(r) || r < 0x20 }) != -1 {
		return "", sdkerrors.ErrInvalidRequest.Wrap("pairing_id contains whitespace/control characters")
	}
	return pairingID, nil
}

func validateAndCanonicalizeProviderEndpoints(rawEndpoints []string) ([]string, error) {
	if len(rawEndpoints) == 0 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("endpoints is required (at least one Multiaddr)")
	}
	if len(rawEndpoints) > maxProviderEndpoints {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("too many endpoints (max %d)", maxProviderEndpoints)
	}

	endpoints := make([]string, 0, len(rawEndpoints))
	seenEndpoints := make(map[string]struct{}, len(rawEndpoints))
	hasHTTP := false
	for _, raw := range rawEndpoints {
		ep := strings.TrimSpace(raw)
		if ep == "" {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("endpoint must be non-empty")
		}
		if len(ep) > 256 {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("endpoint too long")
		}
		if !strings.HasPrefix(ep, "/") {
			return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid endpoint multiaddr: %q", ep)
		}
		if strings.IndexFunc(ep, func(r rune) bool { return unicode.IsSpace(r) || r < 0x20 }) != -1 {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("endpoint contains whitespace/control characters")
		}
		parsed, err := ma.NewMultiaddr(ep)
		if err != nil {
			return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid endpoint multiaddr: %q", ep)
		}
		for _, proto := range parsed.Protocols() {
			if proto.Code == ma.P_HTTP || proto.Code == ma.P_HTTPS {
				hasHTTP = true
			}
		}
		canonical := parsed.String()
		if _, ok := seenEndpoints[canonical]; ok {
			continue
		}
		seenEndpoints[canonical] = struct{}{}
		endpoints = append(endpoints, canonical)
	}
	if !hasHTTP {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("at least one HTTP or HTTPS endpoint is required")
	}
	return endpoints, nil
}

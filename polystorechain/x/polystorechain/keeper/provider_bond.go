package keeper

import (
	"fmt"
	"strings"

	"cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"

	"polystorechain/x/polystorechain/types"
)

const providerUnderbondedReason = "provider_underbonded"

func normalizeCoinAmount(coin sdk.Coin) sdk.Coin {
	if coin.Amount.IsNil() {
		coin.Amount = math.ZeroInt()
	}
	return coin
}

func normalizeMinProviderBond(params types.Params) (sdk.Coin, error) {
	min := normalizeCoinAmount(params.MinProviderBond)
	if strings.TrimSpace(min.Denom) == "" {
		min.Denom = sdk.DefaultBondDenom
	}
	if min.Amount.IsNegative() {
		return sdk.Coin{}, fmt.Errorf("min_provider_bond cannot be negative: %s", min)
	}
	if !min.IsValid() {
		return sdk.Coin{}, fmt.Errorf("invalid min_provider_bond: %s", min)
	}
	return min, nil
}

func normalizeRegistrationBond(bond sdk.Coin, params types.Params) (sdk.Coin, error) {
	min, err := normalizeMinProviderBond(params)
	if err != nil {
		return sdk.Coin{}, err
	}

	bond = normalizeCoinAmount(bond)
	bond.Denom = strings.TrimSpace(bond.Denom)
	if bond.Denom == "" {
		bond.Denom = min.Denom
	}
	if bond.Amount.IsNegative() {
		return sdk.Coin{}, fmt.Errorf("provider bond cannot be negative: %s", bond)
	}
	if !bond.IsValid() {
		return sdk.Coin{}, fmt.Errorf("invalid provider bond: %s", bond)
	}
	if bond.Amount.IsPositive() && bond.Denom != min.Denom {
		return sdk.Coin{}, fmt.Errorf("provider bond denom must be %q (got %q)", min.Denom, bond.Denom)
	}
	if min.Amount.IsPositive() {
		if bond.Denom != min.Denom {
			return sdk.Coin{}, fmt.Errorf("provider bond denom must be %q (got %q)", min.Denom, bond.Denom)
		}
		if bond.Amount.LT(min.Amount) {
			return sdk.Coin{}, fmt.Errorf("provider bond %s is below minimum %s", bond, min)
		}
	}
	return bond, nil
}

func zeroBondLike(denom string) sdk.Coin {
	denom = strings.TrimSpace(denom)
	if denom == "" {
		denom = sdk.DefaultBondDenom
	}
	return sdk.NewCoin(denom, math.ZeroInt())
}

func addBondCoins(a sdk.Coin, b sdk.Coin) sdk.Coin {
	a = normalizeCoinAmount(a)
	b = normalizeCoinAmount(b)
	if strings.TrimSpace(a.Denom) == "" {
		a.Denom = b.Denom
	}
	if strings.TrimSpace(a.Denom) == "" {
		a.Denom = sdk.DefaultBondDenom
	}
	if strings.TrimSpace(b.Denom) == "" {
		b.Denom = a.Denom
	}
	if a.Denom != b.Denom {
		return a
	}
	return sdk.NewCoin(a.Denom, a.Amount.Add(b.Amount))
}

func providerBondPlacementIneligibility(provider types.Provider, params types.Params) string {
	min, err := normalizeMinProviderBond(params)
	if err != nil {
		return fmt.Sprintf("provider bond policy is invalid: %s", err)
	}
	if !min.Amount.IsPositive() {
		return ""
	}

	bond := normalizeCoinAmount(provider.Bond)
	if strings.TrimSpace(bond.Denom) == "" {
		return fmt.Sprintf("provider bond is below minimum %s", min)
	}
	if bond.Denom != min.Denom {
		return fmt.Sprintf("provider bond denom %q does not match required denom %q", bond.Denom, min.Denom)
	}
	if bond.Amount.LT(min.Amount) {
		return fmt.Sprintf("provider bond %s is below minimum %s", bond, min)
	}
	return ""
}

func providerBondSlashAmount(bond sdk.Coin, slashBps uint64) sdk.Coin {
	bond = normalizeCoinAmount(bond)
	if strings.TrimSpace(bond.Denom) == "" {
		bond.Denom = sdk.DefaultBondDenom
	}
	if slashBps == 0 || !bond.Amount.IsPositive() {
		return zeroBondLike(bond.Denom)
	}
	slashInt := bond.Amount.Mul(math.NewIntFromUint64(slashBps)).Add(math.NewInt(9999)).Quo(math.NewInt(10000))
	if slashInt.IsZero() {
		slashInt = math.NewInt(1)
	}
	if slashInt.GT(bond.Amount) {
		slashInt = bond.Amount
	}
	return sdk.NewCoin(bond.Denom, slashInt)
}

func overlayProviderBondHealth(health types.ProviderHealthState, provider types.Provider, params types.Params, height int64) types.ProviderHealthState {
	reason := providerBondPlacementIneligibility(provider, params)
	if reason == "" {
		return health
	}
	if isAdministrativeProviderLifecycle(health.LifecycleStatus) {
		return health
	}

	health.Provider = strings.TrimSpace(provider.Address)
	health.LifecycleStatus = types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_DELINQUENT
	health.Reason = providerUnderbondedReason
	health.EvidenceClass = types.EvidenceClass_EVIDENCE_CLASS_OPERATIONAL
	health.Severity = types.EvidenceSeverity_EVIDENCE_SEVERITY_DELINQUENT
	health.UpdatedHeight = height
	health.ConsequenceCeiling = reason
	return health
}

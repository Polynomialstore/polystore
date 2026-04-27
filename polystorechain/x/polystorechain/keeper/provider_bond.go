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

func normalizeAssignmentCollateralPerSlot(params types.Params) (sdk.Coin, error) {
	perSlot := normalizeCoinAmount(params.AssignmentCollateralPerSlot)
	if strings.TrimSpace(perSlot.Denom) == "" {
		perSlot.Denom = sdk.DefaultBondDenom
	}
	if perSlot.Amount.IsNegative() {
		return sdk.Coin{}, fmt.Errorf("assignment_collateral_per_slot cannot be negative: %s", perSlot)
	}
	if !perSlot.IsValid() {
		return sdk.Coin{}, fmt.Errorf("invalid assignment_collateral_per_slot: %s", perSlot)
	}
	return perSlot, nil
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
	return providerBondPlacementIneligibilityForAssignments(provider, params, 0)
}

func providerBondPlacementIneligibilityForAssignments(provider types.Provider, params types.Params, assignments uint64) string {
	required, err := providerBondRequirementForAssignments(params, assignments)
	if err != nil {
		return fmt.Sprintf("provider bond policy is invalid: %s", err)
	}
	return providerBondRequirementIneligibility(provider, required, assignments)
}

func providerBondRequirementForAssignments(params types.Params, assignments uint64) (sdk.Coin, error) {
	min, err := normalizeMinProviderBond(params)
	if err != nil {
		return sdk.Coin{}, err
	}
	perSlot, err := normalizeAssignmentCollateralPerSlot(params)
	if err != nil {
		return sdk.Coin{}, err
	}
	if perSlot.Amount.IsPositive() && perSlot.Denom != min.Denom {
		return sdk.Coin{}, fmt.Errorf("assignment_collateral_per_slot denom %q does not match min_provider_bond denom %q", perSlot.Denom, min.Denom)
	}

	required := min
	if perSlot.Amount.IsPositive() && assignments > 0 {
		required = sdk.NewCoin(required.Denom, required.Amount.Add(perSlot.Amount.Mul(math.NewIntFromUint64(assignments))))
	}
	return required, nil
}

func providerBondRequirementIneligibility(provider types.Provider, required sdk.Coin, assignments uint64) string {
	if !required.Amount.IsPositive() {
		return ""
	}

	bond := normalizeCoinAmount(provider.Bond)
	if strings.TrimSpace(bond.Denom) == "" {
		if assignments == 0 {
			return fmt.Sprintf("provider bond is below minimum %s", required)
		}
		return fmt.Sprintf("provider bond is below required collateral %s for %d assignments", required, assignments)
	}
	if bond.Denom != required.Denom {
		return fmt.Sprintf("provider bond denom %q does not match required denom %q", bond.Denom, required.Denom)
	}
	if bond.Amount.LT(required.Amount) {
		if assignments == 0 {
			return fmt.Sprintf("provider bond %s is below minimum %s", bond, required)
		}
		return fmt.Sprintf("provider bond %s is below required collateral %s for %d assignments", bond, required, assignments)
	}
	return ""
}

func providerBondAffordableAssignments(provider types.Provider, params types.Params) (uint64, string, error) {
	min, err := normalizeMinProviderBond(params)
	if err != nil {
		return 0, "", err
	}
	perSlot, err := normalizeAssignmentCollateralPerSlot(params)
	if err != nil {
		return 0, "", err
	}
	if perSlot.Amount.IsPositive() && perSlot.Denom != min.Denom {
		return 0, "", fmt.Errorf("assignment_collateral_per_slot denom %q does not match min_provider_bond denom %q", perSlot.Denom, min.Denom)
	}

	bond := normalizeCoinAmount(provider.Bond)
	if strings.TrimSpace(bond.Denom) == "" {
		if min.Amount.IsPositive() || perSlot.Amount.IsPositive() {
			switch {
			case min.Amount.IsPositive() && perSlot.Amount.IsPositive():
				return 0, fmt.Sprintf("provider bond denom/amount is unset; requires minimum %s and assignment collateral per slot %s", min, perSlot), nil
			case perSlot.Amount.IsPositive():
				return 0, fmt.Sprintf("provider bond denom/amount is unset; requires assignment collateral per slot %s", perSlot), nil
			default:
				return 0, fmt.Sprintf("provider bond denom/amount is unset; requires minimum collateral %s", min), nil
			}
		}
		bond.Denom = min.Denom
	}
	if (min.Amount.IsPositive() || perSlot.Amount.IsPositive()) && bond.Denom != min.Denom {
		return 0, fmt.Sprintf("provider bond denom %q does not match required denom %q", bond.Denom, min.Denom), nil
	}
	if bond.Amount.LT(min.Amount) {
		return 0, fmt.Sprintf("provider bond %s is below minimum %s", bond, min), nil
	}
	if !perSlot.Amount.IsPositive() {
		return ^uint64(0), "", nil
	}
	headroom := bond.Amount.Sub(min.Amount)
	affordable := headroom.Quo(perSlot.Amount)
	maxUint64 := math.NewIntFromUint64(^uint64(0))
	if affordable.GT(maxUint64) {
		return ^uint64(0), "", nil
	}
	return affordable.Uint64(), "", nil
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

func overlayProviderBondHealth(health types.ProviderHealthState, provider types.Provider, params types.Params, height int64, assignments uint64) types.ProviderHealthState {
	reason := providerBondPlacementIneligibilityForAssignments(provider, params, assignments)
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

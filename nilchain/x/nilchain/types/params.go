package types

import (
	paramtypes "github.com/cosmos/cosmos-sdk/x/params/types"
)

var _ paramtypes.ParamSet = (*Params)(nil)

var (
    KeyBaseStripeCost = []byte("BaseStripeCost")
    KeyHalvingInterval = []byte("HalvingInterval")
)

// ParamKeyTable the param key table for launch module
func ParamKeyTable() paramtypes.KeyTable {
	return paramtypes.NewKeyTable().RegisterParamSet(&Params{})
}

// NewParams creates a new Params instance.
func NewParams(
    baseStripeCost uint64,
    halvingInterval uint64,
) Params {
	return Params{
        BaseStripeCost: baseStripeCost,
        HalvingInterval: halvingInterval,
	}
}

// DefaultParams returns a default set of parameters.
func DefaultParams() Params {
	return NewParams(
        10, // BaseStripeCost
        1000, // HalvingInterval
	)
}

// ParamSetPairs get the params.ParamSet
func (p *Params) ParamSetPairs() paramtypes.ParamSetPairs {
	return paramtypes.ParamSetPairs{
        paramtypes.NewParamSetPair(KeyBaseStripeCost, &p.BaseStripeCost, validateBaseStripeCost),
        paramtypes.NewParamSetPair(KeyHalvingInterval, &p.HalvingInterval, validateHalvingInterval),
    }
}

// Validate validates the set of params.
func (p Params) Validate() error {
    if err := validateBaseStripeCost(p.BaseStripeCost); err != nil {
        return err
    }
    if err := validateHalvingInterval(p.HalvingInterval); err != nil {
        return err
    }
	return nil
}

func validateBaseStripeCost(i interface{}) error {
    // TODO: Implement validation
    return nil
}

func validateHalvingInterval(i interface{}) error {
    // TODO: Implement validation
    return nil
}



package types

import (
	"fmt"
	"strings"

	"cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	paramtypes "github.com/cosmos/cosmos-sdk/x/params/types"
)

var _ paramtypes.ParamSet = (*Params)(nil)

var (
	KeyBaseStripeCost    = []byte("BaseStripeCost")
	KeyHalvingInterval   = []byte("HalvingInterval")
	KeyEip712ChainID     = []byte("Eip712ChainId")
	KeyStoragePrice      = []byte("StoragePrice")
	KeyDealCreationFee   = []byte("DealCreationFee")
	KeyMinDurationBlocks = []byte("MinDurationBlocks")
)

// ParamKeyTable the param key table for launch module
func ParamKeyTable() paramtypes.KeyTable {
	return paramtypes.NewKeyTable().RegisterParamSet(&Params{})
}

// NewParams creates a new Params instance.
func NewParams(
	baseStripeCost uint64,
	halvingInterval uint64,
	eip712ChainID uint64,
	storagePrice math.LegacyDec,
	dealCreationFee sdk.Coin,
	minDurationBlocks uint64,
) Params {
	return Params{
		BaseStripeCost:    baseStripeCost,
		HalvingInterval:   halvingInterval,
		Eip712ChainId:     eip712ChainID,
		StoragePrice:      storagePrice,
		DealCreationFee:   dealCreationFee,
		MinDurationBlocks: minDurationBlocks,
	}
}

// DefaultParams returns a default set of parameters.
func DefaultParams() Params {
	return NewParams(
		10,    // BaseStripeCost
		1000,  // HalvingInterval
		31337, // EIP712ChainId (MetaMask localhost default)
		math.LegacyNewDec(0), // StoragePrice
		sdk.NewCoin(sdk.DefaultBondDenom, math.NewInt(0)), // DealCreationFee
		10, // MinDurationBlocks
	)
}

// ParamSetPairs get the params.ParamSet
func (p *Params) ParamSetPairs() paramtypes.ParamSetPairs {
	return paramtypes.ParamSetPairs{
		paramtypes.NewParamSetPair(KeyBaseStripeCost, &p.BaseStripeCost, validateBaseStripeCost),
		paramtypes.NewParamSetPair(KeyHalvingInterval, &p.HalvingInterval, validateHalvingInterval),
		paramtypes.NewParamSetPair(KeyEip712ChainID, &p.Eip712ChainId, validateEip712ChainID),
		paramtypes.NewParamSetPair(KeyStoragePrice, &p.StoragePrice, validateStoragePrice),
		paramtypes.NewParamSetPair(KeyDealCreationFee, &p.DealCreationFee, validateDealCreationFee),
		paramtypes.NewParamSetPair(KeyMinDurationBlocks, &p.MinDurationBlocks, validateMinDurationBlocks),
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
	if err := validateEip712ChainID(p.Eip712ChainId); err != nil {
		return err
	}
	if err := validateStoragePrice(p.StoragePrice); err != nil {
		return err
	}
	if err := validateDealCreationFee(p.DealCreationFee); err != nil {
		return err
	}
	if err := validateMinDurationBlocks(p.MinDurationBlocks); err != nil {
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

func validateEip712ChainID(i interface{}) error {
	v, ok := i.(uint64)
	if !ok {
		return fmt.Errorf("invalid parameter type: %T", i)
	}
	if v == 0 {
		return fmt.Errorf("eip712_chain_id must be non-zero")
	}
	return nil
}

func validateStoragePrice(i interface{}) error {
	v, ok := i.(math.LegacyDec)
	if !ok {
		return fmt.Errorf("invalid parameter type: %T", i)
	}
	if v.IsNegative() {
		return fmt.Errorf("storage price cannot be negative: %s", v)
	}
	return nil
}

func validateDealCreationFee(i interface{}) error {
	v, ok := i.(sdk.Coin)
	if !ok {
		return fmt.Errorf("invalid parameter type: %T", i)
	}
	if !v.IsValid() {
		return fmt.Errorf("invalid deal creation fee: %s", v)
	}
	if strings.TrimSpace(v.Denom) != strings.TrimSpace(sdk.DefaultBondDenom) {
		return fmt.Errorf("deal creation fee denom must be %q (got %q)", sdk.DefaultBondDenom, v.Denom)
	}
	return nil
}

func validateMinDurationBlocks(i interface{}) error {
	_, ok := i.(uint64)
	if !ok {
		return fmt.Errorf("invalid parameter type: %T", i)
	}
	return nil
}

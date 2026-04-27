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
	KeyBaseStripeCost        = []byte("BaseStripeCost")
	KeyHalvingInterval       = []byte("HalvingInterval")
	KeyEip712ChainID         = []byte("Eip712ChainId")
	KeyStoragePrice          = []byte("StoragePrice")
	KeyDealCreationFee       = []byte("DealCreationFee")
	KeyMinDurationBlocks     = []byte("MinDurationBlocks")
	KeyBaseRetrievalFee      = []byte("BaseRetrievalFee")
	KeyRetrievalPricePerBlob = []byte("RetrievalPricePerBlob")
	KeyRetrievalBurnBps      = []byte("RetrievalBurnBps")
	KeyMonthLenBlocks        = []byte("MonthLenBlocks")
	KeyDealExtensionGrace    = []byte("DealExtensionGraceBlocks")
	KeyVoucherMaxTTLBlocks   = []byte("VoucherMaxTTLBlocks")
	KeyAuditBudgetBps        = []byte("AuditBudgetBps")
	KeyAuditBudgetCapBps     = []byte("AuditBudgetCapBps")
	KeyAuditBudgetCarryEpoch = []byte("AuditBudgetCarryoverEpochs")
	KeyEmissionStartHeight   = []byte("EmissionStartHeight")
	KeyBaseRewardHalvingInt  = []byte("BaseRewardHalvingIntervalBlocks")
	KeyBaseRewardBpsStart    = []byte("BaseRewardBpsStart")
	KeyBaseRewardBpsTail     = []byte("BaseRewardBpsTail")
	KeyMaxDrainBytesPerEpoch = []byte("MaxDrainBytesPerEpoch")
	KeyMaxRepairingRatioBps  = []byte("MaxRepairingBytesRatioBps")
	KeyRotationBytesPerEpoch = []byte("RotationBytesPerEpoch")

	KeyDynamicPricingEnabled        = []byte("DynamicPricingEnabled")
	KeyStoragePriceMin              = []byte("StoragePriceMin")
	KeyStoragePriceMax              = []byte("StoragePriceMax")
	KeyStorageTargetUtilizationBps  = []byte("StorageTargetUtilizationBps")
	KeyRetrievalPricePerBlobMin     = []byte("RetrievalPricePerBlobMin")
	KeyRetrievalPricePerBlobMax     = []byte("RetrievalPricePerBlobMax")
	KeyRetrievalTargetBlobsPerEpoch = []byte("RetrievalTargetBlobsPerEpoch")
	KeyDynamicPricingMaxStepBps     = []byte("DynamicPricingMaxStepBps")
	KeyMaxSetupBumpsPerSlot         = []byte("MaxSetupBumpsPerSlot")
	KeyRepairBackoffEpochs          = []byte("RepairBackoffEpochs")
	KeyProviderHealthDecayEpochs    = []byte("ProviderHealthDecayEpochs")
	KeyProviderHealthDecayBps       = []byte("ProviderHealthDecayBps")
	KeyJailHardFaultEpochs          = []byte("JailHardFaultEpochs")
	KeyHardFaultReputationSlashBps  = []byte("HardFaultReputationSlashBps")
	KeyRepairReadinessQuotaBps      = []byte("RepairReadinessQuotaBps")
	KeyMinProviderBond              = []byte("MinProviderBond")
	KeyHardFaultBondSlashBps        = []byte("HardFaultBondSlashBps")
	KeyAssignmentCollateralPerSlot  = []byte("AssignmentCollateralPerSlot")
	KeyProviderBondUnbondingBlocks  = []byte("ProviderBondUnbondingBlocks")

	KeyEpochLenBlocks         = []byte("EpochLenBlocks")
	KeyQuotaBpsPerEpochHot    = []byte("QuotaBpsPerEpochHot")
	KeyQuotaBpsPerEpochCold   = []byte("QuotaBpsPerEpochCold")
	KeyQuotaMinBlobs          = []byte("QuotaMinBlobs")
	KeyQuotaMaxBlobs          = []byte("QuotaMaxBlobs")
	KeyCreditCapBps           = []byte("CreditCapBps")
	KeyEvictAfterMissedEpochs = []byte("EvictAfterMissedEpochs")
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
	storagePriceMin math.LegacyDec,
	storagePriceMax math.LegacyDec,
	storageTargetUtilizationBps uint64,
	dealCreationFee sdk.Coin,
	minDurationBlocks uint64,
	baseRetrievalFee sdk.Coin,
	retrievalPricePerBlob sdk.Coin,
	retrievalPricePerBlobMin sdk.Coin,
	retrievalPricePerBlobMax sdk.Coin,
	retrievalTargetBlobsPerEpoch uint64,
	retrievalBurnBps uint64,
	monthLenBlocks uint64,
	epochLenBlocks uint64,
	quotaBpsPerEpochHot uint64,
	quotaBpsPerEpochCold uint64,
	quotaMinBlobs uint64,
	quotaMaxBlobs uint64,
	creditCapBps uint64,
	evictAfterMissedEpochs uint64,
	dealExtensionGraceBlocks uint64,
	voucherMaxTTLBlocks uint64,
	auditBudgetBps uint64,
	auditBudgetCapBps uint64,
	auditBudgetCarryoverEpochs uint64,
	emissionStartHeight uint64,
	baseRewardHalvingIntervalBlocks uint64,
	baseRewardBpsStart uint64,
	baseRewardBpsTail uint64,
	maxDrainBytesPerEpoch uint64,
	maxRepairingBytesRatioBps uint64,
	rotationBytesPerEpoch uint64,
	dynamicPricingEnabled bool,
	dynamicPricingMaxStepBps uint64,
	maxSetupBumpsPerSlot uint64,
	repairBackoffEpochs uint64,
	providerHealthDecayEpochs uint64,
	providerHealthDecayBps uint64,
	jailHardFaultEpochs uint64,
	hardFaultReputationSlashBps uint64,
	repairReadinessQuotaBps uint64,
	minProviderBond sdk.Coin,
	hardFaultBondSlashBps uint64,
	assignmentCollateralPerSlot sdk.Coin,
	providerBondUnbondingBlocks uint64,
) Params {
	return Params{
		BaseStripeCost:               baseStripeCost,
		HalvingInterval:              halvingInterval,
		Eip712ChainId:                eip712ChainID,
		StoragePrice:                 storagePrice,
		StoragePriceMin:              storagePriceMin,
		StoragePriceMax:              storagePriceMax,
		StorageTargetUtilizationBps:  storageTargetUtilizationBps,
		DealCreationFee:              dealCreationFee,
		MinDurationBlocks:            minDurationBlocks,
		BaseRetrievalFee:             baseRetrievalFee,
		RetrievalPricePerBlob:        retrievalPricePerBlob,
		RetrievalPricePerBlobMin:     retrievalPricePerBlobMin,
		RetrievalPricePerBlobMax:     retrievalPricePerBlobMax,
		RetrievalTargetBlobsPerEpoch: retrievalTargetBlobsPerEpoch,
		RetrievalBurnBps:             retrievalBurnBps,
		MonthLenBlocks:               monthLenBlocks,

		EpochLenBlocks:             epochLenBlocks,
		QuotaBpsPerEpochHot:        quotaBpsPerEpochHot,
		QuotaBpsPerEpochCold:       quotaBpsPerEpochCold,
		QuotaMinBlobs:              quotaMinBlobs,
		QuotaMaxBlobs:              quotaMaxBlobs,
		CreditCapBps:               creditCapBps,
		EvictAfterMissedEpochs:     evictAfterMissedEpochs,
		DealExtensionGraceBlocks:   dealExtensionGraceBlocks,
		VoucherMaxTtlBlocks:        voucherMaxTTLBlocks,
		AuditBudgetBps:             auditBudgetBps,
		AuditBudgetCapBps:          auditBudgetCapBps,
		AuditBudgetCarryoverEpochs: auditBudgetCarryoverEpochs,
		EmissionStartHeight:        emissionStartHeight,

		BaseRewardHalvingIntervalBlocks: baseRewardHalvingIntervalBlocks,
		BaseRewardBpsStart:              baseRewardBpsStart,
		BaseRewardBpsTail:               baseRewardBpsTail,

		MaxDrainBytesPerEpoch:     maxDrainBytesPerEpoch,
		MaxRepairingBytesRatioBps: maxRepairingBytesRatioBps,
		RotationBytesPerEpoch:     rotationBytesPerEpoch,

		DynamicPricingEnabled:    dynamicPricingEnabled,
		DynamicPricingMaxStepBps: dynamicPricingMaxStepBps,
		MaxSetupBumpsPerSlot:     maxSetupBumpsPerSlot,
		RepairBackoffEpochs:      repairBackoffEpochs,

		ProviderHealthDecayEpochs:   providerHealthDecayEpochs,
		ProviderHealthDecayBps:      providerHealthDecayBps,
		JailHardFaultEpochs:         jailHardFaultEpochs,
		HardFaultReputationSlashBps: hardFaultReputationSlashBps,
		RepairReadinessQuotaBps:     repairReadinessQuotaBps,
		MinProviderBond:             minProviderBond,
		HardFaultBondSlashBps:       hardFaultBondSlashBps,
		AssignmentCollateralPerSlot: assignmentCollateralPerSlot,
		ProviderBondUnbondingBlocks: providerBondUnbondingBlocks,
	}
}

// DefaultParams returns a default set of parameters.
func DefaultParams() Params {
	return NewParams(
		10,                   // BaseStripeCost
		1000,                 // HalvingInterval
		31337,                // EIP712ChainId (MetaMask localhost default)
		math.LegacyNewDec(0), // StoragePrice
		math.LegacyNewDec(0), // StoragePriceMin (dynamic pricing; disabled by default)
		math.LegacyNewDec(0), // StoragePriceMax (dynamic pricing; disabled by default)
		0,                    // StorageTargetUtilizationBps (0 disables dynamic storage pricing)
		sdk.NewCoin(sdk.DefaultBondDenom, math.NewInt(0)), // DealCreationFee
		10, // MinDurationBlocks
		sdk.NewCoin(sdk.DefaultBondDenom, math.NewInt(1)), // BaseRetrievalFee (provisional devnet default)
		sdk.NewCoin(sdk.DefaultBondDenom, math.NewInt(1)), // RetrievalPricePerBlob (provisional devnet default)
		sdk.NewCoin(sdk.DefaultBondDenom, math.NewInt(1)), // RetrievalPricePerBlobMin (dynamic pricing; disabled by default)
		sdk.NewCoin(sdk.DefaultBondDenom, math.NewInt(1)), // RetrievalPricePerBlobMax (dynamic pricing; disabled by default)
		0,       // RetrievalTargetBlobsPerEpoch (0 disables dynamic retrieval pricing)
		500,     // RetrievalBurnBps (5%)
		1000,    // MonthLenBlocks (devnet-friendly "month")
		100,     // EpochLenBlocks (devnet-friendly "epoch")
		100,     // QuotaBpsPerEpochHot (1%)
		50,      // QuotaBpsPerEpochCold (0.5%)
		1,       // QuotaMinBlobs
		64,      // QuotaMaxBlobs
		5000,    // CreditCapBps (50% of quota via organic retrieval)
		3,       // EvictAfterMissedEpochs
		1000,    // DealExtensionGraceBlocks (default: 1 month)
		1000,    // VoucherMaxTTLBlocks (default: 1 month)
		25,      // AuditBudgetBps (0.25% of notional rent per epoch)
		100,     // AuditBudgetCapBps (1% of notional rent per epoch)
		2,       // AuditBudgetCarryoverEpochs
		1,       // EmissionStartHeight
		1000000, // BaseRewardHalvingIntervalBlocks
		425,     // BaseRewardBpsStart
		25,      // BaseRewardBpsTail
		0,       // MaxDrainBytesPerEpoch (disabled by default)
		0,       // MaxRepairingBytesRatioBps (disabled by default)
		0,       // RotationBytesPerEpoch (disabled by default)
		false,   // DynamicPricingEnabled
		500,     // DynamicPricingMaxStepBps (5% per epoch; unused when disabled)
		3,       // MaxSetupBumpsPerSlot
		1,       // RepairBackoffEpochs (skip the immediate next epoch after backoff)
		6,       // ProviderHealthDecayEpochs (quiet epochs before soft-fault decay)
		5000,    // ProviderHealthDecayBps (decay half the soft-fault window)
		3,       // JailHardFaultEpochs (devnet hard-fault jail window)
		50,      // HardFaultReputationSlashBps (0.5% reputation slash, min 1)
		10000,   // RepairReadinessQuotaBps (full quota before catch-up ready)
		sdk.NewCoin(sdk.DefaultBondDenom, math.NewInt(0)), // MinProviderBond (disabled by default)
		0, // HardFaultBondSlashBps (disabled until governance/devnet params enable it)
		sdk.NewCoin(sdk.DefaultBondDenom, math.NewInt(0)), // AssignmentCollateralPerSlot (disabled by default)
		0, // ProviderBondUnbondingBlocks (0 preserves immediate local/devnet withdrawal)
	)
}

// ParamSetPairs get the params.ParamSet
func (p *Params) ParamSetPairs() paramtypes.ParamSetPairs {
	return paramtypes.ParamSetPairs{
		paramtypes.NewParamSetPair(KeyBaseStripeCost, &p.BaseStripeCost, validateBaseStripeCost),
		paramtypes.NewParamSetPair(KeyHalvingInterval, &p.HalvingInterval, validateHalvingInterval),
		paramtypes.NewParamSetPair(KeyEip712ChainID, &p.Eip712ChainId, validateEip712ChainID),
		paramtypes.NewParamSetPair(KeyStoragePrice, &p.StoragePrice, validateStoragePrice),
		paramtypes.NewParamSetPair(KeyStoragePriceMin, &p.StoragePriceMin, validateStoragePrice),
		paramtypes.NewParamSetPair(KeyStoragePriceMax, &p.StoragePriceMax, validateStoragePrice),
		paramtypes.NewParamSetPair(KeyStorageTargetUtilizationBps, &p.StorageTargetUtilizationBps, validateBps),
		paramtypes.NewParamSetPair(KeyDealCreationFee, &p.DealCreationFee, validateDealCreationFee),
		paramtypes.NewParamSetPair(KeyMinDurationBlocks, &p.MinDurationBlocks, validateMinDurationBlocks),
		paramtypes.NewParamSetPair(KeyBaseRetrievalFee, &p.BaseRetrievalFee, validateBaseRetrievalFee),
		paramtypes.NewParamSetPair(KeyRetrievalPricePerBlob, &p.RetrievalPricePerBlob, validateRetrievalPricePerBlob),
		paramtypes.NewParamSetPair(KeyRetrievalPricePerBlobMin, &p.RetrievalPricePerBlobMin, validateRetrievalPricePerBlob),
		paramtypes.NewParamSetPair(KeyRetrievalPricePerBlobMax, &p.RetrievalPricePerBlobMax, validateRetrievalPricePerBlob),
		paramtypes.NewParamSetPair(KeyRetrievalTargetBlobsPerEpoch, &p.RetrievalTargetBlobsPerEpoch, validateUint64Any),
		paramtypes.NewParamSetPair(KeyRetrievalBurnBps, &p.RetrievalBurnBps, validateRetrievalBurnBps),
		paramtypes.NewParamSetPair(KeyMonthLenBlocks, &p.MonthLenBlocks, validateMonthLenBlocks),

		paramtypes.NewParamSetPair(KeyEpochLenBlocks, &p.EpochLenBlocks, validateEpochLenBlocks),
		paramtypes.NewParamSetPair(KeyQuotaBpsPerEpochHot, &p.QuotaBpsPerEpochHot, validateQuotaBpsPerEpoch),
		paramtypes.NewParamSetPair(KeyQuotaBpsPerEpochCold, &p.QuotaBpsPerEpochCold, validateQuotaBpsPerEpoch),
		paramtypes.NewParamSetPair(KeyQuotaMinBlobs, &p.QuotaMinBlobs, validateQuotaMinBlobs),
		paramtypes.NewParamSetPair(KeyQuotaMaxBlobs, &p.QuotaMaxBlobs, validateQuotaMaxBlobs),
		paramtypes.NewParamSetPair(KeyCreditCapBps, &p.CreditCapBps, validateCreditCapBps),
		paramtypes.NewParamSetPair(KeyEvictAfterMissedEpochs, &p.EvictAfterMissedEpochs, validateEvictAfterMissedEpochs),
		paramtypes.NewParamSetPair(KeyDealExtensionGrace, &p.DealExtensionGraceBlocks, validateDealExtensionGraceBlocks),
		paramtypes.NewParamSetPair(KeyVoucherMaxTTLBlocks, &p.VoucherMaxTtlBlocks, validateVoucherMaxTTLBlocks),
		paramtypes.NewParamSetPair(KeyAuditBudgetBps, &p.AuditBudgetBps, validateBps),
		paramtypes.NewParamSetPair(KeyAuditBudgetCapBps, &p.AuditBudgetCapBps, validateBps),
		paramtypes.NewParamSetPair(KeyAuditBudgetCarryEpoch, &p.AuditBudgetCarryoverEpochs, validateAuditBudgetCarryoverEpochs),
		paramtypes.NewParamSetPair(KeyEmissionStartHeight, &p.EmissionStartHeight, validateEmissionStartHeight),
		paramtypes.NewParamSetPair(KeyBaseRewardHalvingInt, &p.BaseRewardHalvingIntervalBlocks, validateHalvingInterval),
		paramtypes.NewParamSetPair(KeyBaseRewardBpsStart, &p.BaseRewardBpsStart, validateBps),
		paramtypes.NewParamSetPair(KeyBaseRewardBpsTail, &p.BaseRewardBpsTail, validateBps),
		paramtypes.NewParamSetPair(KeyMaxDrainBytesPerEpoch, &p.MaxDrainBytesPerEpoch, validateUint64Any),
		paramtypes.NewParamSetPair(KeyMaxRepairingRatioBps, &p.MaxRepairingBytesRatioBps, validateBps),
		paramtypes.NewParamSetPair(KeyRotationBytesPerEpoch, &p.RotationBytesPerEpoch, validateUint64Any),

		paramtypes.NewParamSetPair(KeyDynamicPricingEnabled, &p.DynamicPricingEnabled, validateBool),
		paramtypes.NewParamSetPair(KeyDynamicPricingMaxStepBps, &p.DynamicPricingMaxStepBps, validateBps),
		paramtypes.NewParamSetPair(KeyMaxSetupBumpsPerSlot, &p.MaxSetupBumpsPerSlot, validateUint64Any),
		paramtypes.NewParamSetPair(KeyRepairBackoffEpochs, &p.RepairBackoffEpochs, validateUint64Any),
		paramtypes.NewParamSetPair(KeyProviderHealthDecayEpochs, &p.ProviderHealthDecayEpochs, validateUint64Any),
		paramtypes.NewParamSetPair(KeyProviderHealthDecayBps, &p.ProviderHealthDecayBps, validateBps),
		paramtypes.NewParamSetPair(KeyJailHardFaultEpochs, &p.JailHardFaultEpochs, validateUint64Any),
		paramtypes.NewParamSetPair(KeyHardFaultReputationSlashBps, &p.HardFaultReputationSlashBps, validateBps),
		paramtypes.NewParamSetPair(KeyRepairReadinessQuotaBps, &p.RepairReadinessQuotaBps, validateBps),
		paramtypes.NewParamSetPair(KeyMinProviderBond, &p.MinProviderBond, validateProviderBond),
		paramtypes.NewParamSetPair(KeyHardFaultBondSlashBps, &p.HardFaultBondSlashBps, validateBps),
		paramtypes.NewParamSetPair(KeyAssignmentCollateralPerSlot, &p.AssignmentCollateralPerSlot, validateProviderBond),
		paramtypes.NewParamSetPair(KeyProviderBondUnbondingBlocks, &p.ProviderBondUnbondingBlocks, validateUint64Any),
	}
}

// Validate validates the set of params.
func (p Params) Validate() error {
	if err := validateBaseStripeCost(p.BaseStripeCost); err != nil {
		return err
	}
	if err := validateEip712ChainID(p.Eip712ChainId); err != nil {
		return err
	}
	if err := validateHalvingInterval(p.HalvingInterval); err != nil {
		return err
	}
	if err := validateStoragePrice(p.StoragePrice); err != nil {
		return err
	}
	if err := validateStoragePrice(p.StoragePriceMin); err != nil {
		return err
	}
	if err := validateStoragePrice(p.StoragePriceMax); err != nil {
		return err
	}
	if p.StoragePriceMax.LT(p.StoragePriceMin) {
		return fmt.Errorf("storage_price_max must be >= storage_price_min (got %s < %s)", p.StoragePriceMax, p.StoragePriceMin)
	}
	if err := validateDealCreationFee(p.DealCreationFee); err != nil {
		return err
	}
	if err := validateMinDurationBlocks(p.MinDurationBlocks); err != nil {
		return err
	}
	if err := validateBaseRetrievalFee(p.BaseRetrievalFee); err != nil {
		return err
	}
	if err := validateRetrievalPricePerBlob(p.RetrievalPricePerBlob); err != nil {
		return err
	}
	if err := validateRetrievalPricePerBlob(p.RetrievalPricePerBlobMin); err != nil {
		return err
	}
	if err := validateRetrievalPricePerBlob(p.RetrievalPricePerBlobMax); err != nil {
		return err
	}
	if p.RetrievalPricePerBlobMax.Amount.LT(p.RetrievalPricePerBlobMin.Amount) {
		return fmt.Errorf("retrieval_price_per_blob_max must be >= retrieval_price_per_blob_min (got %s < %s)", p.RetrievalPricePerBlobMax.Amount, p.RetrievalPricePerBlobMin.Amount)
	}
	if err := validateRetrievalBurnBps(p.RetrievalBurnBps); err != nil {
		return err
	}
	if err := validateMonthLenBlocks(p.MonthLenBlocks); err != nil {
		return err
	}
	if err := validateEpochLenBlocks(p.EpochLenBlocks); err != nil {
		return err
	}
	if err := validateQuotaBpsPerEpoch(p.QuotaBpsPerEpochHot); err != nil {
		return err
	}
	if err := validateQuotaBpsPerEpoch(p.QuotaBpsPerEpochCold); err != nil {
		return err
	}
	if err := validateQuotaMinBlobs(p.QuotaMinBlobs); err != nil {
		return err
	}
	if err := validateQuotaMaxBlobs(p.QuotaMaxBlobs); err != nil {
		return err
	}
	if p.QuotaMaxBlobs != 0 && p.QuotaMinBlobs > p.QuotaMaxBlobs {
		return fmt.Errorf("quota_min_blobs must be <= quota_max_blobs (got %d > %d)", p.QuotaMinBlobs, p.QuotaMaxBlobs)
	}
	if err := validateCreditCapBps(p.CreditCapBps); err != nil {
		return err
	}
	if err := validateEvictAfterMissedEpochs(p.EvictAfterMissedEpochs); err != nil {
		return err
	}
	if err := validateDealExtensionGraceBlocks(p.DealExtensionGraceBlocks); err != nil {
		return err
	}
	if err := validateVoucherMaxTTLBlocks(p.VoucherMaxTtlBlocks); err != nil {
		return err
	}
	if err := validateBps(p.AuditBudgetBps); err != nil {
		return err
	}
	if err := validateBps(p.AuditBudgetCapBps); err != nil {
		return err
	}
	if p.AuditBudgetCapBps != 0 && p.AuditBudgetBps > p.AuditBudgetCapBps {
		return fmt.Errorf("audit_budget_bps must be <= audit_budget_cap_bps (got %d > %d)", p.AuditBudgetBps, p.AuditBudgetCapBps)
	}
	if err := validateAuditBudgetCarryoverEpochs(p.AuditBudgetCarryoverEpochs); err != nil {
		return err
	}
	if err := validateEmissionStartHeight(p.EmissionStartHeight); err != nil {
		return err
	}
	if err := validateHalvingInterval(p.BaseRewardHalvingIntervalBlocks); err != nil {
		return err
	}
	if err := validateBps(p.BaseRewardBpsStart); err != nil {
		return err
	}
	if err := validateBps(p.BaseRewardBpsTail); err != nil {
		return err
	}
	if p.BaseRewardBpsStart < p.BaseRewardBpsTail {
		return fmt.Errorf("base_reward_bps_start must be >= base_reward_bps_tail (got %d < %d)", p.BaseRewardBpsStart, p.BaseRewardBpsTail)
	}
	if err := validateUint64Any(p.MaxDrainBytesPerEpoch); err != nil {
		return err
	}
	if err := validateBps(p.MaxRepairingBytesRatioBps); err != nil {
		return err
	}
	if err := validateUint64Any(p.RotationBytesPerEpoch); err != nil {
		return err
	}
	if err := validateBool(p.DynamicPricingEnabled); err != nil {
		return err
	}
	if err := validateBps(p.DynamicPricingMaxStepBps); err != nil {
		return err
	}
	if err := validateUint64Any(p.MaxSetupBumpsPerSlot); err != nil {
		return err
	}
	if err := validateUint64Any(p.RepairBackoffEpochs); err != nil {
		return err
	}
	if err := validateUint64Any(p.ProviderHealthDecayEpochs); err != nil {
		return err
	}
	if err := validateBps(p.ProviderHealthDecayBps); err != nil {
		return err
	}
	if err := validateUint64Any(p.JailHardFaultEpochs); err != nil {
		return err
	}
	if err := validateBps(p.HardFaultReputationSlashBps); err != nil {
		return err
	}
	if err := validateBps(p.RepairReadinessQuotaBps); err != nil {
		return err
	}
	if err := validateProviderBond(p.MinProviderBond); err != nil {
		return err
	}
	if err := validateBps(p.HardFaultBondSlashBps); err != nil {
		return err
	}
	if err := validateProviderBond(p.AssignmentCollateralPerSlot); err != nil {
		return err
	}
	if err := validateUint64Any(p.ProviderBondUnbondingBlocks); err != nil {
		return err
	}
	return nil
}

func validateAuditBudgetCarryoverEpochs(i interface{}) error {
	_, ok := i.(uint64)
	if !ok {
		return fmt.Errorf("invalid parameter type: %T", i)
	}
	// 0 is allowed (no carryover).
	return nil
}

func validateEmissionStartHeight(i interface{}) error {
	_, ok := i.(uint64)
	if !ok {
		return fmt.Errorf("invalid parameter type: %T", i)
	}
	// 0 is allowed (treat as genesis height).
	return nil
}

func validateUint64Any(i interface{}) error {
	_, ok := i.(uint64)
	if !ok {
		return fmt.Errorf("invalid parameter type: %T", i)
	}
	return nil
}

func validateDealExtensionGraceBlocks(i interface{}) error {
	_, ok := i.(uint64)
	if !ok {
		return fmt.Errorf("invalid parameter type: %T", i)
	}
	// Grace blocks may be 0 (strict expiry) or a positive window (recommended).
	return nil
}

func validateVoucherMaxTTLBlocks(i interface{}) error {
	_, ok := i.(uint64)
	if !ok {
		return fmt.Errorf("invalid parameter type: %T", i)
	}
	// 0 disables TTL enforcement (not recommended).
	return nil
}

func validateBaseStripeCost(i interface{}) error {
	_, ok := i.(uint64)
	if !ok {
		return fmt.Errorf("invalid parameter type: %T", i)
	}
	return nil
}

func validateHalvingInterval(i interface{}) error {
	v, ok := i.(uint64)
	if !ok {
		return fmt.Errorf("invalid parameter type: %T", i)
	}
	if v == 0 {
		return fmt.Errorf("halving interval must be non-zero")
	}
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

func validateProviderBond(i interface{}) error {
	v, ok := i.(sdk.Coin)
	if !ok {
		return fmt.Errorf("invalid parameter type: %T", i)
	}
	if v.Amount.IsNil() {
		v.Amount = math.ZeroInt()
	}
	if strings.TrimSpace(v.Denom) == "" && v.Amount.IsZero() {
		return nil
	}
	if !v.IsValid() {
		return fmt.Errorf("invalid provider bond: %s", v)
	}
	if strings.TrimSpace(v.Denom) != strings.TrimSpace(sdk.DefaultBondDenom) {
		return fmt.Errorf("provider bond denom must be %q (got %q)", sdk.DefaultBondDenom, v.Denom)
	}
	return nil
}

func validateMinDurationBlocks(i interface{}) error {
	v, ok := i.(uint64)
	if !ok {
		return fmt.Errorf("invalid parameter type: %T", i)
	}
	if v == 0 {
		return fmt.Errorf("min duration seconds must be non-zero")
	}
	return nil
}

func validateBaseRetrievalFee(i interface{}) error {
	v, ok := i.(sdk.Coin)
	if !ok {
		return fmt.Errorf("invalid parameter type: %T", i)
	}
	if !v.IsValid() {
		return fmt.Errorf("invalid base retrieval fee: %s", v)
	}
	if strings.TrimSpace(v.Denom) != strings.TrimSpace(sdk.DefaultBondDenom) {
		return fmt.Errorf("base retrieval fee denom must be %q (got %q)", sdk.DefaultBondDenom, v.Denom)
	}
	return nil
}

func validateRetrievalPricePerBlob(i interface{}) error {
	v, ok := i.(sdk.Coin)
	if !ok {
		return fmt.Errorf("invalid parameter type: %T", i)
	}
	if !v.IsValid() {
		return fmt.Errorf("invalid retrieval price per blob: %s", v)
	}
	if strings.TrimSpace(v.Denom) != strings.TrimSpace(sdk.DefaultBondDenom) {
		return fmt.Errorf("retrieval price per blob denom must be %q (got %q)", sdk.DefaultBondDenom, v.Denom)
	}
	return nil
}

func validateRetrievalBurnBps(i interface{}) error {
	v, ok := i.(uint64)
	if !ok {
		return fmt.Errorf("invalid parameter type: %T", i)
	}
	if v > 10000 {
		return fmt.Errorf("retrieval burn bps must be <= 10000 (got %d)", v)
	}
	return nil
}

func validateMonthLenBlocks(i interface{}) error {
	v, ok := i.(uint64)
	if !ok {
		return fmt.Errorf("invalid parameter type: %T", i)
	}
	if v == 0 {
		return fmt.Errorf("month_len_blocks must be non-zero")
	}
	return nil
}

func validateEpochLenBlocks(i interface{}) error {
	v, ok := i.(uint64)
	if !ok {
		return fmt.Errorf("invalid parameter type: %T", i)
	}
	if v == 0 {
		return fmt.Errorf("epoch_len_blocks must be non-zero")
	}
	return nil
}

func validateQuotaBpsPerEpoch(i interface{}) error {
	v, ok := i.(uint64)
	if !ok {
		return fmt.Errorf("invalid parameter type: %T", i)
	}
	if v > 10000 {
		return fmt.Errorf("quota bps must be <= 10000 (got %d)", v)
	}
	return nil
}

func validateQuotaMinBlobs(i interface{}) error {
	v, ok := i.(uint64)
	if !ok {
		return fmt.Errorf("invalid parameter type: %T", i)
	}
	if v == 0 {
		return fmt.Errorf("quota_min_blobs must be non-zero")
	}
	return nil
}

func validateQuotaMaxBlobs(i interface{}) error {
	v, ok := i.(uint64)
	if !ok {
		return fmt.Errorf("invalid parameter type: %T", i)
	}
	if v == 0 {
		return fmt.Errorf("quota_max_blobs must be non-zero")
	}
	return nil
}

func validateCreditCapBps(i interface{}) error {
	v, ok := i.(uint64)
	if !ok {
		return fmt.Errorf("invalid parameter type: %T", i)
	}
	if v > 10000 {
		return fmt.Errorf("credit cap bps must be <= 10000 (got %d)", v)
	}
	return nil
}

func validateEvictAfterMissedEpochs(i interface{}) error {
	v, ok := i.(uint64)
	if !ok {
		return fmt.Errorf("invalid parameter type: %T", i)
	}
	if v == 0 {
		return fmt.Errorf("evict_after_missed_epochs must be non-zero")
	}
	return nil
}

func validateBps(i interface{}) error {
	v, ok := i.(uint64)
	if !ok {
		return fmt.Errorf("invalid parameter type: %T", i)
	}
	if v > 10000 {
		return fmt.Errorf("bps must be <= 10000 (got %d)", v)
	}
	return nil
}

func validateBool(i interface{}) error {
	_, ok := i.(bool)
	if !ok {
		return fmt.Errorf("invalid parameter type: %T", i)
	}
	return nil
}

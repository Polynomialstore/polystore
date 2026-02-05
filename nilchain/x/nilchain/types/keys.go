package types

import "cosmossdk.io/collections"

const (
	// ModuleName defines the module name
	ModuleName = "nilchain"
	// ProtocolBudgetModuleName is a dedicated module account used to fund
	// protocol retrieval sessions (audit/repair).
	ProtocolBudgetModuleName = "nilchain_protocol_budget"

	// StoreKey defines the primary module store key
	StoreKey = ModuleName

	// GovModuleName duplicates the gov module's name to avoid a dependency with x/gov.
	// It should be synced with the gov module's name if it is ever changed.
	// See: https://github.com/cosmos/cosmos-sdk/blob/v0.52.0-beta.2/x/gov/types/keys.go#L9
	GovModuleName = "gov"
)

// ParamsKey is the prefix to retrieve all Params
var ParamsKey = collections.NewPrefix("p_nilchain")

var (
	ProofCountKey = collections.NewPrefix("ProofCount/value/")
	ProofsKey     = collections.NewPrefix("Proofs/value/")

	DealCountKey                     = collections.NewPrefix("DealCount/value/")
	DealsKey                         = collections.NewPrefix("Deals/value/")
	ProvidersKey                     = collections.NewPrefix("Providers/value/")
	DealProviderStatusKey            = collections.NewPrefix("DealProviderStatus/value/")
	DealProviderFailuresKey          = collections.NewPrefix("DealProviderFailures/value/")
	ProviderRewardsKey               = collections.NewPrefix("ProviderRewards/value/")
	ReceiptNonceKey                  = collections.NewPrefix("ReceiptNonce/value/")
	ReceiptNonceDealFileKey          = collections.NewPrefix("ReceiptNonceDealFile/value/")
	EvmNonceKey                      = collections.NewPrefix("EvmNonce/value/")
	DealHeatStateKey                 = collections.NewPrefix("DealHeatState/value/")
	RetrievalSessionsKey             = collections.NewPrefix("RetrievalSessions/value/")
	RetrievalSessionsByOwnerKey      = collections.NewPrefix("RetrievalSessionsByOwner/value/")
	RetrievalSessionsByProviderKey   = collections.NewPrefix("RetrievalSessionsByProvider/value/")
	RetrievalSessionNonceKey         = collections.NewPrefix("RetrievalSessionNonce/value/")
	RetrievalSessionProofProviderKey = collections.NewPrefix("RetrievalSessionProofProvider/value/")
	VoucherUsedNonceKey              = collections.NewPrefix("VoucherUsedNonce/value/")
	AuditTasksKey                    = collections.NewPrefix("AuditTasks/value/")
	DynamicPricingLastEpochKey       = collections.NewPrefix("DynamicPricingLastEpoch/value/")
	RetrievalDemandByEpochKey        = collections.NewPrefix("RetrievalDemandByEpoch/value/")

	// --- Unified Liveness v1 (epoch + quotas) ---
	EpochSeedKey               = collections.NewPrefix("EpochSeed/value/")
	Mode1EpochCreditsKey       = collections.NewPrefix("Mode1EpochCredits/value/")
	Mode1EpochSyntheticKey     = collections.NewPrefix("Mode1EpochSynthetic/value/")
	Mode1MissedEpochsKey       = collections.NewPrefix("Mode1MissedEpochs/value/")
	Mode2EpochCreditsKey       = collections.NewPrefix("Mode2EpochCredits/value/")
	Mode2EpochSyntheticKey     = collections.NewPrefix("Mode2EpochSynthetic/value/")
	Mode2EpochSlotServedKey    = collections.NewPrefix("Mode2EpochSlotServed/value/")
	Mode2EpochDeputyServedKey  = collections.NewPrefix("Mode2EpochDeputyServed/value/")
	Mode2MissedEpochsKey       = collections.NewPrefix("Mode2MissedEpochs/value/")
	Mode2DeputyMissedEpochsKey = collections.NewPrefix("Mode2DeputyMissedEpochs/value/")
	CreditSeenKey              = collections.NewPrefix("CreditSeen/value/")
	SyntheticSeenKey           = collections.NewPrefix("SyntheticSeen/value/")
	DeputySeenKey              = collections.NewPrefix("DeputySeen/value/")
)

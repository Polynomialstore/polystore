package types

import "cosmossdk.io/collections"

const (
	// ModuleName keeps the legacy internal module/store name so the renamed
	// binary can open the existing devnet state without a store migration.
	// External gRPC/LCD APIs are still exposed under the polystorechain proto
	// namespace; this is only the internal Cosmos module identifier.
	ModuleName = "nilchain"
	// ProtocolBudgetModuleName keeps the legacy module-account name for state
	// compatibility with the existing devnet.
	ProtocolBudgetModuleName = "nilchain_protocol_budget"

	// StoreKey defines the primary module store key
	StoreKey = ModuleName

	// GovModuleName duplicates the gov module's name to avoid a dependency with x/gov.
	// It should be synced with the gov module's name if it is ever changed.
	// See: https://github.com/cosmos/cosmos-sdk/blob/v0.52.0-beta.2/x/gov/types/keys.go#L9
	GovModuleName = "gov"
)

// ParamsKey keeps the legacy params prefix for compatibility with the
// pre-rename on-disk state.
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
	ProviderPairingsKey              = collections.NewPrefix("ProviderPairings/value/")
	ProviderPairingsByOperatorKey    = collections.NewPrefix("ProviderPairingsByOperator/value/")
	PendingProviderLinksKey          = collections.NewPrefix("PendingProviderLinks/value/")
	ReceiptNonceKey                  = collections.NewPrefix("ReceiptNonce/value/")
	ReceiptNonceDealFileKey          = collections.NewPrefix("ReceiptNonceDealFile/value/")
	EvmNonceKey                      = collections.NewPrefix("EvmNonce/value/")
	DealActivityStateKey             = collections.NewPrefix("DealActivityState/value/")
	SetupBumpNonceKey                = collections.NewPrefix("SetupBumpNonce/value/")
	SetupTriedProviderKey            = collections.NewPrefix("SetupTriedProvider/value/")
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

package keeper

import (
	"crypto/sha256"   // ADDED
	"encoding/binary" // ADDED
	"errors"          // ADDED
	"fmt"

	"cosmossdk.io/collections"
	"cosmossdk.io/core/address"
	corestore "cosmossdk.io/core/store"
	"cosmossdk.io/math" // ADDED
	"github.com/cosmos/cosmos-sdk/codec"
	sdk "github.com/cosmos/cosmos-sdk/types" // ADDED for Context
	"polystorechain/x/polystorechain/types"
)

type Keeper struct {
	storeService corestore.KVStoreService
	cdc          codec.Codec
	addressCodec address.Codec
	// Address capable of executing a MsgUpdateParams message.
	// Typically, this should be the x/gov module account.
	authority []byte

	BankKeeper    types.BankKeeper
	AccountKeeper types.AuthKeeper

	Schema     collections.Schema
	Params     collections.Item[types.Params]
	ProofCount collections.Sequence
	Proofs     collections.Map[uint64, types.Proof]

	// New collections for Deals and Providers
	DealCount                  collections.Sequence
	Deals                      collections.Map[uint64, types.Deal]
	Providers                  collections.Map[string, types.Provider] // Key by address string
	DealProviderStatus         collections.Map[collections.Pair[uint64, string], uint64]
	DealProviderFailures       collections.Map[collections.Pair[uint64, string], uint64]
	ProviderRewards            collections.Map[string, math.Int]
	ProviderStorageRewards     collections.Map[string, math.Int]
	ProviderBandwidthRewards   collections.Map[string, math.Int]
	ProviderJailUntil          collections.Map[string, uint64]
	ProviderPairings           collections.Map[string, types.ProviderPairing]
	ProviderPairingsByOperator collections.Map[collections.Pair[string, string], bool]
	PendingProviderLinks       collections.Map[string, types.PendingProviderLink]
	ReceiptNonces              collections.Map[string, uint64]
	ReceiptNoncesByDealFile    collections.Map[collections.Pair[uint64, string], uint64]
	EvmNonces                  collections.Map[string, uint64]
	DealActivityStates         collections.Map[uint64, types.DealActivityState]
	SetupBumpNonce             collections.Map[collections.Pair[uint64, uint32], uint64]
	SetupTriedProvider         collections.Map[collections.Pair[collections.Pair[uint64, uint32], string], bool]

	RetrievalSessions             collections.Map[[]byte, types.RetrievalSession]
	RetrievalSessionsByOwner      collections.Map[collections.Pair[string, []byte], uint64]
	RetrievalSessionsByProvider   collections.Map[collections.Pair[string, []byte], uint64]
	RetrievalSessionNonces        collections.Map[collections.Pair[collections.Pair[string, uint64], string], uint64]
	RetrievalSessionProofProvider collections.Map[[]byte, string]
	VoucherUsedNonces             collections.Map[collections.Pair[uint64, uint64], bool]
	AuditTasks                    collections.Map[collections.Pair[uint64, uint64], types.AuditTask]
	VirtualStripes                collections.Map[collections.Pair[uint64, uint32], types.VirtualStripe]
	DynamicPricingLastEpoch       collections.Item[uint64]
	RetrievalDemandByEpoch        collections.Map[uint64, uint64]
	EvidenceCount                 collections.Sequence
	EvidenceCases                 collections.Map[uint64, types.EvidenceCase]
	EvidenceCasesByDeal           collections.Map[collections.Pair[uint64, uint64], bool]
	SlotHealthStates              collections.Map[collections.Pair[uint64, uint32], types.SlotHealthState]
	ProviderHealthStates          collections.Map[string, types.ProviderHealthState]
	RepairAttemptStates           collections.Map[collections.Pair[uint64, uint32], types.RepairAttemptState]

	// --- Unified Liveness v1 (epoch + quotas) ---
	EpochSeeds                 collections.Map[uint64, []byte]
	Mode1EpochCredits          collections.Map[collections.Pair[collections.Pair[uint64, string], uint64], uint64]
	Mode1EpochSynthetic        collections.Map[collections.Pair[collections.Pair[uint64, string], uint64], uint64]
	Mode1MissedEpochs          collections.Map[collections.Pair[uint64, string], uint64]
	Mode2EpochCredits          collections.Map[collections.Pair[collections.Pair[uint64, uint32], uint64], uint64]
	Mode2EpochSynthetic        collections.Map[collections.Pair[collections.Pair[uint64, uint32], uint64], uint64]
	Mode2EpochSlotServed       collections.Map[collections.Pair[collections.Pair[uint64, uint32], uint64], uint64]
	Mode2EpochDeputyServed     collections.Map[collections.Pair[collections.Pair[uint64, uint32], uint64], uint64]
	Mode2RepairReadiness       collections.Map[collections.Pair[uint64, uint32], uint64]
	Mode2RepairReadinessProofs collections.Map[collections.Pair[uint64, uint32], uint64]
	Mode2MissedEpochs          collections.Map[collections.Pair[uint64, uint32], uint64]
	Mode2DeputyMissedEpochs    collections.Map[collections.Pair[uint64, uint32], uint64]
	CreditSeen                 collections.Map[[]byte, bool]
	SyntheticSeen              collections.Map[[]byte, bool]
	DeputySeen                 collections.Map[[]byte, bool]
}

func NewKeeper(
	storeService corestore.KVStoreService,
	cdc codec.Codec,
	addressCodec address.Codec,
	authority []byte,
	bankKeeper types.BankKeeper,
	accountKeeper types.AuthKeeper,

) Keeper {
	if _, err := addressCodec.BytesToString(authority); err != nil {
		panic(fmt.Sprintf("invalid authority address %s: %s", authority, err))
	}

	sb := collections.NewSchemaBuilder(storeService)

	k := Keeper{
		storeService:  storeService,
		cdc:           cdc,
		addressCodec:  addressCodec,
		authority:     authority,
		BankKeeper:    bankKeeper,
		AccountKeeper: accountKeeper,

		Params:     collections.NewItem(sb, types.ParamsKey, "params", codec.CollValue[types.Params](cdc)),
		ProofCount: collections.NewSequence(sb, types.ProofCountKey, "proof_count"),
		Proofs:     collections.NewMap(sb, types.ProofsKey, "proofs", collections.Uint64Key, codec.CollValue[types.Proof](cdc)),

		DealCount:                  collections.NewSequence(sb, types.DealCountKey, "deal_count"),
		Deals:                      collections.NewMap(sb, types.DealsKey, "deals", collections.Uint64Key, codec.CollValue[types.Deal](cdc)),
		Providers:                  collections.NewMap(sb, types.ProvidersKey, "providers", collections.StringKey, codec.CollValue[types.Provider](cdc)),
		DealProviderStatus:         collections.NewMap(sb, types.DealProviderStatusKey, "deal_provider_status", collections.PairKeyCodec(collections.Uint64Key, collections.StringKey), collections.Uint64Value),
		DealProviderFailures:       collections.NewMap(sb, types.DealProviderFailuresKey, "deal_provider_failures", collections.PairKeyCodec(collections.Uint64Key, collections.StringKey), collections.Uint64Value),
		ProviderRewards:            collections.NewMap(sb, types.ProviderRewardsKey, "provider_rewards", collections.StringKey, sdk.IntValue),
		ProviderStorageRewards:     collections.NewMap(sb, types.ProviderStorageRewardsKey, "provider_storage_rewards", collections.StringKey, sdk.IntValue),
		ProviderBandwidthRewards:   collections.NewMap(sb, types.ProviderBandwidthRewardsKey, "provider_bandwidth_rewards", collections.StringKey, sdk.IntValue),
		ProviderJailUntil:          collections.NewMap(sb, types.ProviderJailUntilKey, "provider_jail_until", collections.StringKey, collections.Uint64Value),
		ProviderPairings:           collections.NewMap(sb, types.ProviderPairingsKey, "provider_pairings", collections.StringKey, codec.CollValue[types.ProviderPairing](cdc)),
		ProviderPairingsByOperator: collections.NewMap(sb, types.ProviderPairingsByOperatorKey, "provider_pairings_by_operator", collections.PairKeyCodec(collections.StringKey, collections.StringKey), collections.BoolValue),
		PendingProviderLinks:       collections.NewMap(sb, types.PendingProviderLinksKey, "pending_provider_links", collections.StringKey, codec.CollValue[types.PendingProviderLink](cdc)),
		ReceiptNonces:              collections.NewMap(sb, types.ReceiptNonceKey, "receipt_nonces", collections.StringKey, collections.Uint64Value),
		ReceiptNoncesByDealFile:    collections.NewMap(sb, types.ReceiptNonceDealFileKey, "receipt_nonces_by_deal_file", collections.PairKeyCodec(collections.Uint64Key, collections.StringKey), collections.Uint64Value),
		EvmNonces:                  collections.NewMap(sb, types.EvmNonceKey, "evm_nonces", collections.StringKey, collections.Uint64Value),
		DealActivityStates:         collections.NewMap(sb, types.DealActivityStateKey, "deal_activity_states", collections.Uint64Key, codec.CollValue[types.DealActivityState](cdc)),
		SetupBumpNonce:             collections.NewMap(sb, types.SetupBumpNonceKey, "setup_bump_nonce", collections.PairKeyCodec(collections.Uint64Key, collections.Uint32Key), collections.Uint64Value),
		SetupTriedProvider: collections.NewMap(
			sb,
			types.SetupTriedProviderKey,
			"setup_tried_provider",
			collections.PairKeyCodec(collections.PairKeyCodec(collections.Uint64Key, collections.Uint32Key), collections.StringKey),
			collections.BoolValue,
		),

		RetrievalSessions:           collections.NewMap(sb, types.RetrievalSessionsKey, "retrieval_sessions", collections.BytesKey, codec.CollValue[types.RetrievalSession](cdc)),
		RetrievalSessionsByOwner:    collections.NewMap(sb, types.RetrievalSessionsByOwnerKey, "retrieval_sessions_by_owner", collections.PairKeyCodec(collections.StringKey, collections.BytesKey), collections.Uint64Value),
		RetrievalSessionsByProvider: collections.NewMap(sb, types.RetrievalSessionsByProviderKey, "retrieval_sessions_by_provider", collections.PairKeyCodec(collections.StringKey, collections.BytesKey), collections.Uint64Value),
		RetrievalSessionNonces: collections.NewMap(
			sb,
			types.RetrievalSessionNonceKey,
			"retrieval_session_nonces",
			collections.PairKeyCodec(collections.PairKeyCodec(collections.StringKey, collections.Uint64Key), collections.StringKey),
			collections.Uint64Value,
		),
		RetrievalSessionProofProvider: collections.NewMap(sb, types.RetrievalSessionProofProviderKey, "retrieval_session_proof_provider", collections.BytesKey, collections.StringValue),
		VoucherUsedNonces: collections.NewMap(
			sb,
			types.VoucherUsedNonceKey,
			"voucher_used_nonces",
			collections.PairKeyCodec(collections.Uint64Key, collections.Uint64Key),
			collections.BoolValue,
		),
		AuditTasks: collections.NewMap(
			sb,
			types.AuditTasksKey,
			"audit_tasks",
			collections.PairKeyCodec(collections.Uint64Key, collections.Uint64Key),
			codec.CollValue[types.AuditTask](cdc),
		),
		VirtualStripes: collections.NewMap(
			sb,
			types.VirtualStripesKey,
			"virtual_stripes",
			collections.PairKeyCodec(collections.Uint64Key, collections.Uint32Key),
			codec.CollValue[types.VirtualStripe](cdc),
		),
		DynamicPricingLastEpoch: collections.NewItem(
			sb,
			types.DynamicPricingLastEpochKey,
			"dynamic_pricing_last_epoch",
			collections.Uint64Value,
		),
		RetrievalDemandByEpoch: collections.NewMap(
			sb,
			types.RetrievalDemandByEpochKey,
			"retrieval_demand_by_epoch",
			collections.Uint64Key,
			collections.Uint64Value,
		),
		EvidenceCount:       collections.NewSequence(sb, types.EvidenceCountKey, "evidence_count"),
		EvidenceCases:       collections.NewMap(sb, types.EvidenceCasesKey, "evidence_cases", collections.Uint64Key, codec.CollValue[types.EvidenceCase](cdc)),
		EvidenceCasesByDeal: collections.NewMap(sb, types.EvidenceCasesByDealKey, "evidence_cases_by_deal", collections.PairKeyCodec(collections.Uint64Key, collections.Uint64Key), collections.BoolValue),
		SlotHealthStates:    collections.NewMap(sb, types.SlotHealthStatesKey, "slot_health_states", collections.PairKeyCodec(collections.Uint64Key, collections.Uint32Key), codec.CollValue[types.SlotHealthState](cdc)),
		ProviderHealthStates: collections.NewMap(
			sb,
			types.ProviderHealthStatesKey,
			"provider_health_states",
			collections.StringKey,
			codec.CollValue[types.ProviderHealthState](cdc),
		),
		RepairAttemptStates: collections.NewMap(
			sb,
			types.RepairAttemptStatesKey,
			"repair_attempt_states",
			collections.PairKeyCodec(collections.Uint64Key, collections.Uint32Key),
			codec.CollValue[types.RepairAttemptState](cdc),
		),

		EpochSeeds: collections.NewMap(sb, types.EpochSeedKey, "epoch_seeds", collections.Uint64Key, collections.BytesValue),
		Mode1EpochCredits: collections.NewMap(
			sb,
			types.Mode1EpochCreditsKey,
			"mode1_epoch_credits",
			collections.PairKeyCodec(collections.PairKeyCodec(collections.Uint64Key, collections.StringKey), collections.Uint64Key),
			collections.Uint64Value,
		),
		Mode1EpochSynthetic: collections.NewMap(
			sb,
			types.Mode1EpochSyntheticKey,
			"mode1_epoch_synthetic",
			collections.PairKeyCodec(collections.PairKeyCodec(collections.Uint64Key, collections.StringKey), collections.Uint64Key),
			collections.Uint64Value,
		),
		Mode1MissedEpochs: collections.NewMap(
			sb,
			types.Mode1MissedEpochsKey,
			"mode1_missed_epochs",
			collections.PairKeyCodec(collections.Uint64Key, collections.StringKey),
			collections.Uint64Value,
		),
		Mode2EpochCredits: collections.NewMap(
			sb,
			types.Mode2EpochCreditsKey,
			"mode2_epoch_credits",
			collections.PairKeyCodec(collections.PairKeyCodec(collections.Uint64Key, collections.Uint32Key), collections.Uint64Key),
			collections.Uint64Value,
		),
		Mode2EpochSynthetic: collections.NewMap(
			sb,
			types.Mode2EpochSyntheticKey,
			"mode2_epoch_synthetic",
			collections.PairKeyCodec(collections.PairKeyCodec(collections.Uint64Key, collections.Uint32Key), collections.Uint64Key),
			collections.Uint64Value,
		),
		Mode2EpochSlotServed: collections.NewMap(
			sb,
			types.Mode2EpochSlotServedKey,
			"mode2_epoch_slot_served",
			collections.PairKeyCodec(collections.PairKeyCodec(collections.Uint64Key, collections.Uint32Key), collections.Uint64Key),
			collections.Uint64Value,
		),
		Mode2EpochDeputyServed: collections.NewMap(
			sb,
			types.Mode2EpochDeputyServedKey,
			"mode2_epoch_deputy_served",
			collections.PairKeyCodec(collections.PairKeyCodec(collections.Uint64Key, collections.Uint32Key), collections.Uint64Key),
			collections.Uint64Value,
		),
		Mode2RepairReadiness: collections.NewMap(
			sb,
			types.Mode2RepairReadinessKey,
			"mode2_repair_readiness",
			collections.PairKeyCodec(collections.Uint64Key, collections.Uint32Key),
			collections.Uint64Value,
		),
		Mode2RepairReadinessProofs: collections.NewMap(
			sb,
			types.Mode2RepairReadinessProofsKey,
			"mode2_repair_readiness_proofs",
			collections.PairKeyCodec(collections.Uint64Key, collections.Uint32Key),
			collections.Uint64Value,
		),
		Mode2MissedEpochs: collections.NewMap(
			sb,
			types.Mode2MissedEpochsKey,
			"mode2_missed_epochs",
			collections.PairKeyCodec(collections.Uint64Key, collections.Uint32Key),
			collections.Uint64Value,
		),
		Mode2DeputyMissedEpochs: collections.NewMap(
			sb,
			types.Mode2DeputyMissedEpochsKey,
			"mode2_deputy_missed_epochs",
			collections.PairKeyCodec(collections.Uint64Key, collections.Uint32Key),
			collections.Uint64Value,
		),
		CreditSeen:    collections.NewMap(sb, types.CreditSeenKey, "credit_seen", collections.BytesKey, collections.BoolValue),
		SyntheticSeen: collections.NewMap(sb, types.SyntheticSeenKey, "synthetic_seen", collections.BytesKey, collections.BoolValue),
		DeputySeen:    collections.NewMap(sb, types.DeputySeenKey, "deputy_seen", collections.BytesKey, collections.BoolValue),
	}

	schema, err := sb.Build()
	if err != nil {
		panic(err)
	}
	k.Schema = schema

	return k
}

// AssignProviders deterministically assigns providers for a new deal.
// It uses a hash-based approach to select `types.DealBaseReplication` providers
// from the active provider list, respecting service hints and diversity constraints.
func (k Keeper) AssignProviders(ctx sdk.Context, dealID uint64, blockHash []byte, serviceHint string, count uint64) ([]string, error) {
	var allProviders []types.Provider

	// Collect all providers
	err := k.Providers.Walk(ctx, nil, func(key string, provider types.Provider) (stop bool, err error) {
		allProviders = append(allProviders, provider)
		return false, nil
	})
	if err != nil {
		return nil, fmt.Errorf("failed to walk providers: %w", err)
	}

	if len(allProviders) == 0 {
		return nil, fmt.Errorf("no providers registered")
	}

	var candidateProviders []types.Provider
	// Filter by capabilities based on serviceHint
	for _, provider := range allProviders {
		// Only consider "Active" providers for assignment
		if provider.Status != "Active" {
			continue
		}
		if provider.Draining {
			continue
		}
		reason, err := k.providerHealthPlacementIneligibility(ctx, provider)
		if err != nil {
			return nil, fmt.Errorf("failed to check provider health for %s: %w", provider.Address, err)
		}
		if reason != "" {
			continue
		}
		if providerMatchesBaseHint(provider, serviceHint) {
			candidateProviders = append(candidateProviders, provider)
		}
	}

	available := uint64(len(candidateProviders))
	if available == 0 {
		return nil, fmt.Errorf("no suitable providers for service hint '%s'", serviceHint)
	}
	// Bootstrap mode: on small devnets we may have fewer active providers than
	// DealBaseReplication. Instead of failing the deal entirely, cap the
	// replication factor at the number of available candidates.
	if available < count {
		count = available
	}
	candidateProviders = preferProvidersForServiceHint(candidateProviders, serviceHint, count)

	assignedProviders := make([]string, count)
	selectedIndices := make(map[int]struct{})      // To ensure unique providers from candidateProviders slice
	selectedAddresses := make(map[string]struct{}) // To ensure unique provider addresses

	seedBase := make([]byte, 0)
	seedBase = append(seedBase, sdk.Uint64ToBigEndian(dealID)...)
	seedBase = append(seedBase, blockHash...)

	for i := uint64(0); i < count; {
		// Deterministic seed for this selection round
		currentHash := sha256.Sum256(append(seedBase, sdk.Uint64ToBigEndian(i)...))

		// Use the hash as a random source to pick an index
		idx := int(binary.BigEndian.Uint64(currentHash[:8]) % uint64(len(candidateProviders)))

		provider := candidateProviders[idx]

		// Check if provider at idx (in candidateProviders slice) is already selected for this deal round
		if _, exists := selectedIndices[idx]; exists {
			// Already selected, re-seed and try again to find a new unique provider.
			// This might loop if not enough unique providers are available, but that's caught by len(candidateProviders) check.
			newSeed := sha256.Sum256(currentHash[:])
			seedBase = newSeed[:]
			continue
		}

		// Ensure unique provider addresses. This implicitly handles diversity (for now)
		// as it ensures each provider address is distinct.
		if _, exists := selectedAddresses[provider.Address]; exists {
			newSeed := sha256.Sum256(currentHash[:])
			seedBase = newSeed[:]
			continue
		}

		assignedProviders[i] = provider.Address
		selectedIndices[idx] = struct{}{}
		selectedAddresses[provider.Address] = struct{}{}
		i++
	}

	return assignedProviders, nil
}

// GetAuthority returns the module's authority.
func (k Keeper) GetAuthority() []byte {
	return k.authority
}

// RecordDealActivity updates the retrieval and liveness activity counters for a deal.
func (k Keeper) RecordDealActivity(ctx sdk.Context, dealID uint64, bytesServed uint64, failed bool) error {
	state, err := k.DealActivityStates.Get(ctx, dealID)
	if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return err
	}
	// If not found, it's zero-value (empty struct), which is fine for proto3.

	state.BytesServedTotal += bytesServed
	if failed {
		state.FailedChallengesTotal += 1
	} else {
		state.SuccessfulRetrievalsTotal += 1
	}
	state.LastUpdateHeight = ctx.BlockHeight()

	return k.DealActivityStates.Set(ctx, dealID, state)
}

package keeper

import (
	"fmt"
	"crypto/sha256" // ADDED
	"encoding/binary" // ADDED

	"cosmossdk.io/collections"
	"cosmossdk.io/core/address"
	corestore "cosmossdk.io/core/store"
	"github.com/cosmos/cosmos-sdk/codec"
	sdk "github.com/cosmos/cosmos-sdk/types" // ADDED for Context
	"nilchain/x/nilchain/types"
)

type Keeper struct {
	storeService corestore.KVStoreService
	cdc          codec.Codec
	addressCodec address.Codec
	// Address capable of executing a MsgUpdateParams message.
	// Typically, this should be the x/gov module account.
	authority []byte
	
	BankKeeper types.BankKeeper
	AccountKeeper types.AuthKeeper

	Schema collections.Schema
	Params collections.Item[types.Params]
	ProofCount collections.Sequence
	Proofs     collections.Map[uint64, types.Proof]
    
	// New collections for Deals and Providers
	DealCount  collections.Sequence
	Deals      collections.Map[uint64, types.Deal]
	Providers  collections.Map[string, types.Provider] // Key by address string
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
		storeService: storeService,
		cdc:          cdc,
		addressCodec: addressCodec,
		authority:    authority,
		BankKeeper:   bankKeeper,
		AccountKeeper: accountKeeper,
		
		Params:       collections.NewItem(sb, types.ParamsKey, "params", codec.CollValue[types.Params](cdc)),
		ProofCount:   collections.NewSequence(sb, types.ProofCountKey, "proof_count"),
		Proofs:       collections.NewMap(sb, types.ProofsKey, "proofs", collections.Uint64Key, codec.CollValue[types.Proof](cdc)),

		DealCount:    collections.NewSequence(sb, types.DealCountKey, "deal_count"),
		Deals:        collections.NewMap(sb, types.DealsKey, "deals", collections.Uint64Key, codec.CollValue[types.Deal](cdc)),
		Providers:    collections.NewMap(sb, types.ProvidersKey, "providers", collections.StringKey, codec.CollValue[types.Provider](cdc)),
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

		// Apply service hint filter
		if serviceHint == "Hot" && (provider.Capabilities == "General" || provider.Capabilities == "Edge") {
			candidateProviders = append(candidateProviders, provider)
		} else if serviceHint == "Cold" && (provider.Capabilities == "Archive" || provider.Capabilities == "General") {
			candidateProviders = append(candidateProviders, provider)
		} else if serviceHint == "" || serviceHint == "General" { // Default/No specific hint, consider General and above
			candidateProviders = append(candidateProviders, provider)
		}
	}

	if uint64(len(candidateProviders)) < count {
		return nil, fmt.Errorf("not enough suitable providers (%d/%d) for service hint '%s' to satisfy deal replication", len(candidateProviders), count, serviceHint)
	}

	assignedProviders := make([]string, count)
	selectedIndices := make(map[int]struct{})       // To ensure unique providers from candidateProviders slice
	selectedAddresses := make(map[string]struct{})   // To ensure unique provider addresses

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

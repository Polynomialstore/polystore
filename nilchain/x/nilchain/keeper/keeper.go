package keeper

import (
	"fmt"

	"cosmossdk.io/collections"
	"cosmossdk.io/core/address"
	corestore "cosmossdk.io/core/store"
	"github.com/cosmos/cosmos-sdk/codec"
	 

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

// GetAuthority returns the module's authority.
func (k Keeper) GetAuthority() []byte {
	return k.authority
}

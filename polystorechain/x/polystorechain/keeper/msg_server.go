package keeper

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"strings"

	"cosmossdk.io/collections"
	"cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	gethCommon "github.com/ethereum/go-ethereum/common"
	gethCrypto "github.com/ethereum/go-ethereum/crypto"
	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/types"
)

type msgServer struct {
	Keeper
}

// NewMsgServerImpl returns an implementation of the MsgServer interface
// for the provided Keeper.
func NewMsgServerImpl(keeper Keeper) types.MsgServer {
	return &msgServer{Keeper: keeper}
}

func wallDurationToBlocks(wallDuration uint64) uint64 {
	// Deal durations are still stored as block units in state, but inputs are
	// documented as wall-time seconds at the API layer.
	return wallDuration
}

// Ensure msgServer implements the types.MsgServer interface
var _ types.MsgServer = msgServer{}

func parseOptionalManifestRootField(value string, label string) ([]byte, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil, nil
	}
	decoded, err := hex.DecodeString(strings.TrimPrefix(trimmed, "0x"))
	if err != nil || len(decoded) != 48 {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("%s must be empty or a 48-byte hex manifest root", label)
	}
	return decoded, nil
}

func manifestRootHexOrEmpty(root []byte) string {
	if len(root) == 0 {
		return ""
	}
	return "0x" + hex.EncodeToString(root)
}

func validatePreviousManifestRootMatch(previous []byte, current []byte) error {
	if bytes.Equal(previous, current) {
		return nil
	}
	return sdkerrors.ErrInvalidRequest.Wrapf(
		"stale previous_manifest_root (expected %s, got %s)",
		manifestRootHexOrEmpty(current),
		manifestRootHexOrEmpty(previous),
	)
}

// CreateDealFromEvm handles MsgCreateDealFromEvm to create a new storage deal
// from an EVM-signed intent bridged into polystorechaind.
func (k msgServer) CreateDealFromEvm(goCtx context.Context, msg *types.MsgCreateDealFromEvm) (*types.MsgCreateDealFromEvmResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	if msg.Intent == nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("intent is required")
	}
	intent := msg.Intent

	if intent.DurationBlocks == 0 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("Deal duration cannot be zero")
	}
	if intent.InitialEscrow.IsNil() || intent.InitialEscrow.IsNegative() {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid initial escrow amount: %s", intent.InitialEscrow)
	}
	if intent.MaxMonthlySpend.IsNil() || intent.MaxMonthlySpend.IsNegative() {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid max monthly spend: %s", intent.MaxMonthlySpend)
	}
	if strings.TrimSpace(intent.ChainId) == "" || strings.TrimSpace(intent.ChainId) != ctx.ChainID() {
		return nil, sdkerrors.ErrUnauthorized.Wrapf("intent chain_id %q does not match chain %q", intent.ChainId, ctx.ChainID())
	}

	if len(msg.EvmSignature) != 65 {
		return nil, sdkerrors.ErrUnauthorized.Wrap("invalid EVM signature length (expected 65 bytes)")
	}

	params := k.GetParams(ctx)
	eip712ChainID := new(big.Int).SetUint64(params.Eip712ChainId)
	domainSep := types.HashDomainSeparator(eip712ChainID)

	if params.MinDurationBlocks > 0 && intent.DurationBlocks < params.MinDurationBlocks {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("deal duration must be >= %d seconds", params.MinDurationBlocks)
	}

	structHash, err := types.HashCreateDeal(intent)

	if err != nil {

		return nil, sdkerrors.ErrInvalidRequest.Wrapf("failed to hash intent: %s", err)

	}

	digest := types.ComputeEIP712Digest(domainSep, structHash)

	// DEBUG: EIP-712 Tracing

	ctx.Logger().Info("DEBUG EIP-712 CreateDeal",

		"Intent", fmt.Sprintf("%+v", intent),

		"ChainID", eip712ChainID.String(),

		"DomainSep", domainSep.Hex(),

		"StructHash", structHash.Hex(),

		"Digest", fmt.Sprintf("%x", digest),

		"Signature", fmt.Sprintf("%x", msg.EvmSignature),
	)

	evmAddr, err := recoverEvmAddressFromDigest(digest, msg.EvmSignature)

	if err != nil {

		return nil, sdkerrors.ErrUnauthorized.Wrapf("failed to recover EVM signer: %s", err)

	}

	ctx.Logger().Info("DEBUG EIP-712 Recovery",

		"Recovered", evmAddr.Hex(),

		"Expected", intent.CreatorEvm,
	)

	creator := strings.ToLower(strings.TrimSpace(intent.CreatorEvm))
	if creator == "" {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("creator_evm is required")
	}
	if !strings.HasPrefix(creator, "0x") {
		creator = "0x" + creator
	}
	if strings.ToLower(evmAddr.Hex()) != creator {
		return nil, sdkerrors.ErrUnauthorized.Wrap("signature does not match creator_evm")
	}

	// Replay protection: enforce strictly increasing nonce per EVM address.
	evmKey := strings.ToLower(evmAddr.Hex())
	lastNonce, err := k.EvmNonces.Get(ctx, evmKey)
	if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return nil, fmt.Errorf("failed to load bridge nonce: %w", err)
	}
	if intent.Nonce <= lastNonce {
		return nil, sdkerrors.ErrUnauthorized.Wrap("bridge nonce must be strictly increasing")
	}
	if err := k.EvmNonces.Set(ctx, evmKey, intent.Nonce); err != nil {
		return nil, fmt.Errorf("failed to update bridge nonce: %w", err)
	}

	// Map EVM address -> Cosmos bech32 (same bytes, different prefix).
	ownerAcc := sdk.AccAddress(evmAddr.Bytes())
	ownerAddrStr := ownerAcc.String()

	// --- CREATION FEE ---
	if params.DealCreationFee.IsValid() && params.DealCreationFee.IsPositive() {
		if err := k.BankKeeper.SendCoinsFromAccountToModule(ctx, ownerAcc, authtypes.FeeCollectorName, sdk.NewCoins(params.DealCreationFee)); err != nil {
			return nil, fmt.Errorf("failed to pay deal creation fee: %w", err)
		}
	}

	// Decode service hint and requested replication (owner is derived from EVM).
	rawHint := strings.TrimSpace(intent.ServiceHint)
	parsedHint, err := types.ParseServiceHint(rawHint)
	if err != nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrap(err.Error())
	}
	serviceHintBase := parsedHint.Base
	requestedReplicas := uint64(0)
	redundancyMode := uint32(2)
	rsK := uint64(0)
	rsM := uint64(0)

	if parsedHint.HasRS {
		rsN := parsedHint.RSK + parsedHint.RSM
		if parsedHint.HasReplicas && parsedHint.Replicas != rsN {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("service_hint replicas must equal rs K+M")
		}
		rsK = parsedHint.RSK
		rsM = parsedHint.RSM
		requestedReplicas = rsN
	} else if parsedHint.HasReplicas {
		// Mode 1 (replicas-only) deals are deprecated; require Mode 2.
		return nil, sdkerrors.ErrInvalidRequest.Wrap("Mode 1 (replicas-only) is deprecated; specify rs=K+M or omit service_hint to auto-select Mode 2")
	} else {
		// No explicit RS profile: auto-select a balanced Mode 2 profile based on eligible providers.
		eligible, err := k.eligibleProviderCountForBaseHint(ctx, serviceHintBase)
		if err != nil {
			return nil, fmt.Errorf("failed to list eligible providers: %w", err)
		}
		rsK, rsM, err = autoSelectMode2Profile(eligible)
		if err != nil {
			return nil, sdkerrors.ErrInvalidRequest.Wrap(err.Error())
		}
		requestedReplicas = rsK + rsM
	}

	if serviceHintBase != "Hot" && serviceHintBase != "Cold" && serviceHintBase != "General" && serviceHintBase != "" {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid service hint: %s", serviceHintBase)
	}
	serviceHintBase = normalizeServiceHintBase(serviceHintBase)
	serviceHintRaw := types.BuildServiceHint(serviceHintBase, "", rsK, rsM)

	dealID, err := k.DealCount.Next(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get next deal ID: %w", err)
	}

	blockHash := ctx.BlockHeader().LastBlockId.Hash
	assignedProviders, err := k.AssignProviders(ctx, dealID, blockHash, serviceHintBase, requestedReplicas)
	if err != nil {
		return nil, fmt.Errorf("failed to assign providers: %w", err)
	}
	if uint64(len(assignedProviders)) != requestedReplicas {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("insufficient eligible providers for Mode 2 (need %d, got %d)", requestedReplicas, len(assignedProviders))
	}

	escrowCoins := sdk.NewCoins(sdk.NewCoin(sdk.DefaultBondDenom, intent.InitialEscrow))
	if err := k.BankKeeper.SendCoinsFromAccountToModule(ctx, ownerAcc, types.ModuleName, escrowCoins); err != nil {
		return nil, err
	}

	currentReplication := uint64(len(assignedProviders))
	height := uint64(ctx.BlockHeight())

	durationBlocks := wallDurationToBlocks(intent.DurationBlocks)
	deal := types.Deal{
		Id:                     dealID,
		ManifestRoot:           nil, // Empty initially
		Size_:                  0,   // Empty initially
		Owner:                  ownerAddrStr,
		EscrowBalance:          intent.InitialEscrow,
		StartBlock:             height,
		EndBlock:               height + durationBlocks,
		Providers:              assignedProviders,
		RedundancyMode:         redundancyMode,
		CurrentReplication:     currentReplication,
		ServiceHint:            serviceHintRaw,
		MaxMonthlySpend:        intent.MaxMonthlySpend,
		SpendWindowStartHeight: height,
		SpendWindowSpent:       math.NewInt(0),
		CurrentGen:             0,
		WitnessMdus:            0,
		PricingAnchorBlock:     height,
		RetrievalPolicy: types.RetrievalPolicy{
			Mode: types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_OWNER_ONLY,
		},
	}
	if redundancyMode == 2 {
		deal.Mode2Profile = &types.StripeReplicaProfile{
			K: uint32(rsK),
			M: uint32(rsM),
		}

		slots := make([]*types.DealSlot, 0, len(assignedProviders))
		for i, provider := range assignedProviders {
			slots = append(slots, &types.DealSlot{
				Slot:              uint32(i),
				Provider:          provider,
				Status:            types.SlotStatus_SLOT_STATUS_ACTIVE,
				PendingProvider:   "",
				StatusSinceHeight: ctx.BlockHeight(),
				RepairTargetGen:   0,
			})
		}
		deal.Mode2Slots = slots
	}

	if err := k.Deals.Set(ctx, dealID, deal); err != nil {
		return nil, fmt.Errorf("failed to set deal: %w", err)
	}

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			types.TypeMsgCreateDeal,
			sdk.NewAttribute(types.AttributeKeyDealID, fmt.Sprintf("%d", deal.Id)),
			sdk.NewAttribute(types.AttributeKeyOwner, deal.Owner),
			sdk.NewAttribute(types.AttributeKeyHint, deal.ServiceHint),
			sdk.NewAttribute(types.AttributeKeyAssignedProviders, fmt.Sprintf("%v", deal.Providers)),
		),
	)

	return &types.MsgCreateDealFromEvmResponse{
		DealId: deal.Id,
	}, nil
}

// RegisterProvider handles MsgRegisterProvider to create a new Storage Provider.
func (k msgServer) RegisterProvider(goCtx context.Context, msg *types.MsgRegisterProvider) (*types.MsgRegisterProviderResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	canonicalCreator, err := requireCanonicalProviderCreator(msg.Creator)
	if err != nil {
		return nil, err
	}

	if msg.Capabilities != "Archive" && msg.Capabilities != "General" && msg.Capabilities != "Edge" {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid capabilities: %s", msg.Capabilities)
	}

	endpoints, err := validateAndCanonicalizeProviderEndpoints(msg.Endpoints)
	if err != nil {
		return nil, err
	}

	_, err = k.Providers.Get(ctx, canonicalCreator)
	if err == nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("provider %s already registered", canonicalCreator)
	}
	if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return nil, err
	}

	// Create new Provider object
	provider := types.Provider{
		Address:         canonicalCreator,
		TotalStorage:    msg.TotalStorage,
		UsedStorage:     0, // Initially 0
		Capabilities:    msg.Capabilities,
		Status:          "Active", // Initially active
		ReputationScore: 100,      // Initial Score
		Endpoints:       endpoints,
	}

	if err := k.Providers.Set(ctx, provider.Address, provider); err != nil {
		return nil, fmt.Errorf("failed to set provider: %w", err)
	}

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			types.TypeMsgRegisterProvider,
			sdk.NewAttribute(types.AttributeKeyProvider, provider.Address),
			sdk.NewAttribute(types.AttributeKeyCapabilities, provider.Capabilities),
			sdk.NewAttribute(types.AttributeKeyTotalStorage, fmt.Sprintf("%d", provider.TotalStorage)),
		),
	)

	return &types.MsgRegisterProviderResponse{Success: true}, nil
}

func (k msgServer) UpdateProviderEndpoints(goCtx context.Context, msg *types.MsgUpdateProviderEndpoints) (*types.MsgUpdateProviderEndpointsResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)
	if msg == nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("invalid request")
	}

	canonicalCreator, err := requireCanonicalProviderCreator(msg.Creator)
	if err != nil {
		return nil, err
	}
	endpoints, err := validateAndCanonicalizeProviderEndpoints(msg.Endpoints)
	if err != nil {
		return nil, err
	}

	provider, err := k.Providers.Get(ctx, canonicalCreator)
	if err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return nil, sdkerrors.ErrNotFound.Wrap("provider not found")
		}
		return nil, err
	}
	provider.Endpoints = endpoints
	if err := k.Providers.Set(ctx, canonicalCreator, provider); err != nil {
		return nil, fmt.Errorf("failed to update provider endpoints: %w", err)
	}

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			types.TypeMsgUpdateProviderEndpoints,
			sdk.NewAttribute(types.AttributeKeyProvider, canonicalCreator),
		),
	)

	return &types.MsgUpdateProviderEndpointsResponse{Success: true}, nil
}

func (k msgServer) RequestProviderLink(goCtx context.Context, msg *types.MsgRequestProviderLink) (*types.MsgRequestProviderLinkResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)
	if msg == nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("invalid request")
	}

	provider, err := requireCanonicalAddress(msg.Creator, "creator")
	if err != nil {
		return nil, err
	}
	operator, err := canonicalAddress(msg.Operator, "operator")
	if err != nil {
		return nil, err
	}

	if _, err := k.ProviderPairings.Get(ctx, provider); err == nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("provider %s is already paired", provider)
	} else if !errors.Is(err, collections.ErrNotFound) {
		return nil, err
	}

	pending := types.PendingProviderLink{
		Provider:     provider,
		Operator:     operator,
		RequestedHeight: ctx.BlockHeight(),
	}
	if err := k.PendingProviderLinks.Set(ctx, provider, pending); err != nil {
		return nil, fmt.Errorf("failed to request provider link: %w", err)
	}

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			types.TypeMsgRequestProviderLink,
			sdk.NewAttribute(types.AttributeKeyProvider, provider),
			sdk.NewAttribute("operator", operator),
		),
	)

	return &types.MsgRequestProviderLinkResponse{Success: true}, nil
}

func (k msgServer) ApproveProviderLink(goCtx context.Context, msg *types.MsgApproveProviderLink) (*types.MsgApproveProviderLinkResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)
	if msg == nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("invalid request")
	}

	operator, err := requireCanonicalAddress(msg.Creator, "creator")
	if err != nil {
		return nil, err
	}
	provider, err := canonicalAddress(msg.Provider, "provider")
	if err != nil {
		return nil, err
	}

	if _, err := k.ProviderPairings.Get(ctx, provider); err == nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("provider %s is already paired", provider)
	} else if !errors.Is(err, collections.ErrNotFound) {
		return nil, err
	}

	pending, err := k.PendingProviderLinks.Get(ctx, provider)
	if err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return nil, sdkerrors.ErrNotFound.Wrap("pending provider link not found")
		}
		return nil, err
	}
	if pending.Operator != operator {
		return nil, sdkerrors.ErrUnauthorized.Wrapf("provider %s requested a different operator", provider)
	}

	pairing := types.ProviderPairing{
		Provider:     provider,
		Operator:     pending.Operator,
		PairedHeight: ctx.BlockHeight(),
	}
	if err := k.ProviderPairings.Set(ctx, provider, pairing); err != nil {
		return nil, fmt.Errorf("failed to store provider pairing: %w", err)
	}
	if err := k.ProviderPairingsByOperator.Set(ctx, collections.Join(pending.Operator, provider), true); err != nil {
		return nil, fmt.Errorf("failed to index provider pairing: %w", err)
	}
	if err := k.PendingProviderLinks.Remove(ctx, provider); err != nil {
		return nil, err
	}

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			types.TypeMsgApproveProviderLink,
			sdk.NewAttribute(types.AttributeKeyProvider, provider),
			sdk.NewAttribute("operator", pending.Operator),
		),
	)

	return &types.MsgApproveProviderLinkResponse{Success: true}, nil
}

func (k msgServer) CancelProviderLink(goCtx context.Context, msg *types.MsgCancelProviderLink) (*types.MsgCancelProviderLinkResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)
	if msg == nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("invalid request")
	}

	provider, err := requireCanonicalAddress(msg.Creator, "creator")
	if err != nil {
		return nil, err
	}

	pending, err := k.PendingProviderLinks.Get(ctx, provider)
	if err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return nil, sdkerrors.ErrNotFound.Wrap("pending provider link not found")
		}
		return nil, err
	}

	if err := k.PendingProviderLinks.Remove(ctx, provider); err != nil {
		return nil, err
	}

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			types.TypeMsgCancelProviderLink,
			sdk.NewAttribute(types.AttributeKeyProvider, provider),
			sdk.NewAttribute("operator", pending.Operator),
		),
	)

	return &types.MsgCancelProviderLinkResponse{Success: true}, nil
}

func (k msgServer) UnpairProvider(goCtx context.Context, msg *types.MsgUnpairProvider) (*types.MsgUnpairProviderResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)
	if msg == nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("invalid request")
	}

	creator, err := requireCanonicalAddress(msg.Creator, "creator")
	if err != nil {
		return nil, err
	}
	provider, err := canonicalAddress(msg.Provider, "provider")
	if err != nil {
		return nil, err
	}

	pairing, err := k.ProviderPairings.Get(ctx, provider)
	if err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return nil, sdkerrors.ErrNotFound.Wrap("provider pairing not found")
		}
		return nil, err
	}
	if creator != pairing.Operator && creator != pairing.Provider {
		return nil, sdkerrors.ErrUnauthorized.Wrap("creator is not authorized to unpair provider")
	}

	if err := k.ProviderPairings.Remove(ctx, provider); err != nil {
		return nil, err
	}
	if err := k.ProviderPairingsByOperator.Remove(ctx, collections.Join(pairing.Operator, provider)); err != nil && !errors.Is(err, collections.ErrNotFound) {
		return nil, err
	}

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			types.TypeMsgUnpairProvider,
			sdk.NewAttribute(types.AttributeKeyProvider, provider),
			sdk.NewAttribute("operator", pairing.Operator),
			sdk.NewAttribute("actor", creator),
		),
	)

	return &types.MsgUnpairProviderResponse{Success: true}, nil
}

// CreateDeal handles MsgCreateDeal to create a new storage deal.
func (k msgServer) CreateDeal(goCtx context.Context, msg *types.MsgCreateDeal) (*types.MsgCreateDealResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	creatorAddr, err := sdk.AccAddressFromBech32(msg.Creator)
	if err != nil {
		return nil, sdkerrors.ErrInvalidAddress.Wrapf("invalid creator address: %s", err)
	}

	params := k.GetParams(ctx)
	if params.MinDurationBlocks > 0 && msg.DurationBlocks < params.MinDurationBlocks {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("deal duration must be >= %d seconds", params.MinDurationBlocks)
	}

	// --- CREATION FEE ---
	if params.DealCreationFee.IsValid() && params.DealCreationFee.IsPositive() {
		if err := k.BankKeeper.SendCoinsFromAccountToModule(ctx, creatorAddr, authtypes.FeeCollectorName, sdk.NewCoins(params.DealCreationFee)); err != nil {
			return nil, fmt.Errorf("failed to pay deal creation fee: %w", err)
		}
	}

	dealID, err := k.DealCount.Next(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get next deal ID: %w", err)
	}

	// Decode any overrides embedded in the service hint.
	// Format used by the web gateway:
	//   "<Hint>[:owner=<polystoreAddress>][:rs=K+M]"
	// Note: Mode 1 (replicas-only) hints are deprecated; omit rs= to auto-select a balanced Mode 2 profile.
	rawHint := strings.TrimSpace(msg.ServiceHint)
	parsedHint, err := types.ParseServiceHint(rawHint)
	if err != nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrap(err.Error())
	}
	serviceHintBase := parsedHint.Base
	ownerAddrStr := msg.Creator
	ownerHint := ""
	requestedReplicas := uint64(0)
	redundancyMode := uint32(2)
	rsK := uint64(0)
	rsM := uint64(0)

	if parsedHint.Owner != "" {
		if _, err := sdk.AccAddressFromBech32(parsedHint.Owner); err != nil {
			return nil, sdkerrors.ErrInvalidAddress.Wrapf("invalid owner address in service hint: %s", parsedHint.Owner)
		}
		ownerAddrStr = parsedHint.Owner
		ownerHint = parsedHint.Owner
	}

	if parsedHint.HasRS {
		rsN := parsedHint.RSK + parsedHint.RSM
		if parsedHint.HasReplicas && parsedHint.Replicas != rsN {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("service_hint replicas must equal rs K+M")
		}
		rsK = parsedHint.RSK
		rsM = parsedHint.RSM
		requestedReplicas = rsN
	} else if parsedHint.HasReplicas {
		// Mode 1 (replicas-only) deals are deprecated; require Mode 2.
		return nil, sdkerrors.ErrInvalidRequest.Wrap("Mode 1 (replicas-only) is deprecated; specify rs=K+M or omit service_hint to auto-select Mode 2")
	} else {
		eligible, err := k.eligibleProviderCountForBaseHint(ctx, serviceHintBase)
		if err != nil {
			return nil, fmt.Errorf("failed to list eligible providers: %w", err)
		}
		rsK, rsM, err = autoSelectMode2Profile(eligible)
		if err != nil {
			return nil, sdkerrors.ErrInvalidRequest.Wrap(err.Error())
		}
		requestedReplicas = rsK + rsM
	}

	blockHash := ctx.BlockHeader().LastBlockId.Hash
	if serviceHintBase != "Hot" && serviceHintBase != "Cold" && serviceHintBase != "General" && serviceHintBase != "" {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid service hint: %s", serviceHintBase)
	}
	serviceHintBase = normalizeServiceHintBase(serviceHintBase)
	serviceHintRaw := types.BuildServiceHint(serviceHintBase, ownerHint, rsK, rsM)
	assignedProviders, err := k.AssignProviders(ctx, dealID, blockHash, serviceHintBase, requestedReplicas)
	if err != nil {
		return nil, fmt.Errorf("failed to assign providers: %w", err)
	}
	if uint64(len(assignedProviders)) != requestedReplicas {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("insufficient eligible providers for Mode 2 (need %d, got %d)", requestedReplicas, len(assignedProviders))
	}

	if msg.DurationBlocks == 0 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("Deal duration cannot be zero")
	}

	initialEscrowAmount := msg.InitialEscrowAmount
	if initialEscrowAmount.IsNil() || initialEscrowAmount.IsNegative() {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid initial escrow amount: %s", msg.InitialEscrowAmount)
	}
	maxMonthlySpend := msg.MaxMonthlySpend
	if maxMonthlySpend.IsNil() || maxMonthlySpend.IsNegative() {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid max monthly spend: %s", msg.MaxMonthlySpend)
	}

	escrowCoin := sdk.NewCoins(sdk.NewCoin(sdk.DefaultBondDenom, initialEscrowAmount))
	if err := k.BankKeeper.SendCoinsFromAccountToModule(ctx, creatorAddr, types.ModuleName, escrowCoin); err != nil {
		return nil, err
	}

	currentReplication := uint64(len(assignedProviders))
	height := uint64(ctx.BlockHeight())

	durationBlocks := wallDurationToBlocks(msg.DurationBlocks)
	deal := types.Deal{
		Id:                     dealID,
		ManifestRoot:           nil, // Empty
		Size_:                  0,   // Empty
		Owner:                  ownerAddrStr,
		EscrowBalance:          initialEscrowAmount,
		StartBlock:             height,
		EndBlock:               height + durationBlocks,
		Providers:              assignedProviders,
		RedundancyMode:         redundancyMode,
		CurrentReplication:     currentReplication,
		ServiceHint:            serviceHintRaw,
		MaxMonthlySpend:        maxMonthlySpend,
		SpendWindowStartHeight: height,
		SpendWindowSpent:       math.NewInt(0),
		CurrentGen:             0,
		WitnessMdus:            0,
		PricingAnchorBlock:     height,
		RetrievalPolicy: types.RetrievalPolicy{
			Mode: types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_OWNER_ONLY,
		},
	}
	if redundancyMode == 2 {
		deal.Mode2Profile = &types.StripeReplicaProfile{
			K: uint32(rsK),
			M: uint32(rsM),
		}

		slots := make([]*types.DealSlot, 0, len(assignedProviders))
		for i, provider := range assignedProviders {
			slots = append(slots, &types.DealSlot{
				Slot:              uint32(i),
				Provider:          provider,
				Status:            types.SlotStatus_SLOT_STATUS_ACTIVE,
				PendingProvider:   "",
				StatusSinceHeight: ctx.BlockHeight(),
				RepairTargetGen:   0,
			})
		}
		deal.Mode2Slots = slots
	}

	if err := k.Deals.Set(ctx, dealID, deal); err != nil {
		return nil, fmt.Errorf("failed to set deal: %w", err)
	}

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			types.TypeMsgCreateDeal,
			sdk.NewAttribute(types.AttributeKeyDealID, fmt.Sprintf("%d", deal.Id)),
			sdk.NewAttribute(types.AttributeKeyOwner, deal.Owner),
			sdk.NewAttribute(types.AttributeKeyHint, deal.ServiceHint),
			sdk.NewAttribute(types.AttributeKeyAssignedProviders, fmt.Sprintf("%v", deal.Providers)),
		),
	)

	return &types.MsgCreateDealResponse{
		DealId:            deal.Id,
		AssignedProviders: deal.Providers,
	}, nil
}

// UpdateDealContent allows a user to commit or update the manifest of a deal.
func (k msgServer) UpdateDealContent(goCtx context.Context, msg *types.MsgUpdateDealContent) (*types.MsgUpdateDealContentResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	creatorAddr, err := sdk.AccAddressFromBech32(msg.Creator)
	if err != nil {
		return nil, sdkerrors.ErrInvalidAddress.Wrapf("invalid creator address: %s", err)
	}

	deal, err := k.Deals.Get(ctx, msg.DealId)
	if err != nil {
		return nil, sdkerrors.ErrNotFound.Wrapf("deal %d not found", msg.DealId)
	}

	if deal.Owner != msg.Creator {
		return nil, sdkerrors.ErrUnauthorized.Wrapf("only deal owner %s can update content", deal.Owner)
	}

	height := uint64(ctx.BlockHeight())
	if height >= deal.EndBlock {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("deal %d expired at end_block=%d", msg.DealId, deal.EndBlock)
	}
	if msg.Size_ > types.MAX_DEAL_BYTES {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("size_bytes exceeds MAX_DEAL_BYTES (size=%d max=%d)", msg.Size_, types.MAX_DEAL_BYTES)
	}
	previousManifestRoot, err := parseOptionalManifestRootField(msg.PreviousManifestRoot, "previous_manifest_root")
	if err != nil {
		return nil, err
	}
	if err := validatePreviousManifestRootMatch(previousManifestRoot, deal.ManifestRoot); err != nil {
		return nil, err
	}

	params := k.GetParams(ctx)

	// --- TERM DEPOSIT (Storage Lock-in) ---
	if msg.Size_ > deal.Size_ {
		deltaSize := msg.Size_ - deal.Size_
		anchor := deal.PricingAnchorBlock
		if anchor == 0 {
			anchor = deal.StartBlock
		}
		if deal.EndBlock < anchor {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("invalid deal term: end_block < pricing_anchor_block")
		}
		duration := deal.EndBlock - anchor

		price := params.StoragePrice
		if price.IsPositive() {
			costDec := price.MulInt(math.NewIntFromUint64(deltaSize)).MulInt(math.NewIntFromUint64(duration))
			cost := costDec.Ceil().TruncateInt()

			if cost.IsPositive() {
				coins := sdk.NewCoins(sdk.NewCoin(sdk.DefaultBondDenom, cost))
				if err := k.BankKeeper.SendCoinsFromAccountToModule(ctx, creatorAddr, types.ModuleName, coins); err != nil {
					return nil, fmt.Errorf("failed to pay term deposit: %w", err)
				}
				deal.EscrowBalance = deal.EscrowBalance.Add(cost)
			}
		}
	}

	if strings.TrimSpace(msg.Cid) == "" {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("new content CID cannot be empty")
	}
	if msg.Size_ == 0 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("new content size cannot be zero")
	}
	if msg.TotalMdus == 0 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("total_mdus must be non-zero")
	}
	metaMdus := uint64(1) + msg.WitnessMdus
	if msg.TotalMdus <= metaMdus {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("total_mdus must exceed metadata mdus (got total_mdus=%d witness_mdus=%d)", msg.TotalMdus, msg.WitnessMdus)
	}

	// Append-only invariants (PolyFS on slab).
	if deal.TotalMdus != 0 && msg.TotalMdus < deal.TotalMdus {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("total_mdus cannot decrease (old=%d new=%d)", deal.TotalMdus, msg.TotalMdus)
	}
	if deal.TotalMdus != 0 && msg.WitnessMdus != deal.WitnessMdus {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("witness_mdus cannot change after first commit (old=%d new=%d)", deal.WitnessMdus, msg.WitnessMdus)
	}

	// Atomic Update
	manifestRoot, err := hex.DecodeString(strings.TrimPrefix(msg.Cid, "0x"))
	if err != nil || len(manifestRoot) != 48 {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid manifest root (must be 48-byte hex): %s", msg.Cid)
	}

	if !bytes.Equal(deal.ManifestRoot, manifestRoot) {
		deal.CurrentGen++
		if deal.RedundancyMode == 2 && deal.Mode2Profile != nil && len(deal.Mode2Slots) > 0 {
			for i, slot := range deal.Mode2Slots {
				if slot == nil {
					continue
				}
				if slot.Status == types.SlotStatus_SLOT_STATUS_REPAIRING {
					slot.RepairTargetGen = deal.CurrentGen
					deal.Mode2Slots[i] = slot
				}
			}
		}
	}
	deal.ManifestRoot = manifestRoot
	deal.Size_ = msg.Size_
	deal.TotalMdus = msg.TotalMdus
	deal.WitnessMdus = msg.WitnessMdus

	if err := k.Deals.Set(ctx, msg.DealId, deal); err != nil {
		return nil, fmt.Errorf("failed to update deal: %w", err)
	}

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			"update_deal_content", // Use string literal for new event type
			sdk.NewAttribute(types.AttributeKeyDealID, fmt.Sprintf("%d", deal.Id)),
			sdk.NewAttribute(types.AttributeKeyCID, msg.Cid),
			sdk.NewAttribute(types.AttributeKeySize, fmt.Sprintf("%d", deal.Size_)),
			sdk.NewAttribute("current_gen", fmt.Sprintf("%d", deal.CurrentGen)),
		),
	)

	return &types.MsgUpdateDealContentResponse{Success: true}, nil
}

// UpdateDealContentFromEvm allows a user to update deal content using an EVM-signed intent.
func (k msgServer) UpdateDealContentFromEvm(goCtx context.Context, msg *types.MsgUpdateDealContentFromEvm) (*types.MsgUpdateDealContentFromEvmResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	if msg.Intent == nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("intent is required")
	}
	intent := msg.Intent

	// Validation
	if strings.TrimSpace(intent.Cid) == "" {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("CID cannot be empty")
	}
	if intent.SizeBytes == 0 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("Size cannot be zero")
	}
	if intent.SizeBytes > types.MAX_DEAL_BYTES {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("size_bytes exceeds MAX_DEAL_BYTES (size=%d max=%d)", intent.SizeBytes, types.MAX_DEAL_BYTES)
	}
	previousManifestRoot, err := parseOptionalManifestRootField(intent.PreviousManifestRoot, "previous_manifest_root")
	if err != nil {
		return nil, err
	}
	if intent.TotalMdus == 0 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("total_mdus must be non-zero")
	}
	metaMdus := uint64(1) + intent.WitnessMdus
	if intent.TotalMdus <= metaMdus {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("total_mdus must exceed metadata mdus (got total_mdus=%d witness_mdus=%d)", intent.TotalMdus, intent.WitnessMdus)
	}
	if strings.TrimSpace(intent.ChainId) != ctx.ChainID() {
		return nil, sdkerrors.ErrUnauthorized.Wrapf("intent chain_id %q does not match chain %q", intent.ChainId, ctx.ChainID())
	}
	if len(msg.EvmSignature) != 65 {
		return nil, sdkerrors.ErrUnauthorized.Wrap("invalid EVM signature length")
	}

	params := k.GetParams(ctx)
	eip712ChainID := new(big.Int).SetUint64(params.Eip712ChainId)
	domainSep := types.HashDomainSeparator(eip712ChainID)
	structHash, err := types.HashUpdateContent(intent)
	if err != nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("failed to hash intent: %s", err)
	}

	digest := types.ComputeEIP712Digest(domainSep, structHash)

	ctx.Logger().Info("DEBUG EIP-712 UpdateContent",
		"Intent", fmt.Sprintf("%+v", intent),
		"ChainID", eip712ChainID.String(),
		"DomainSep", domainSep.Hex(),
		"StructHash", structHash.Hex(),
		"Digest", fmt.Sprintf("%x", digest),
		"Signature", fmt.Sprintf("%x", msg.EvmSignature),
	)

	evmAddr, err := recoverEvmAddressFromDigest(digest, msg.EvmSignature)
	if err != nil {
		return nil, sdkerrors.ErrUnauthorized.Wrapf("failed to recover EVM signer: %s", err)
	}
	ctx.Logger().Info("DEBUG EIP-712 Recovery (Update)",
		"Recovered", evmAddr.Hex(),
		"Expected", intent.CreatorEvm,
	)

	creator := strings.ToLower(strings.TrimSpace(intent.CreatorEvm))
	if creator == "" {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("creator_evm is required")
	}
	if !strings.HasPrefix(creator, "0x") {
		creator = "0x" + creator
	}
	if strings.ToLower(evmAddr.Hex()) != creator {
		return nil, sdkerrors.ErrUnauthorized.Wrap("signature does not match creator_evm")
	}

	// Replay protection: enforce strictly increasing nonce per EVM address.
	evmKey := strings.ToLower(evmAddr.Hex())
	lastNonce, err := k.EvmNonces.Get(ctx, evmKey)
	if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return nil, fmt.Errorf("failed to load bridge nonce: %w", err)
	}
	if intent.Nonce <= lastNonce {
		return nil, sdkerrors.ErrUnauthorized.Wrap("bridge nonce must be strictly increasing")
	}
	if err := k.EvmNonces.Set(ctx, evmKey, intent.Nonce); err != nil {
		return nil, fmt.Errorf("failed to update bridge nonce: %w", err)
	}

	// Map to Cosmos Address
	ownerAcc := sdk.AccAddress(evmAddr.Bytes())

	// Execute Update Logic
	// We call the internal logic directly to avoid resigning internal Msg
	deal, err := k.Deals.Get(ctx, intent.DealId)
	if err != nil {
		return nil, sdkerrors.ErrNotFound.Wrapf("deal %d not found", intent.DealId)
	}

	if deal.Owner != ownerAcc.String() {
		return nil, sdkerrors.ErrUnauthorized.Wrapf("only deal owner can update content")
	}
	if err := validatePreviousManifestRootMatch(previousManifestRoot, deal.ManifestRoot); err != nil {
		return nil, err
	}

	height := uint64(ctx.BlockHeight())
	if height >= deal.EndBlock {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("deal %d expired at end_block=%d", intent.DealId, deal.EndBlock)
	}

	// --- TERM DEPOSIT (Storage Lock-in) ---
	// Cost = (NewSize - OldSize) * Duration * Price
	// Only charge for size increase.
	if intent.SizeBytes > deal.Size_ {
		deltaSize := intent.SizeBytes - deal.Size_
		anchor := deal.PricingAnchorBlock
		if anchor == 0 {
			anchor = deal.StartBlock
		}
		if deal.EndBlock < anchor {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("invalid deal term: end_block < pricing_anchor_block")
		}
		duration := deal.EndBlock - anchor

		// price is Dec per byte per block
		price := params.StoragePrice
		if price.IsPositive() {
			costDec := price.MulInt(math.NewIntFromUint64(deltaSize)).MulInt(math.NewIntFromUint64(duration))
			cost := costDec.Ceil().TruncateInt()

			if cost.IsPositive() {
				coins := sdk.NewCoins(sdk.NewCoin(sdk.DefaultBondDenom, cost))
				// Deduct from Creator -> Module Account (Escrow)
				if err := k.BankKeeper.SendCoinsFromAccountToModule(ctx, ownerAcc, types.ModuleName, coins); err != nil {
					return nil, fmt.Errorf("failed to pay term deposit: %w", err)
				}
				// Credit the deal's escrow balance (Total Value Locked)
				deal.EscrowBalance = deal.EscrowBalance.Add(cost)
			}
		}
	}

	manifestRoot, err := hex.DecodeString(strings.TrimPrefix(intent.Cid, "0x"))
	if err != nil || len(manifestRoot) != 48 {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid manifest root: %s", intent.Cid)
	}

	if !bytes.Equal(deal.ManifestRoot, manifestRoot) {
		deal.CurrentGen++
		if deal.RedundancyMode == 2 && deal.Mode2Profile != nil && len(deal.Mode2Slots) > 0 {
			for i, slot := range deal.Mode2Slots {
				if slot == nil {
					continue
				}
				if slot.Status == types.SlotStatus_SLOT_STATUS_REPAIRING {
					slot.RepairTargetGen = deal.CurrentGen
					deal.Mode2Slots[i] = slot
				}
			}
		}
	}
	deal.ManifestRoot = manifestRoot
	deal.Size_ = intent.SizeBytes
	if deal.TotalMdus != 0 && intent.TotalMdus < deal.TotalMdus {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("total_mdus cannot decrease (old=%d new=%d)", deal.TotalMdus, intent.TotalMdus)
	}
	if deal.TotalMdus != 0 && intent.WitnessMdus != deal.WitnessMdus {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("witness_mdus cannot change after first commit (old=%d new=%d)", deal.WitnessMdus, intent.WitnessMdus)
	}
	deal.TotalMdus = intent.TotalMdus
	deal.WitnessMdus = intent.WitnessMdus

	if err := k.Deals.Set(ctx, intent.DealId, deal); err != nil {
		return nil, fmt.Errorf("failed to update deal: %w", err)
	}

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			"update_deal_content",
			sdk.NewAttribute(types.AttributeKeyDealID, fmt.Sprintf("%d", deal.Id)),
			sdk.NewAttribute(types.AttributeKeyCID, intent.Cid),
			sdk.NewAttribute(types.AttributeKeySize, fmt.Sprintf("%d", deal.Size_)),
			sdk.NewAttribute("current_gen", fmt.Sprintf("%d", deal.CurrentGen)),
		),
	)

	return &types.MsgUpdateDealContentFromEvmResponse{Success: true}, nil
}

// ProveLiveness handles MsgProveLiveness to verify KZG proofs and process rewards.
func (k msgServer) ProveLiveness(goCtx context.Context, msg *types.MsgProveLiveness) (*types.MsgProveLivenessResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	params := k.GetParams(ctx)
	if params.EpochLenBlocks == 0 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("epoch_len_blocks is 0 (unified liveness disabled)")
	}
	currentEpoch := epochIDAtHeight(ctx.BlockHeight(), params.EpochLenBlocks)
	if msg.EpochId == 0 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("epoch_id is required")
	}
	if msg.EpochId != currentEpoch {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("epoch_id must equal current epoch %d", currentEpoch)
	}
	epochSeed, err := k.epochSeed(ctx, currentEpoch)
	if err != nil {
		return nil, err
	}

	deal, err := k.Deals.Get(ctx, msg.DealId)
	if err != nil {
		return nil, sdkerrors.ErrNotFound.Wrapf("deal with ID %d not found", msg.DealId)
	}
	if uint64(ctx.BlockHeight()) >= deal.EndBlock {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("deal %d expired at end_block=%d", msg.DealId, deal.EndBlock)
	}

	stripe, err := stripeParamsForDeal(deal)
	if err != nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid service hint: %s", err.Error())
	}

	creator, err := requireCanonicalProviderCreator(msg.Creator)
	if err != nil {
		return nil, err
	}
	// Outer guardrail for deputy flows: only a registered provider may submit proofs.
	if _, err := k.Providers.Get(ctx, creator); err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return nil, sdkerrors.ErrUnauthorized.Wrapf("provider %s is not registered", creator)
		}
		return nil, err
	}

	_, isSystemProof := msg.ProofType.(*types.MsgProveLiveness_SystemProof)
	if isSystemProof {
		isAssignedProvider := false
		if stripe.mode == 2 && len(deal.Mode2Slots) > 0 {
			for _, slot := range deal.Mode2Slots {
				if slot == nil {
					continue
				}
				if strings.TrimSpace(slot.Provider) == creator {
					isAssignedProvider = true
					break
				}
				if slot.Status == types.SlotStatus_SLOT_STATUS_REPAIRING && strings.TrimSpace(slot.PendingProvider) == creator {
					isAssignedProvider = true
					break
				}
			}
		} else {
			for _, p := range deal.Providers {
				if strings.TrimSpace(p) == creator {
					isAssignedProvider = true
					break
				}
			}
		}
		if !isAssignedProvider {
			return nil, sdkerrors.ErrUnauthorized.Wrapf("provider %s is not assigned to deal %d", creator, msg.DealId)
		}

		if stripe.mode == 2 && deal.Mode2Profile != nil && len(deal.Mode2Slots) > 0 {
			slotIdx, ok := providerSlotIndex(deal, creator)
			if ok && int(slotIdx) < len(deal.Mode2Slots) {
				slot := deal.Mode2Slots[slotIdx]
				if slot != nil && slot.Status == types.SlotStatus_SLOT_STATUS_REPAIRING {
					// Make-before-break: allow the pending provider to submit system proofs so it
					// can satisfy quota and trigger an automatic swap. Disallow the outgoing
					// provider from continuing to claim liveness during repair.
					if strings.TrimSpace(slot.PendingProvider) == "" || strings.TrimSpace(slot.PendingProvider) != creator {
						return nil, sdkerrors.ErrInvalidRequest.Wrapf("slot %d is repairing; system proofs disabled for outgoing provider", slotIdx)
					}
				}
			}
		}
	}

	verifyChainedProof := func(chainedProof *types.ChainedProof, logInput bool, requireSlotAuth bool) (bool, error) {
		if chainedProof == nil {
			return false, nil
		}
		if len(chainedProof.ManifestOpening) != 48 || len(chainedProof.MduRootFr) != 32 ||
			len(chainedProof.BlobCommitment) != 48 || len(chainedProof.MerklePath) == 0 ||
			len(chainedProof.ZValue) != 32 || len(chainedProof.YValue) != 32 || len(chainedProof.KzgOpeningProof) != 48 {
			return false, nil
		}
		if len(deal.ManifestRoot) != 48 {
			return false, nil
		}
		if uint64(chainedProof.BlobIndex) >= stripe.leafCount {
			return false, nil
		}
		if stripe.mode == 2 && requireSlotAuth {
			slot, serr := leafSlotIndex(uint64(chainedProof.BlobIndex), stripe.rows)
			if serr != nil {
				return false, nil
			}

			if len(deal.Mode2Slots) > 0 {
				if int(slot) >= len(deal.Mode2Slots) {
					return false, nil
				}
				entry := deal.Mode2Slots[int(slot)]
				if entry == nil {
					return false, nil
				}

				expectedActive := strings.TrimSpace(entry.Provider)
				expectedPending := ""
				if entry.Status == types.SlotStatus_SLOT_STATUS_REPAIRING {
					expectedPending = strings.TrimSpace(entry.PendingProvider)
				}
				actual := creator
				allowed := false
				if actual != "" && expectedActive != "" && actual == expectedActive {
					allowed = true
				}
				if !allowed && actual != "" && expectedPending != "" && actual == expectedPending {
					allowed = true
				}
				if !allowed {
					return false, nil
				}
			} else {
				providerSlot, ok := providerSlotIndex(deal, creator)
				if !ok || providerSlot != slot {
					return false, nil
				}
			}
		}

		flattenedMerkle := make([]byte, 0, len(chainedProof.MerklePath)*32)
		for _, node := range chainedProof.MerklePath {
			if len(node) != 32 {
				return false, nil
			}
			flattenedMerkle = append(flattenedMerkle, node...)
		}

		if logInput {
			ctx.Logger().Info("VerifyChainedProof Input",
				"ManifestRoot", hex.EncodeToString(deal.ManifestRoot),
				"MduIndex", chainedProof.MduIndex,
				"MduRootFr", hex.EncodeToString(chainedProof.MduRootFr),
				"BlobCommitment", hex.EncodeToString(chainedProof.BlobCommitment),
				"BlobIndex", chainedProof.BlobIndex,
				"MerklePath", hex.EncodeToString(flattenedMerkle),
				"ZValue", hex.EncodeToString(chainedProof.ZValue),
				"YValue", hex.EncodeToString(chainedProof.YValue),
				"KzgOpening", hex.EncodeToString(chainedProof.KzgOpeningProof),
			)
		}

		v, err := crypto_ffi.VerifyChainedProof(
			deal.ManifestRoot,
			chainedProof.MduIndex,
			chainedProof.ManifestOpening,
			chainedProof.MduRootFr,
			chainedProof.BlobCommitment,
			uint64(chainedProof.BlobIndex),
			stripe.leafCount,
			flattenedMerkle,
			chainedProof.ZValue,
			chainedProof.YValue,
			chainedProof.KzgOpeningProof,
		)
		if err != nil {
			return false, err
		}
		return v, nil
	}

	epochStartHeight := int64(1)
	if msg.EpochId > 1 && params.EpochLenBlocks > 0 {
		epochStartHeight = int64((msg.EpochId-1)*params.EpochLenBlocks) + 1
	}
	hChallenge := epochStartHeight

	// 4. Calculate Tier based on block height latency
	hProof := ctx.BlockHeight()
	latency := hProof - hChallenge // Latency in blocks (Block difference from challenge start to proof inclusion)

	var tier uint32
	var rewardMultiplier math.LegacyDec
	tierName := "Fail"

	if latency <= 1 {
		tier = 0                                             // Platinum
		rewardMultiplier = math.LegacyNewDecWithPrec(100, 2) // 1.00
		tierName = "Platinum"
	} else if latency <= 5 {
		tier = 1                                            // Gold
		rewardMultiplier = math.LegacyNewDecWithPrec(80, 2) // 0.80
		tierName = "Gold"
	} else if latency <= 10 {
		tier = 2                                            // Silver
		rewardMultiplier = math.LegacyNewDecWithPrec(50, 2) // 0.50
		tierName = "Silver"
	} else {
		tier = 3                                           // Fail
		rewardMultiplier = math.LegacyNewDecWithPrec(0, 2) // 0.00
		tierName = "Fail"
		// Slashing already handled above for !valid proofs.
		// For valid but too slow proofs, no reward, potentially still a small slash based on spec.
	}

	// Update reputation for success
	if tier < 3 {
		provider, errGet := k.Providers.Get(ctx, creator)
		if errGet == nil {
			provider.ReputationScore += 1
			if errSet := k.Providers.Set(ctx, creator, provider); errSet != nil {
				ctx.Logger().Error("Failed to update provider reputation", "error", errSet)
			}
		}
	}

	// --- INFLATIONARY DECAY ---
	// BaseReward = 1 NIL * (1 / 2^(Height/Interval))
	initialReward := math.NewInt(1000000)
	decayFactor := uint64(ctx.BlockHeight()) / params.HalvingInterval

	// Using bit shifting for power of 2 division
	// However, math.Int doesn't support bit shifting directly in all versions easily or for large numbers
	// safer to use integer division: initialReward / 2^decayFactor

	// Calculate divisor: 2^decayFactor
	// Warning: decayFactor can be large, so 2^decayFactor might overflow uint64.
	// But HalvingInterval is 1000 blocks. If block time is 1s, 1000 blocks is ~16 mins.
	// 64 halvings is a lot. Effectively 0 reward.

	var decayedReward math.Int
	if decayFactor >= 64 {
		decayedReward = math.ZeroInt()
	} else {
		divisor := uint64(1) << decayFactor
		decayedReward = initialReward.Quo(math.NewIntFromUint64(divisor))
	}

	storageReward := math.LegacyNewDecFromInt(decayedReward).Mul(rewardMultiplier).TruncateInt()

	var bandwidthBytes uint64
	var isUserReceipt bool

	verifyRetrievalReceipt := func(receipt *types.RetrievalReceipt) error {
		if receipt == nil {
			return sdkerrors.ErrInvalidRequest.Wrap("receipt is required")
		}

		// Receipt/Tx envelope consistency (must-fail).
		if receipt.DealId != msg.DealId {
			return sdkerrors.ErrInvalidRequest.Wrap("receipt.deal_id must match msg.deal_id")
		}
		if receipt.EpochId != msg.EpochId {
			return sdkerrors.ErrInvalidRequest.Wrap("receipt.epoch_id must match msg.epoch_id")
		}
		if receipt.Provider != creator {
			return sdkerrors.ErrUnauthorized.Wrap("receipt.provider must match msg.creator")
		}

		filePath := strings.TrimSpace(receipt.FilePath)
		if filePath == "" {
			return sdkerrors.ErrInvalidRequest.Wrap("receipt.file_path is required")
		}
		if receipt.FilePath != filePath {
			return sdkerrors.ErrInvalidRequest.Wrap("receipt.file_path must be trimmed (no leading/trailing whitespace)")
		}
		if receipt.RangeLen == 0 {
			return sdkerrors.ErrInvalidRequest.Wrap("receipt.range_len must be non-zero")
		}
		if receipt.BytesServed != receipt.RangeLen {
			return sdkerrors.ErrInvalidRequest.Wrap("receipt.bytes_served must equal receipt.range_len")
		}

		// Anti-replay and expiry checks.
		if receipt.ExpiresAt != 0 && uint64(ctx.BlockHeight()) > receipt.ExpiresAt {
			return sdkerrors.ErrUnauthorized.Wrap("retrieval receipt expired")
		}
		lastNonce, err := k.ReceiptNoncesByDealFile.Get(ctx, collections.Join(receipt.DealId, filePath))
		if err != nil && !errors.Is(err, collections.ErrNotFound) {
			return fmt.Errorf("failed to load last receipt nonce: %w", err)
		}
		if receipt.Nonce <= lastNonce {
			return sdkerrors.ErrUnauthorized.Wrap("retrieval receipt nonce must be strictly increasing")
		}

		// Verify triple-proof.
		ok, err := verifyChainedProof(&receipt.ProofDetails, false, false)
		if err != nil {
			return sdkerrors.ErrUnauthorized.Wrapf("triple proof verification error: %s", err)
		}
		if !ok {
			return sdkerrors.ErrUnauthorized.Wrap("invalid liveness proof")
		}

		// Reconstruct signed message buffer (Cosmos signing path).
		// This is not EIP-712; it exists as a fallback for local keyring flows.
		buf := make([]byte, 0)
		buf = append(buf, sdk.Uint64ToBigEndian(receipt.DealId)...)
		buf = append(buf, sdk.Uint64ToBigEndian(receipt.EpochId)...)
		buf = append(buf, []byte(receipt.Provider)...)
		buf = append(buf, []byte(receipt.FilePath)...)
		buf = append(buf, sdk.Uint64ToBigEndian(receipt.RangeStart)...)
		buf = append(buf, sdk.Uint64ToBigEndian(receipt.RangeLen)...)
		buf = append(buf, sdk.Uint64ToBigEndian(receipt.BytesServed)...)
		buf = append(buf, sdk.Uint64ToBigEndian(receipt.Nonce)...)
		buf = append(buf, sdk.Uint64ToBigEndian(receipt.ExpiresAt)...)
		if proofHash, err := types.HashChainedProof(&receipt.ProofDetails); err == nil {
			buf = append(buf, proofHash.Bytes()...)
		}

		// Verification Logic.
		isValid := false

		// Attempt EIP-712 Recovery (if signature is 65 bytes)
		if len(receipt.UserSignature) == 65 {
			eip712ChainID := new(big.Int).SetUint64(params.Eip712ChainId)
			domainSep := types.HashDomainSeparator(eip712ChainID)

			// v3 hashing (range binding + proof_hash binding).
			if structHash, errHash := types.HashRetrievalReceiptV3(receipt); errHash == nil {
				digest := types.ComputeEIP712Digest(domainSep, structHash)
				if evmAddr, errRec := recoverEvmAddressFromDigest(digest, receipt.UserSignature); errRec == nil {
					signerAcc := sdk.AccAddress(evmAddr.Bytes())
					if signerAcc.String() == deal.Owner {
						isValid = true
					}
				}
			}
		}

		if !isValid {
			// Fallback to Cosmos Signature Verification.
			ownerAddr, err := sdk.AccAddressFromBech32(deal.Owner)
			if err != nil {
				return fmt.Errorf("invalid owner address: %w", err)
			}

			ownerAccount := k.AccountKeeper.GetAccount(ctx, ownerAddr)
			if ownerAccount == nil {
				return sdkerrors.ErrUnauthorized.Wrapf("owner account %s not found", deal.Owner)
			}
			pubKey := ownerAccount.GetPubKey()
			if pubKey != nil && pubKey.VerifySignature(buf, receipt.UserSignature) {
				isValid = true
			}
		}

		if !isValid {
			return sdkerrors.ErrUnauthorized.Wrap("invalid retrieval receipt signature")
		}

		// Update stored nonce after all checks.
		if err := k.ReceiptNoncesByDealFile.Set(ctx, collections.Join(receipt.DealId, filePath), receipt.Nonce); err != nil {
			return fmt.Errorf("failed to update receipt nonce: %w", err)
		}

		// Track bandwidth for escrow/payment accounting and UI heat stats.
		if bandwidthBytes > bandwidthBytes+receipt.BytesServed {
			return sdkerrors.ErrInvalidRequest.Wrap("receipt bytes overflow")
		}
		bandwidthBytes += receipt.BytesServed

		if err := k.IncrementHeat(ctx, deal.Id, receipt.BytesServed, false); err != nil {
			ctx.Logger().Error("failed to increment heat", "error", err)
		}

		if err := k.recordCreditForProof(ctx, msg.EpochId, deal, stripe, creator, receipt.ProofDetails.MduIndex, receipt.ProofDetails.BlobIndex); err != nil {
			return err
		}

		return nil
	}

	switch pt := msg.ProofType.(type) {
	case *types.MsgProveLiveness_SystemProof:
		ok, err := verifyChainedProof(pt.SystemProof, true, true)
		if err != nil {
			ctx.Logger().Error("Triple Proof Verification Error", "err", err)
			ok = false
		}
		if !ok {
			// Track health for system proofs that fail verification.
			k.trackProviderHealth(ctx, msg.DealId, creator, false)
			if pt.SystemProof != nil {
				extra := make([]byte, 0, 8+4)
				extra = binary.BigEndian.AppendUint64(extra, pt.SystemProof.MduIndex)
				extra = binary.BigEndian.AppendUint32(extra, pt.SystemProof.BlobIndex)
				kind := "system_proof_invalid"
				eid := deriveEvidenceID(kind, msg.DealId, msg.EpochId, extra)
				if err := k.recordEvidenceSummary(ctx, msg.DealId, creator, kind, eid[:], "chain", false); err != nil {
					ctx.Logger().Error("failed to record evidence summary", "error", err)
				}
			}
			return &types.MsgProveLivenessResponse{Success: false, Tier: 3 /* Fail */, RewardAmount: "0"}, nil
		}
		if pt.SystemProof != nil {
			if err := k.validateAndRecordSystemProof(ctx, msg.EpochId, epochSeed, params, deal, stripe, creator, pt.SystemProof.MduIndex, pt.SystemProof.BlobIndex); err != nil {
				// For system proofs, policy failures should not revert the tx: we want
				// the chain to record evidence and track health deterministically.
				if sdkerrors.ErrInvalidRequest.Is(err) {
					extra := make([]byte, 0, 8+4)
					extra = binary.BigEndian.AppendUint64(extra, pt.SystemProof.MduIndex)
					extra = binary.BigEndian.AppendUint32(extra, pt.SystemProof.BlobIndex)

					kind := "system_proof_rejected"
					evidenceOK := false
					penalize := true
					switch {
					case strings.Contains(err.Error(), "no synthetic proofs required"):
						kind = "system_proof_unneeded"
						evidenceOK = true
						penalize = false
					case strings.Contains(err.Error(), "quota already satisfied"):
						kind = "system_proof_redundant"
						evidenceOK = true
						penalize = false
					case strings.Contains(err.Error(), "does not match any required"):
						kind = "system_proof_wrong_challenge"
					case strings.Contains(err.Error(), "duplicate synthetic"):
						kind = "system_proof_duplicate"
						evidenceOK = true
						penalize = false
					case strings.Contains(err.Error(), "unauthorized provider"):
						kind = "system_proof_wrong_provider"
					}
					if penalize {
						k.trackProviderHealth(ctx, msg.DealId, creator, false)
					}
					eid := deriveEvidenceID(kind, msg.DealId, msg.EpochId, extra)
					if errEvidence := k.recordEvidenceSummary(ctx, msg.DealId, creator, kind, eid[:], "chain", evidenceOK); errEvidence != nil {
						ctx.Logger().Error("failed to record evidence summary", "error", errEvidence)
					}

					return &types.MsgProveLivenessResponse{Success: false, Tier: 3 /* Fail */, RewardAmount: "0"}, nil
				}
				return nil, err
			}
		}
	case *types.MsgProveLiveness_UserReceipt:
		isUserReceipt = true
		if err := verifyRetrievalReceipt(pt.UserReceipt); err != nil {
			return nil, err
		}
	case *types.MsgProveLiveness_UserReceiptBatch:
		isUserReceipt = true
		if pt.UserReceiptBatch == nil || len(pt.UserReceiptBatch.Receipts) == 0 {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("receipt batch is empty")
		}
		for _, receipt := range pt.UserReceiptBatch.Receipts {
			r := receipt // copy to avoid pointer reuse in loop
			if err := verifyRetrievalReceipt(&r); err != nil {
				return nil, err
			}
		}
	case *types.MsgProveLiveness_SessionProof:
		isUserReceipt = true
		if pt.SessionProof == nil {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("session_proof is required")
		}
		receipt := pt.SessionProof.SessionReceipt

		// Receipt/Tx envelope consistency (must-fail).
		if receipt.DealId != msg.DealId {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("session_receipt.deal_id must match msg.deal_id")
		}
		if receipt.EpochId != msg.EpochId {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("session_receipt.epoch_id must match msg.epoch_id")
		}
		if receipt.Provider != creator {
			return nil, sdkerrors.ErrUnauthorized.Wrap("session_receipt.provider must match msg.creator")
		}

		filePath := strings.TrimSpace(receipt.FilePath)
		if filePath == "" {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("session_receipt.file_path is required")
		}
		if receipt.FilePath != filePath {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("session_receipt.file_path must be trimmed (no leading/trailing whitespace)")
		}
		if receipt.TotalBytes == 0 {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("session_receipt.total_bytes must be non-zero")
		}
		if receipt.ChunkCount == 0 {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("session_receipt.chunk_count must be non-zero")
		}
		if len(receipt.ChunkLeafRoot) != 32 {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("session_receipt.chunk_leaf_root must be 32 bytes")
		}

		// Anti-replay and expiry checks.
		if receipt.ExpiresAt != 0 && uint64(ctx.BlockHeight()) > receipt.ExpiresAt {
			return nil, sdkerrors.ErrUnauthorized.Wrap("download session receipt expired")
		}
		lastNonce, err := k.ReceiptNoncesByDealFile.Get(ctx, collections.Join(receipt.DealId, filePath))
		if err != nil && !errors.Is(err, collections.ErrNotFound) {
			return nil, fmt.Errorf("failed to load last receipt nonce: %w", err)
		}
		if receipt.Nonce <= lastNonce {
			return nil, sdkerrors.ErrUnauthorized.Wrap("download session receipt nonce must be strictly increasing")
		}

		// Verify user signature (EIP-712 only).
		if len(receipt.UserSignature) != 65 {
			return nil, sdkerrors.ErrUnauthorized.Wrap("invalid user signature length (expected 65 bytes)")
		}
		{
			eip712ChainID := new(big.Int).SetUint64(params.Eip712ChainId)
			domainSep := types.HashDomainSeparator(eip712ChainID)
			structHash, err := types.HashDownloadSessionReceipt(&receipt)
			if err != nil {
				return nil, sdkerrors.ErrInvalidRequest.Wrapf("failed to hash session receipt: %s", err)
			}
			digest := types.ComputeEIP712Digest(domainSep, structHash)
			evmAddr, err := recoverEvmAddressFromDigest(digest, receipt.UserSignature)
			if err != nil {
				return nil, sdkerrors.ErrUnauthorized.Wrapf("failed to recover EVM signer: %s", err)
			}
			signerAcc := sdk.AccAddress(evmAddr.Bytes())
			if signerAcc.String() != deal.Owner {
				return nil, sdkerrors.ErrUnauthorized.Wrap("session receipt signature does not match deal owner")
			}
		}

		chunks := pt.SessionProof.Chunks
		if uint64(len(chunks)) != receipt.ChunkCount {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("session_proof.chunks length must equal session_receipt.chunk_count")
		}

		root := gethCommon.BytesToHash(receipt.ChunkLeafRoot)
		seenLeaves := make(map[uint32]struct{}, len(chunks))
		var totalBytes uint64

		for _, chunk := range chunks {
			if chunk.RangeLen == 0 {
				return nil, sdkerrors.ErrInvalidRequest.Wrap("session chunk range_len must be non-zero")
			}
			if chunk.LeafIndex >= uint32(receipt.ChunkCount) {
				return nil, sdkerrors.ErrInvalidRequest.Wrap("session chunk leaf_index out of bounds")
			}
			if _, ok := seenLeaves[chunk.LeafIndex]; ok {
				return nil, sdkerrors.ErrInvalidRequest.Wrap("duplicate session chunk leaf_index")
			}
			seenLeaves[chunk.LeafIndex] = struct{}{}

			// Verify triple-proof.
			ok, err := verifyChainedProof(&chunk.ProofDetails, false, false)
			if err != nil {
				return nil, sdkerrors.ErrUnauthorized.Wrapf("triple proof verification error: %s", err)
			}
			if !ok {
				return nil, sdkerrors.ErrUnauthorized.Wrap("invalid liveness proof")
			}

			proofHash, err := types.HashChainedProof(&chunk.ProofDetails)
			if err != nil {
				return nil, sdkerrors.ErrInvalidRequest.Wrapf("failed to hash chained proof: %s", err)
			}
			leaf := types.HashSessionLeaf(chunk.RangeStart, chunk.RangeLen, proofHash)
			if !types.VerifyKeccakMerklePath(root, leaf, chunk.LeafIndex, chunk.MerklePath) {
				return nil, sdkerrors.ErrUnauthorized.Wrap("invalid session chunk merkle proof")
			}

			if totalBytes > totalBytes+chunk.RangeLen {
				return nil, sdkerrors.ErrInvalidRequest.Wrap("session bytes overflow")
			}
			totalBytes += chunk.RangeLen

			if bandwidthBytes > bandwidthBytes+chunk.RangeLen {
				return nil, sdkerrors.ErrInvalidRequest.Wrap("session bytes overflow")
			}
			bandwidthBytes += chunk.RangeLen

			if err := k.IncrementHeat(ctx, deal.Id, chunk.RangeLen, false); err != nil {
				ctx.Logger().Error("failed to increment heat", "error", err)
			}

			if err := k.recordCreditForProof(ctx, msg.EpochId, deal, stripe, creator, chunk.ProofDetails.MduIndex, chunk.ProofDetails.BlobIndex); err != nil {
				return nil, err
			}
		}

		if totalBytes != receipt.TotalBytes {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("session proof total_bytes mismatch")
		}

		// Update stored nonce after all checks.
		if err := k.ReceiptNoncesByDealFile.Set(ctx, collections.Join(receipt.DealId, filePath), receipt.Nonce); err != nil {
			return nil, fmt.Errorf("failed to update receipt nonce: %w", err)
		}
	default:
		return nil, sdkerrors.ErrInvalidRequest.Wrap("invalid proof type")
	}

	var bandwidthPayment math.Int
	if isUserReceipt {
		// Bandwidth payment (devnet): charge proportional to bytes served so that
		// chunked (blob-sized) receipts don't exhaust escrow immediately.
		//
		// Units are the base denom (micro-NIL). Current placeholder pricing:
		//   1 unit per KiB (rounded up).
		const bytesPerUnit = uint64(1024)
		units := (bandwidthBytes + bytesPerUnit - 1) / bytesPerUnit
		if units == 0 {
			units = 1
		}
		bandwidthPayment = math.NewIntFromUint64(units)

		newEscrowBalance := deal.EscrowBalance.Sub(bandwidthPayment)
		if newEscrowBalance.IsNegative() {
			return nil, sdkerrors.ErrInsufficientFunds.Wrapf("deal %d escrow exhausted", msg.DealId)
		}
		deal.EscrowBalance = newEscrowBalance
	} else {
		bandwidthPayment = math.NewInt(0)
	}

	totalReward := storageReward.Add(bandwidthPayment)

	// --- REWARD ACCUMULATION ---
	if totalReward.IsPositive() {
		// Accumulate to ProviderRewards store
		currentRewards, err := k.ProviderRewards.Get(ctx, creator)
		if err != nil {
			if !errors.Is(err, collections.ErrNotFound) {
				return nil, err
			}
			currentRewards = math.ZeroInt()
		}

		newRewards := currentRewards.Add(totalReward)
		if err := k.ProviderRewards.Set(ctx, creator, newRewards); err != nil {
			return nil, fmt.Errorf("failed to set provider rewards: %w", err)
		}

		// Note: We are NOT minting coins yet. Coins are minted on Withdraw.
		// BUT wait, BandwidthPayment comes from Escrow (User -> Module).
		// StorageReward comes from Inflation (Mint).
		// If we mix them, we need to be careful.
		// For Bandwidth, funds are already in Module Account (escrow).
		// For Storage, funds don't exist yet.

		// Strategy: Keep accounting virtual.
		// For Bandwidth: We already deducted from Deal.EscrowBalance (which is just a number field in the Deal struct).
		// The actual tokens are in the 'polystorechain' module account.
		// So we effectively "moved" claim from Deal to ProviderReward.
		// For Storage: We will mint when withdrawing.
	}

	if err := k.Deals.Set(ctx, msg.DealId, deal); err != nil {
		return nil, fmt.Errorf("failed to update deal state: %w", err)
	}

	if err := k.DealProviderStatus.Set(ctx, collections.Join(msg.DealId, creator), uint64(ctx.BlockHeight())); err != nil {
		return nil, fmt.Errorf("failed to update proof status: %w", err)
	}

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			types.TypeMsgProveLiveness,
			sdk.NewAttribute(types.AttributeKeyProvider, creator),
			sdk.NewAttribute(types.AttributeKeyDealID, fmt.Sprintf("%d", msg.DealId)),
			sdk.NewAttribute(types.AttributeKeySuccess, "true"),
			sdk.NewAttribute(types.AttributeKeyTier, tierName),
			sdk.NewAttribute(types.AttributeKeyRewardAmount, totalReward.String()),
		),
	)

	// Record successful proof for liveness/performance observability.
	if err := k.recordProofSummary(ctx, creator, msg, deal, tierName, true); err != nil {
		ctx.Logger().Error("failed to record proof summary", "error", err)
	}

	// Update minimal health stub: successful proof resets failure counters for
	// this (deal, provider) pair and logs health as "OK" for devnet.
	k.trackProviderHealth(ctx, msg.DealId, creator, true)

	return &types.MsgProveLivenessResponse{Success: true, Tier: tier, RewardAmount: totalReward.String()}, nil
}

// recordProofSummary stores a lightweight Proof summary in state so that the
// web UI can render recent liveness/performance events via the existing
// ListProofs query.
func (k msgServer) recordProofSummary(ctx sdk.Context, creator string, msg *types.MsgProveLiveness, deal types.Deal, tierName string, ok bool) error {
	proofID, err := k.ProofCount.Next(ctx)
	if err != nil {
		return fmt.Errorf("failed to get next proof id: %w", err)
	}

	summary := types.Proof{
		Id:          proofID,
		Creator:     creator,
		Commitment:  fmt.Sprintf("deal:%d/epoch:%d/tier:%s", msg.DealId, msg.EpochId, tierName),
		Valid:       ok,
		BlockHeight: ctx.BlockHeight(),
	}

	if err := k.Proofs.Set(ctx, proofID, summary); err != nil {
		return fmt.Errorf("failed to store proof summary: %w", err)
	}

	return nil
}

// trackProviderHealth maintains a minimal per-(Deal, Provider) health stub for
// Phase 3.4. It does not affect rewards or slashing; it only keeps a small
// failure counter and logs when a pair would be considered "degraded" under a
// full HealthState-based eviction policy.
func (k msgServer) trackProviderHealth(ctx sdk.Context, dealID uint64, provider string, proofOK bool) {
	key := collections.Join(dealID, provider)

	if proofOK {
		// Reset failure counter on success.
		if err := k.DealProviderFailures.Remove(ctx, key); err != nil && !errors.Is(err, collections.ErrNotFound) {
			ctx.Logger().Error("failed to reset provider failure counter", "deal", dealID, "provider", provider, "error", err)
		}
		return
	}

	// Increment failure counter on invalid proof.
	current, err := k.DealProviderFailures.Get(ctx, key)
	if err != nil && !errors.Is(err, collections.ErrNotFound) {
		ctx.Logger().Error("failed to get provider failure counter", "deal", dealID, "provider", provider, "error", err)
	}
	failures := current + 1
	if err := k.DealProviderFailures.Set(ctx, key, failures); err != nil {
		ctx.Logger().Error("failed to update provider failure counter", "deal", dealID, "provider", provider, "error", err)
		return
	}

	// Log when the failure count crosses a small threshold. This is purely
	// informational and gives operators a sense of which pairs would be
	// considered for eviction in a mainnet-grade HealthState implementation.
	const failureThreshold uint64 = 3
	if failures == failureThreshold {
		ctx.Logger().Info(
			"provider health degraded for deal; would consider eviction in full self-healing mode",
			"deal", dealID,
			"provider", provider,
			"failures", failures,
		)

		// PoC eviction outcome for Mode 2: when a provider repeatedly submits bad
		// proofs, start a make-before-break slot repair by attaching a pending
		// replacement provider. This avoids blocking reads/writes in the gateway.
		deal, err := k.Deals.Get(ctx, dealID)
		if err != nil {
			ctx.Logger().Error("failed to load deal for provider health eviction", "deal", dealID, "provider", provider, "error", err)
			return
		}
		if deal.RedundancyMode != 2 || deal.Mode2Profile == nil || len(deal.Mode2Slots) == 0 {
			return
		}
		slotIdxU64, ok := providerSlotIndex(deal, provider)
		if !ok || int(slotIdxU64) >= len(deal.Mode2Slots) {
			return
		}
		slot := uint32(slotIdxU64)
		entry := deal.Mode2Slots[slot]
		if entry == nil || entry.Status != types.SlotStatus_SLOT_STATUS_ACTIVE {
			return
		}
		if strings.TrimSpace(entry.PendingProvider) != "" {
			return
		}

		params := k.GetParams(ctx)
		epochID := epochIDAtHeight(ctx.BlockHeight(), params.EpochLenBlocks)

		pending, err := k.selectMode2ReplacementProvider(ctx, deal, slot, epochID)
		if err != nil {
			ctx.Logger().Error("failed to select replacement provider for health eviction", "deal", dealID, "slot", slotIdxU64, "error", err)
			return
		}

		entry.Status = types.SlotStatus_SLOT_STATUS_REPAIRING
		entry.PendingProvider = strings.TrimSpace(pending)
		entry.StatusSinceHeight = ctx.BlockHeight()
		entry.RepairTargetGen = deal.CurrentGen
		deal.Mode2Slots[slot] = entry

		if err := k.Deals.Set(ctx, dealID, deal); err != nil {
			ctx.Logger().Error("failed to persist deal after health eviction", "deal", dealID, "error", err)
			return
		}
		_ = k.Mode2MissedEpochs.Remove(ctx, collections.Join(dealID, slot))

		extra := make([]byte, 0, 4)
		extra = binary.BigEndian.AppendUint32(extra, slot)
		eid := deriveEvidenceID("provider_degraded_repair_started", dealID, epochID, extra)
		if err := k.recordEvidenceSummary(ctx, dealID, provider, "provider_degraded_repair_started", eid[:], "chain", false); err != nil {
			ctx.Logger().Error("failed to record evidence summary", "error", err)
		}

		ctx.Logger().Info(
			"slot repair started due to provider health failures",
			"deal", dealID,
			"slot", slotIdxU64,
			"provider", provider,
			"pending_provider", entry.PendingProvider,
			"repair_target_gen", entry.RepairTargetGen,
		)
	}
}

// SignalSaturation handles MsgSignalSaturation to trigger pre-emptive scaling.
func (k msgServer) SignalSaturation(goCtx context.Context, msg *types.MsgSignalSaturation) (*types.MsgSignalSaturationResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	deal, err := k.Deals.Get(ctx, msg.DealId)
	if err != nil {
		return nil, sdkerrors.ErrNotFound.Wrapf("deal with ID %d not found", msg.DealId)
	}
	if uint64(ctx.BlockHeight()) >= deal.EndBlock {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("deal %d expired at end_block=%d", msg.DealId, deal.EndBlock)
	}

	isAssigned := false
	for _, p := range deal.Providers {
		if p == msg.Creator {
			isAssigned = true
			break
		}
	}
	if !isAssigned {
		return nil, sdkerrors.ErrUnauthorized.Wrapf("only assigned providers can signal saturation")
	}

	// --- ELASTICITY CAPS (RFC: Pricing & Escrow Accounting §6) ---
	params := k.GetParams(ctx)
	height := uint64(ctx.BlockHeight())
	if deal.SpendWindowStartHeight == 0 {
		deal.SpendWindowStartHeight = height
	}
	if deal.SpendWindowSpent.IsNil() {
		deal.SpendWindowSpent = math.NewInt(0)
	}

	monthLen := params.MonthLenBlocks
	if monthLen > 0 && height >= deal.SpendWindowStartHeight+monthLen {
		deal.SpendWindowStartHeight = height
		deal.SpendWindowSpent = math.NewInt(0)
	}

	elasticityCost := math.NewIntFromUint64(params.BaseStripeCost).Mul(math.NewIntFromUint64(types.DealBaseReplication))
	newSpent := deal.SpendWindowSpent.Add(elasticityCost)
	if newSpent.GT(deal.MaxMonthlySpend) {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("scaling denied: window spend %s + cost %s exceeds max monthly spend %s", deal.SpendWindowSpent, elasticityCost, deal.MaxMonthlySpend)
	}
	if deal.EscrowBalance.LT(elasticityCost) {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("scaling denied: escrow balance %s is below cost %s", deal.EscrowBalance, elasticityCost)
	}

	blockHash := ctx.BlockHeader().LastBlockId.Hash
	derivedID := deal.Id + (deal.CurrentReplication * 1000)

	newProviders, err := k.AssignProviders(ctx, derivedID, blockHash, "Hot", types.DealBaseReplication)
	if err != nil {
		return nil, fmt.Errorf("failed to assign new hot stripe: %w", err)
	}

	deal.Providers = append(deal.Providers, newProviders...)
	deal.CurrentReplication += types.DealBaseReplication
	deal.EscrowBalance = deal.EscrowBalance.Sub(elasticityCost)
	deal.SpendWindowSpent = newSpent

	if err := k.Deals.Set(ctx, deal.Id, deal); err != nil {
		return nil, fmt.Errorf("failed to update deal with new stripe: %w", err)
	}

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			types.TypeMsgSignalSaturation,
			sdk.NewAttribute(types.AttributeKeyDealID, fmt.Sprintf("%d", deal.Id)),
			sdk.NewAttribute("new_stripe_index", fmt.Sprintf("%d", (deal.CurrentReplication/types.DealBaseReplication))),
			sdk.NewAttribute("new_providers", fmt.Sprintf("%v", newProviders)),
			sdk.NewAttribute("elasticity_cost", elasticityCost.String()),
			sdk.NewAttribute("spend_window_spent", deal.SpendWindowSpent.String()),
		),
	)

	return &types.MsgSignalSaturationResponse{
		Success:      true,
		Message:      fmt.Sprintf("Saturation processed. New stripe added."),
		NewProviders: newProviders,
	}, nil
}

// AddCredit allows a user to top up the escrow balance for a deal.
func (k msgServer) AddCredit(goCtx context.Context, msg *types.MsgAddCredit) (*types.MsgAddCreditResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	senderAddr, err := sdk.AccAddressFromBech32(msg.Creator)
	if err != nil {
		return nil, sdkerrors.ErrInvalidAddress.Wrapf("invalid sender address: %s", err)
	}

	deal, err := k.Deals.Get(ctx, msg.DealId)
	if err != nil {
		return nil, sdkerrors.ErrNotFound.Wrapf("deal %d not found", msg.DealId)
	}
	if uint64(ctx.BlockHeight()) >= deal.EndBlock {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("deal %d expired at end_block=%d", msg.DealId, deal.EndBlock)
	}

	amount := msg.Amount
	if amount.IsNil() || amount.IsNegative() {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("invalid amount")
	}

	coins := sdk.NewCoins(sdk.NewCoin(sdk.DefaultBondDenom, amount))
	if err := k.BankKeeper.SendCoinsFromAccountToModule(ctx, senderAddr, types.ModuleName, coins); err != nil {
		return nil, err
	}

	deal.EscrowBalance = deal.EscrowBalance.Add(amount)
	if err := k.Deals.Set(ctx, msg.DealId, deal); err != nil {
		return nil, err
	}

	return &types.MsgAddCreditResponse{NewBalance: deal.EscrowBalance}, nil
}

// ExtendDeal extends a deal's end_block by charging spot storage_price for the
// currently committed bytes. See `rfcs/rfc-deal-expiry-and-extension.md`.
func (k msgServer) ExtendDeal(goCtx context.Context, msg *types.MsgExtendDeal) (*types.MsgExtendDealResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)
	if msg == nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("invalid request")
	}
	if msg.AdditionalDurationBlocks == 0 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("additional_duration_blocks (seconds) must be > 0")
	}

	deal, err := k.Deals.Get(ctx, msg.DealId)
	if err != nil {
		return nil, sdkerrors.ErrNotFound.Wrapf("deal %d not found", msg.DealId)
	}
	if strings.TrimSpace(msg.Creator) != deal.Owner {
		return nil, sdkerrors.ErrUnauthorized.Wrap("only deal owner may extend deal")
	}

	params := k.GetParams(ctx)
	h := uint64(ctx.BlockHeight())

	deleteAfter, overflow := addUint64(deal.EndBlock, params.DealExtensionGraceBlocks)
	if overflow {
		// Treat overflow as "infinite" grace for purposes of this check.
		deleteAfter = ^uint64(0)
	}
	if h > deleteAfter {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("deal %d is past renewal grace window", msg.DealId)
	}

	base := deal.EndBlock
	if h > base {
		base = h
	}
	additionalDurationBlocks := wallDurationToBlocks(msg.AdditionalDurationBlocks)
	newEnd, overflow := addUint64(base, additionalDurationBlocks)
	if overflow {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("end_block overflow")
	}

	// Charge spot price for existing bytes over the extension window.
	cost := math.ZeroInt()
	price := params.StoragePrice
	if price.IsPositive() && deal.Size_ > 0 {
		costDec := price.
			MulInt(math.NewIntFromUint64(deal.Size_)).
			MulInt(math.NewIntFromUint64(additionalDurationBlocks))
		cost = costDec.Ceil().TruncateInt()
	}

	if cost.IsPositive() {
		ownerAddr, err := sdk.AccAddressFromBech32(msg.Creator)
		if err != nil {
			return nil, sdkerrors.ErrInvalidAddress.Wrap("invalid creator address")
		}
		coins := sdk.NewCoins(sdk.NewCoin(sdk.DefaultBondDenom, cost))
		if err := k.BankKeeper.SendCoinsFromAccountToModule(ctx, ownerAddr, types.ModuleName, coins); err != nil {
			return nil, err
		}
		deal.EscrowBalance = deal.EscrowBalance.Add(cost)
	}

	deal.EndBlock = newEnd
	deal.PricingAnchorBlock = h
	if err := k.Deals.Set(ctx, msg.DealId, deal); err != nil {
		return nil, err
	}

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			"extend_deal",
			sdk.NewAttribute(types.AttributeKeyDealID, fmt.Sprintf("%d", deal.Id)),
			sdk.NewAttribute("new_end_block", fmt.Sprintf("%d", deal.EndBlock)),
			sdk.NewAttribute("extension_cost", cost.String()),
		),
	)

	return &types.MsgExtendDealResponse{Success: true, NewEndBlock: deal.EndBlock}, nil
}

// WithdrawRewards allows a Storage Provider to withdraw accumulated rewards.
func (k msgServer) WithdrawRewards(goCtx context.Context, msg *types.MsgWithdrawRewards) (*types.MsgWithdrawRewardsResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	creator, err := requireCanonicalProviderCreator(msg.Creator)
	if err != nil {
		return nil, err
	}
	providerAddr, err := sdk.AccAddressFromBech32(creator)
	if err != nil {
		return nil, sdkerrors.ErrInvalidAddress.Wrapf("invalid provider address: %s", err)
	}

	rewards, err := k.ProviderRewards.Get(ctx, creator)
	if err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return nil, sdkerrors.ErrNotFound.Wrap("no rewards found")
		}
		return nil, err
	}

	if rewards.IsZero() || rewards.IsNegative() {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("no rewards to withdraw")
	}

	// Mint tokens
	// Wait, if the rewards came from Deal Escrow (Bandwidth), they are already in the module account (sent from User).
	// If they are Storage Rewards (Inflation), they need to be minted.
	// We didn't track which portion is which in `ProviderRewards`.
	// Simplification for Phase 4: Assume ALL withdrawals are minted?
	// NO, that would double-mint bandwidth payments (user paid -> module -> mint -> provider = inflation + user payment).
	// We need to burn user payment and mint new? Or just transfer user payment?

	// Correct logic:
	// 1. Bandwidth fees are in Module Account.
	// 2. Storage rewards are virtual (inflationary).
	// BUT we combined them into one `totalReward` int.
	// To support mixed model, we should probably just MINT everything for now, assuming `Escrow` burn logic is handled elsewhere or ignored.
	// OR, we rely on the fact that `Escrow` deduction happens in `ProveLiveness`.
	// `deal.EscrowBalance` was reduced. But the coins are still in `polystorechain` module account.
	// So `polystorechain` module account holds:
	// - Escrowed funds (waiting to be paid out)
	// - Slashed funds (waiting to be burned)

	// If we simply TRANSFER from Module to Provider, we use the existing Escrowed funds.
	// But Storage Rewards (Inflation) are NOT in the module account yet.
	// So we run out of funds if we just Transfer.

	// Solution:
	// Mint the portion that is Inflationary? We lost that distinction.
	// Easy fix: Mint the *entire* amount to the module account first, then transfer?
	// No, that inflates by Bandwidth amount too.

	// Let's assume for Phase 4:
	// The Module Account "has infinite supply" via Minting capability.
	// We Mint coins equal to `rewards` and send to Provider.
	// AND we Burn coins equal to `BandwidthPayment` from the Module Account?
	// This is getting complicated.

	// Simplest working model for Testnet:
	// Just MINT the rewards.
	// The Escrow deduction in `ProveLiveness` effectively "burns" the user's claim to those tokens, leaving them stranded in the Module Account (effectively burned/treasury).
	// And we Mint fresh tokens for the provider.
	// This results in: User loses X. Provider gains X + Y (inflation).
	// Net result: Supply change = +Y.
	// The "stranded" tokens in Module Account can be burned explicitly later or considered "community pool".

	coins := sdk.NewCoins(sdk.NewCoin(sdk.DefaultBondDenom, rewards))
	if err := k.BankKeeper.MintCoins(ctx, types.ModuleName, coins); err != nil {
		return nil, err
	}
	if err := k.BankKeeper.SendCoinsFromModuleToAccount(ctx, types.ModuleName, providerAddr, coins); err != nil {
		return nil, err
	}

	// Reset rewards
	if err := k.ProviderRewards.Set(ctx, creator, math.ZeroInt()); err != nil {
		return nil, err
	}

	return &types.MsgWithdrawRewardsResponse{AmountWithdrawn: rewards}, nil
}

func (k msgServer) OpenRetrievalSession(goCtx context.Context, msg *types.MsgOpenRetrievalSession) (*types.MsgOpenRetrievalSessionResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)
	if msg == nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("invalid request")
	}
	if len(msg.ManifestRoot) != 48 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("manifest_root must be 48 bytes")
	}
	if msg.BlobCount == 0 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("blob_count must be > 0")
	}

	deal, err := k.Deals.Get(ctx, msg.DealId)
	if err != nil {
		return nil, sdkerrors.ErrNotFound.Wrapf("deal with ID %d not found", msg.DealId)
	}
	if msg.Creator != deal.Owner {
		return nil, sdkerrors.ErrUnauthorized.Wrap("only deal owner may open retrieval sessions")
	}
	height := uint64(ctx.BlockHeight())
	if height >= deal.EndBlock {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("deal %d expired at end_block=%d", msg.DealId, deal.EndBlock)
	}
	if len(deal.ManifestRoot) != 48 || !bytesEqual(deal.ManifestRoot, msg.ManifestRoot) {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("manifest_root does not match current deal state")
	}

	isAssignedProvider := false
	if deal.RedundancyMode == 2 && len(deal.Mode2Slots) > 0 {
		for _, slot := range deal.Mode2Slots {
			if slot == nil {
				continue
			}
			if strings.TrimSpace(slot.Provider) == strings.TrimSpace(msg.Provider) {
				isAssignedProvider = true
				break
			}
			if strings.TrimSpace(slot.PendingProvider) != "" && strings.TrimSpace(slot.PendingProvider) == strings.TrimSpace(msg.Provider) {
				isAssignedProvider = true
				break
			}
		}
	} else {
		for _, p := range deal.Providers {
			if p == msg.Provider {
				isAssignedProvider = true
				break
			}
		}
	}
	if !isAssignedProvider {
		return nil, sdkerrors.ErrUnauthorized.Wrapf("provider %s is not assigned to deal %d", msg.Provider, msg.DealId)
	}

	stripe, err := stripeParamsForDeal(deal)
	if err != nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid service hint: %s", err.Error())
	}

	if msg.StartBlobIndex >= uint32(stripe.leafCount) {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("start_blob_index out of range")
	}
	startGlobal := msg.StartMduIndex*stripe.leafCount + uint64(msg.StartBlobIndex)
	endGlobal, overflow := addUint64(startGlobal, msg.BlobCount)
	if overflow {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("blob range overflow")
	}
	if stripe.mode == 2 {
		if msg.BlobCount == 0 {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("blob_count must be > 0")
		}
		endIndex := uint64(msg.StartBlobIndex) + msg.BlobCount - 1
		if endIndex >= stripe.leafCount {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("blob range exceeds leaf_count")
		}
		startSlot, serr := leafSlotIndex(uint64(msg.StartBlobIndex), stripe.rows)
		if serr != nil {
			return nil, sdkerrors.ErrInvalidRequest.Wrap(serr.Error())
		}
		endSlot, serr := leafSlotIndex(endIndex, stripe.rows)
		if serr != nil {
			return nil, sdkerrors.ErrInvalidRequest.Wrap(serr.Error())
		}
		if startSlot != endSlot {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("blob range must stay within a single slot in Mode 2")
		}
		providerSlot, ok := providerSlotIndex(deal, msg.Provider)
		if !ok || providerSlot != startSlot {
			return nil, sdkerrors.ErrUnauthorized.Wrap("provider does not match slot for blob range")
		}
	}
	if deal.TotalMdus != 0 {
		if msg.StartMduIndex >= deal.TotalMdus {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("start_mdu_index out of range")
		}
		maxGlobal := deal.TotalMdus * stripe.leafCount
		if endGlobal > maxGlobal {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("blob range exceeds deal content")
		}
	}

	totalBytes, overflow := mulUint64(msg.BlobCount, types.BlobSizeBytes)
	if overflow {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("total_bytes overflow")
	}

	expiresAt := msg.ExpiresAt
	if expiresAt == 0 {
		// Legacy clients omit expires_at. Cap sessions at the deal term so they
		// cannot outlive paid storage.
		expiresAt = deal.EndBlock
	}
	if expiresAt > deal.EndBlock {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("expires_at must be <= deal end_block")
	}
	if expiresAt < height {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("expires_at must be >= current height")
	}

	ownerAddr, err := sdk.AccAddressFromBech32(msg.Creator)
	if err != nil {
		return nil, sdkerrors.ErrInvalidAddress.Wrap("invalid creator address")
	}
	providerAddr, err := sdk.AccAddressFromBech32(msg.Provider)
	if err != nil {
		return nil, sdkerrors.ErrInvalidAddress.Wrap("invalid provider address")
	}

	params := k.GetParams(ctx)
	baseFee := params.BaseRetrievalFee
	variableFee := math.ZeroInt()
	if params.RetrievalPricePerBlob.IsValid() && params.RetrievalPricePerBlob.Amount.IsPositive() {
		variableFee = params.RetrievalPricePerBlob.Amount.Mul(math.NewIntFromUint64(msg.BlobCount))
	}
	totalFee := variableFee.Add(baseFee.Amount)
	if totalFee.IsPositive() {
		newEscrow := deal.EscrowBalance.Sub(totalFee)
		if newEscrow.IsNegative() {
			return nil, sdkerrors.ErrInsufficientFunds.Wrapf("deal %d escrow insufficient for retrieval fees", msg.DealId)
		}
		if baseFee.Amount.IsPositive() {
			feeCoins := sdk.NewCoins(baseFee)
			if err := k.BankKeeper.BurnCoins(ctx, types.ModuleName, feeCoins); err != nil {
				return nil, fmt.Errorf("failed to burn base retrieval fee: %w", err)
			}
		}
		deal.EscrowBalance = newEscrow
		if err := k.Deals.Set(ctx, msg.DealId, deal); err != nil {
			return nil, fmt.Errorf("failed to update deal escrow: %w", err)
		}
	}

	nonceKey := collections.Join(collections.Join(msg.Creator, msg.DealId), msg.Provider)
	lastNonce, err := k.RetrievalSessionNonces.Get(ctx, nonceKey)
	if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return nil, err
	}
	if msg.Nonce <= lastNonce {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("nonce replay rejected")
	}

	sessionID, err := types.HashRetrievalSessionID(
		ownerAddr.Bytes(),
		msg.DealId,
		providerAddr.Bytes(),
		msg.ManifestRoot,
		msg.StartMduIndex,
		msg.StartBlobIndex,
		msg.BlobCount,
		msg.Nonce,
		expiresAt,
	)
	if err != nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("failed to compute session_id: %s", err)
	}

	session := types.RetrievalSession{
		SessionId:      sessionID,
		DealId:         msg.DealId,
		Owner:          msg.Creator,
		Provider:       msg.Provider,
		ManifestRoot:   msg.ManifestRoot,
		StartMduIndex:  msg.StartMduIndex,
		StartBlobIndex: msg.StartBlobIndex,
		BlobCount:      msg.BlobCount,
		TotalBytes:     totalBytes,
		Nonce:          msg.Nonce,
		ExpiresAt:      expiresAt,
		OpenedHeight:   ctx.BlockHeight(),
		UpdatedHeight:  ctx.BlockHeight(),
		Status:         types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_OPEN,
		LockedFee:      variableFee,
		Purpose:        types.RetrievalSessionPurpose_RETRIEVAL_SESSION_PURPOSE_USER,
		Funding:        types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_DEAL_ESCROW,
		Payer:          "",
	}

	if err := k.RetrievalSessions.Set(ctx, sessionID, session); err != nil {
		return nil, fmt.Errorf("failed to store retrieval session: %w", err)
	}
	if err := k.RetrievalSessionsByOwner.Set(ctx, collections.Join(msg.Creator, sessionID), uint64(ctx.BlockHeight())); err != nil {
		return nil, fmt.Errorf("failed to index retrieval session by owner: %w", err)
	}
	if err := k.RetrievalSessionsByProvider.Set(ctx, collections.Join(msg.Provider, sessionID), uint64(ctx.BlockHeight())); err != nil {
		return nil, fmt.Errorf("failed to index retrieval session by provider: %w", err)
	}
	if err := k.RetrievalSessionNonces.Set(ctx, nonceKey, msg.Nonce); err != nil {
		return nil, fmt.Errorf("failed to update retrieval session nonce: %w", err)
	}

	if err := k.recordRetrievalDemand(ctx, msg.BlobCount); err != nil {
		return nil, err
	}

	return &types.MsgOpenRetrievalSessionResponse{SessionId: sessionID}, nil
}

func normalizeRetrievalPolicyMode(mode types.RetrievalPolicyMode) types.RetrievalPolicyMode {
	switch mode {
	case types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_OWNER_ONLY,
		types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_ALLOWLIST,
		types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_VOUCHER,
		types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_ALLOWLIST_OR_VOUCHER,
		types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_PUBLIC:
		return mode
	case types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_UNSPECIFIED:
		return types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_OWNER_ONLY
	default:
		// Be conservative on unknown enum values.
		return types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_OWNER_ONLY
	}
}

func (k msgServer) UpdateDealRetrievalPolicy(goCtx context.Context, msg *types.MsgUpdateDealRetrievalPolicy) (*types.MsgUpdateDealRetrievalPolicyResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)
	if msg == nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("invalid request")
	}

	deal, err := k.Deals.Get(ctx, msg.DealId)
	if err != nil {
		return nil, sdkerrors.ErrNotFound.Wrapf("deal %d not found", msg.DealId)
	}
	if strings.TrimSpace(msg.Creator) != strings.TrimSpace(deal.Owner) {
		return nil, sdkerrors.ErrUnauthorized.Wrap("only deal owner may update retrieval policy")
	}
	if uint64(ctx.BlockHeight()) >= deal.EndBlock {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("deal %d expired at end_block=%d", msg.DealId, deal.EndBlock)
	}

	p := msg.Policy
	p.Mode = normalizeRetrievalPolicyMode(p.Mode)

	allowRoot := p.AllowlistRoot
	if allowRoot != nil && len(allowRoot) != 32 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("allowlist_root must be 32 bytes when set")
	}
	// Enforce required root for allowlist modes.
	if (p.Mode == types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_ALLOWLIST ||
		p.Mode == types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_ALLOWLIST_OR_VOUCHER) && len(allowRoot) != 32 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("allowlist_root is required for allowlist modes")
	}
	if (p.Mode == types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_OWNER_ONLY ||
		p.Mode == types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_PUBLIC ||
		p.Mode == types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_VOUCHER) && len(allowRoot) != 0 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("allowlist_root must be empty for this mode")
	}

	if strings.TrimSpace(p.VoucherSigner) != "" {
		if _, err := sdk.AccAddressFromBech32(strings.TrimSpace(p.VoucherSigner)); err != nil {
			return nil, sdkerrors.ErrInvalidAddress.Wrap("invalid voucher_signer")
		}
	}

	deal.RetrievalPolicy = p
	if err := k.Deals.Set(ctx, msg.DealId, deal); err != nil {
		return nil, fmt.Errorf("failed to update deal: %w", err)
	}
	return &types.MsgUpdateDealRetrievalPolicyResponse{Success: true}, nil
}

func (k msgServer) OpenRetrievalSessionSponsored(goCtx context.Context, msg *types.MsgOpenRetrievalSessionSponsored) (*types.MsgOpenRetrievalSessionSponsoredResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)
	if msg == nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("invalid request")
	}
	if len(msg.ManifestRoot) != 48 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("manifest_root must be 48 bytes")
	}
	if msg.BlobCount == 0 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("blob_count must be > 0")
	}
	if msg.MaxTotalFee.IsNil() || msg.MaxTotalFee.IsNegative() {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("max_total_fee must be >= 0")
	}

	deal, err := k.Deals.Get(ctx, msg.DealId)
	if err != nil {
		return nil, sdkerrors.ErrNotFound.Wrapf("deal with ID %d not found", msg.DealId)
	}
	height := uint64(ctx.BlockHeight())
	if height >= deal.EndBlock {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("deal %d expired at end_block=%d", msg.DealId, deal.EndBlock)
	}
	if len(deal.ManifestRoot) != 48 || !bytesEqual(deal.ManifestRoot, msg.ManifestRoot) {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("manifest_root does not match current deal state")
	}

	isAssignedProvider := false
	if deal.RedundancyMode == 2 && len(deal.Mode2Slots) > 0 {
		for _, slot := range deal.Mode2Slots {
			if slot == nil {
				continue
			}
			if strings.TrimSpace(slot.Provider) == strings.TrimSpace(msg.Provider) {
				isAssignedProvider = true
				break
			}
			if strings.TrimSpace(slot.PendingProvider) != "" && strings.TrimSpace(slot.PendingProvider) == strings.TrimSpace(msg.Provider) {
				isAssignedProvider = true
				break
			}
		}
	} else {
		for _, p := range deal.Providers {
			if p == msg.Provider {
				isAssignedProvider = true
				break
			}
		}
	}
	if !isAssignedProvider {
		return nil, sdkerrors.ErrUnauthorized.Wrapf("provider %s is not assigned to deal %d", msg.Provider, msg.DealId)
	}

	stripe, err := stripeParamsForDeal(deal)
	if err != nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid service hint: %s", err.Error())
	}

	if msg.StartBlobIndex >= uint32(stripe.leafCount) {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("start_blob_index out of range")
	}
	startGlobal := msg.StartMduIndex*stripe.leafCount + uint64(msg.StartBlobIndex)
	endGlobal, overflow := addUint64(startGlobal, msg.BlobCount)
	if overflow {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("blob range overflow")
	}
	if stripe.mode == 2 {
		endIndex := uint64(msg.StartBlobIndex) + msg.BlobCount - 1
		if endIndex >= stripe.leafCount {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("blob range exceeds leaf_count")
		}
		startSlot, serr := leafSlotIndex(uint64(msg.StartBlobIndex), stripe.rows)
		if serr != nil {
			return nil, sdkerrors.ErrInvalidRequest.Wrap(serr.Error())
		}
		endSlot, serr := leafSlotIndex(endIndex, stripe.rows)
		if serr != nil {
			return nil, sdkerrors.ErrInvalidRequest.Wrap(serr.Error())
		}
		if startSlot != endSlot {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("blob range must stay within a single slot in Mode 2")
		}
		providerSlot, ok := providerSlotIndex(deal, msg.Provider)
		if !ok || providerSlot != startSlot {
			return nil, sdkerrors.ErrUnauthorized.Wrap("provider does not match slot for blob range")
		}
	}
	if deal.TotalMdus != 0 {
		if msg.StartMduIndex >= deal.TotalMdus {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("start_mdu_index out of range")
		}
		maxGlobal := deal.TotalMdus * stripe.leafCount
		if endGlobal > maxGlobal {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("blob range exceeds deal content")
		}
	}

	totalBytes, overflow := mulUint64(msg.BlobCount, types.BlobSizeBytes)
	if overflow {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("total_bytes overflow")
	}

	expiresAt := msg.ExpiresAt
	if expiresAt == 0 {
		expiresAt = deal.EndBlock
	}
	if expiresAt > deal.EndBlock {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("expires_at must be <= deal end_block")
	}
	if expiresAt < height {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("expires_at must be >= current height")
	}

	creatorAddr, err := sdk.AccAddressFromBech32(msg.Creator)
	if err != nil {
		return nil, sdkerrors.ErrInvalidAddress.Wrap("invalid creator address")
	}
	providerAddr, err := sdk.AccAddressFromBech32(msg.Provider)
	if err != nil {
		return nil, sdkerrors.ErrInvalidAddress.Wrap("invalid provider address")
	}

	// --- Sponsored authorization ---
	mode := normalizeRetrievalPolicyMode(deal.RetrievalPolicy.Mode)
	if mode == types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_OWNER_ONLY {
		// Owner-only deals must use the owner-paid path to avoid ambiguity about settlement semantics.
		return nil, sdkerrors.ErrUnauthorized.Wrap("sponsored retrieval sessions are not allowed for owner-only deals")
	}
	if strings.TrimSpace(msg.Creator) != strings.TrimSpace(deal.Owner) {
		switch mode {
		case types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_PUBLIC:
			// ok
		case types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_ALLOWLIST:
			ap := msg.GetAllowlistProof()
			if ap == nil {
				return nil, sdkerrors.ErrUnauthorized.Wrap("allowlist proof is required")
			}
			if len(deal.RetrievalPolicy.AllowlistRoot) != 32 {
				return nil, sdkerrors.ErrInvalidRequest.Wrap("deal missing allowlist_root")
			}
			root := gethCommon.BytesToHash(deal.RetrievalPolicy.AllowlistRoot)
			leaf := gethCrypto.Keccak256Hash(creatorAddr.Bytes())
			if !types.VerifyKeccakMerklePath(root, leaf, ap.LeafIndex, ap.MerklePath) {
				return nil, sdkerrors.ErrUnauthorized.Wrap("invalid allowlist proof")
			}

		case types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_VOUCHER:
			v := msg.GetVoucher()
			if v == nil {
				return nil, sdkerrors.ErrUnauthorized.Wrap("voucher is required")
			}
			if err := k.verifyAndConsumeVoucher(ctx, &deal, msg, v); err != nil {
				return nil, err
			}

		case types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_ALLOWLIST_OR_VOUCHER:
			ap := msg.GetAllowlistProof()
			v := msg.GetVoucher()
			ok := false
			if ap != nil {
				if len(deal.RetrievalPolicy.AllowlistRoot) != 32 {
					return nil, sdkerrors.ErrInvalidRequest.Wrap("deal missing allowlist_root")
				}
				root := gethCommon.BytesToHash(deal.RetrievalPolicy.AllowlistRoot)
				leaf := gethCrypto.Keccak256Hash(creatorAddr.Bytes())
				ok = types.VerifyKeccakMerklePath(root, leaf, ap.LeafIndex, ap.MerklePath)
			}
			if !ok && v != nil {
				if err := k.verifyAndConsumeVoucher(ctx, &deal, msg, v); err == nil {
					ok = true
				} else {
					// Only surface voucher errors if allowlist proof wasn't provided or failed.
					return nil, err
				}
			}
			if !ok {
				return nil, sdkerrors.ErrUnauthorized.Wrap("allowlist proof or voucher is required")
			}

		default:
			return nil, sdkerrors.ErrUnauthorized.Wrap("unsupported retrieval policy mode")
		}
	}

	// --- Fee computation ---
	params := k.GetParams(ctx)
	baseFee := params.BaseRetrievalFee
	variableFee := math.ZeroInt()
	if params.RetrievalPricePerBlob.IsValid() && params.RetrievalPricePerBlob.Amount.IsPositive() {
		variableFee = params.RetrievalPricePerBlob.Amount.Mul(math.NewIntFromUint64(msg.BlobCount))
	}
	totalFee := variableFee.Add(baseFee.Amount)
	if msg.MaxTotalFee.IsPositive() && totalFee.GT(msg.MaxTotalFee) {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("total fee exceeds max_total_fee")
	}

	if totalFee.IsPositive() {
		feeCoins := sdk.NewCoins(sdk.NewCoin(sdk.DefaultBondDenom, totalFee))
		if err := k.BankKeeper.SendCoinsFromAccountToModule(ctx, creatorAddr, types.ModuleName, feeCoins); err != nil {
			return nil, fmt.Errorf("failed to collect sponsored retrieval fees: %w", err)
		}
		if baseFee.Amount.IsPositive() {
			burnCoins := sdk.NewCoins(baseFee)
			if err := k.BankKeeper.BurnCoins(ctx, types.ModuleName, burnCoins); err != nil {
				return nil, fmt.Errorf("failed to burn base retrieval fee: %w", err)
			}
		}
	}

	nonceKey := collections.Join(collections.Join(msg.Creator, msg.DealId), msg.Provider)
	lastNonce, err := k.RetrievalSessionNonces.Get(ctx, nonceKey)
	if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return nil, err
	}
	if msg.Nonce <= lastNonce {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("nonce replay rejected")
	}

	sessionID, err := types.HashRetrievalSessionID(
		creatorAddr.Bytes(),
		msg.DealId,
		providerAddr.Bytes(),
		msg.ManifestRoot,
		msg.StartMduIndex,
		msg.StartBlobIndex,
		msg.BlobCount,
		msg.Nonce,
		expiresAt,
	)
	if err != nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("failed to compute session_id: %s", err)
	}

	session := types.RetrievalSession{
		SessionId:      sessionID,
		DealId:         msg.DealId,
		Owner:          msg.Creator,
		Provider:       msg.Provider,
		ManifestRoot:   msg.ManifestRoot,
		StartMduIndex:  msg.StartMduIndex,
		StartBlobIndex: msg.StartBlobIndex,
		BlobCount:      msg.BlobCount,
		TotalBytes:     totalBytes,
		Nonce:          msg.Nonce,
		ExpiresAt:      expiresAt,
		OpenedHeight:   ctx.BlockHeight(),
		UpdatedHeight:  ctx.BlockHeight(),
		Status:         types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_OPEN,
		LockedFee:      variableFee,
		Purpose:        types.RetrievalSessionPurpose_RETRIEVAL_SESSION_PURPOSE_USER,
		Funding:        types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_REQUESTER,
		Payer:          msg.Creator,
	}

	if err := k.RetrievalSessions.Set(ctx, sessionID, session); err != nil {
		return nil, fmt.Errorf("failed to store retrieval session: %w", err)
	}
	if err := k.RetrievalSessionsByOwner.Set(ctx, collections.Join(msg.Creator, sessionID), uint64(ctx.BlockHeight())); err != nil {
		return nil, fmt.Errorf("failed to index retrieval session by owner: %w", err)
	}
	if err := k.RetrievalSessionsByProvider.Set(ctx, collections.Join(msg.Provider, sessionID), uint64(ctx.BlockHeight())); err != nil {
		return nil, fmt.Errorf("failed to index retrieval session by provider: %w", err)
	}
	if err := k.RetrievalSessionNonces.Set(ctx, nonceKey, msg.Nonce); err != nil {
		return nil, fmt.Errorf("failed to update retrieval session nonce: %w", err)
	}

	if err := k.recordRetrievalDemand(ctx, msg.BlobCount); err != nil {
		return nil, err
	}

	return &types.MsgOpenRetrievalSessionSponsoredResponse{SessionId: sessionID}, nil
}

func (k msgServer) OpenProtocolRetrievalSession(goCtx context.Context, msg *types.MsgOpenProtocolRetrievalSession) (*types.MsgOpenProtocolRetrievalSessionResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)
	if msg == nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("invalid request")
	}
	if len(msg.ManifestRoot) != 48 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("manifest_root must be 48 bytes")
	}
	if msg.BlobCount == 0 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("blob_count must be > 0")
	}
	if msg.MaxTotalFee.IsNil() || msg.MaxTotalFee.IsNegative() {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("max_total_fee must be >= 0")
	}

	creator, err := requireCanonicalProviderCreator(msg.Creator)
	if err != nil {
		return nil, err
	}
	// Protocol sessions are opened by protocol actors (providers) and should not be open to arbitrary accounts.
	if _, err := k.Providers.Get(ctx, creator); err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return nil, sdkerrors.ErrUnauthorized.Wrap("creator is not a registered provider")
		}
		return nil, err
	}

	switch msg.Purpose {
	case types.RetrievalSessionPurpose_RETRIEVAL_SESSION_PURPOSE_PROTOCOL_AUDIT,
		types.RetrievalSessionPurpose_RETRIEVAL_SESSION_PURPOSE_PROTOCOL_REPAIR:
		// ok
	default:
		return nil, sdkerrors.ErrInvalidRequest.Wrap("purpose must be PROTOCOL_AUDIT or PROTOCOL_REPAIR")
	}

	deal, err := k.Deals.Get(ctx, msg.DealId)
	if err != nil {
		return nil, sdkerrors.ErrNotFound.Wrapf("deal with ID %d not found", msg.DealId)
	}
	height := uint64(ctx.BlockHeight())
	if height >= deal.EndBlock {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("deal %d expired at end_block=%d", msg.DealId, deal.EndBlock)
	}
	if len(deal.ManifestRoot) != 48 || !bytesEqual(deal.ManifestRoot, msg.ManifestRoot) {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("manifest_root does not match current deal state")
	}

	stripe, err := stripeParamsForDeal(deal)
	if err != nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid service hint: %s", err.Error())
	}
	if msg.StartBlobIndex >= uint32(stripe.leafCount) {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("start_blob_index out of range")
	}
	startGlobal := msg.StartMduIndex*stripe.leafCount + uint64(msg.StartBlobIndex)
	endGlobal, overflow := addUint64(startGlobal, msg.BlobCount)
	if overflow {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("blob range overflow")
	}

	// For protocol sessions, the serving provider must be an ACTIVE slot provider (or the active provider of a repairing slot).
	isServingProvider := false
	providerSlot := uint64(0)
	if stripe.mode == 2 && len(deal.Mode2Slots) > 0 {
		for _, slot := range deal.Mode2Slots {
			if slot == nil {
				continue
			}
			if strings.TrimSpace(slot.Provider) == strings.TrimSpace(msg.Provider) {
				isServingProvider = true
				providerSlot = uint64(slot.Slot)
				break
			}
		}
	} else {
		for i, p := range deal.Providers {
			if strings.TrimSpace(p) == strings.TrimSpace(msg.Provider) {
				isServingProvider = true
				providerSlot = uint64(i)
				break
			}
		}
	}
	if !isServingProvider {
		return nil, sdkerrors.ErrUnauthorized.Wrap("serving provider is not assigned to deal")
	}

	if stripe.mode == 2 {
		endIndex := uint64(msg.StartBlobIndex) + msg.BlobCount - 1
		if endIndex >= stripe.leafCount {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("blob range exceeds leaf_count")
		}
		startSlot, serr := leafSlotIndex(uint64(msg.StartBlobIndex), stripe.rows)
		if serr != nil {
			return nil, sdkerrors.ErrInvalidRequest.Wrap(serr.Error())
		}
		endSlot, serr := leafSlotIndex(endIndex, stripe.rows)
		if serr != nil {
			return nil, sdkerrors.ErrInvalidRequest.Wrap(serr.Error())
		}
		if startSlot != endSlot {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("blob range must stay within a single slot in Mode 2")
		}
		if providerSlot != startSlot {
			return nil, sdkerrors.ErrUnauthorized.Wrap("provider does not match slot for blob range")
		}
	}

	if deal.TotalMdus != 0 {
		if msg.StartMduIndex >= deal.TotalMdus {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("start_mdu_index out of range")
		}
		maxGlobal := deal.TotalMdus * stripe.leafCount
		if endGlobal > maxGlobal {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("blob range exceeds deal content")
		}
	}

	totalBytes, overflow := mulUint64(msg.BlobCount, types.BlobSizeBytes)
	if overflow {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("total_bytes overflow")
	}

	expiresAt := msg.ExpiresAt
	if expiresAt == 0 {
		expiresAt = deal.EndBlock
	}
	if expiresAt > deal.EndBlock {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("expires_at must be <= deal end_block")
	}
	if expiresAt < height {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("expires_at must be >= current height")
	}

	// --- Protocol auth rules ---
	consumeAuditTask := false
	var consumeAuditTaskKey collections.Pair[uint64, uint64]
	switch msg.Purpose {
	case types.RetrievalSessionPurpose_RETRIEVAL_SESSION_PURPOSE_PROTOCOL_REPAIR:
		ra := msg.GetRepair()
		if ra == nil {
			return nil, sdkerrors.ErrUnauthorized.Wrap("repair auth is required")
		}
		if deal.RedundancyMode != 2 || deal.Mode2Profile == nil || len(deal.Mode2Slots) == 0 {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("repair sessions only supported for Mode 2 deals")
		}
		if int(ra.Slot) >= len(deal.Mode2Slots) {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("repair slot out of range")
		}
		entry := deal.Mode2Slots[int(ra.Slot)]
		if entry == nil {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("repair slot missing")
		}
		if entry.Status != types.SlotStatus_SLOT_STATUS_REPAIRING {
			return nil, sdkerrors.ErrUnauthorized.Wrap("slot is not repairing")
		}
		if strings.TrimSpace(entry.PendingProvider) == "" || strings.TrimSpace(entry.PendingProvider) != creator {
			return nil, sdkerrors.ErrUnauthorized.Wrap("only pending_provider may open repair sessions")
		}
		if strings.TrimSpace(entry.Provider) != strings.TrimSpace(msg.Provider) {
			return nil, sdkerrors.ErrUnauthorized.Wrap("repair sessions must target the active slot provider")
		}
		// Ensure auth slot matches the requested blob slot.
		if stripe.mode == 2 && uint64(ra.Slot) != providerSlot {
			return nil, sdkerrors.ErrUnauthorized.Wrap("repair slot does not match blob range slot")
		}

	case types.RetrievalSessionPurpose_RETRIEVAL_SESSION_PURPOSE_PROTOCOL_AUDIT:
		ref := msg.GetAuditTask()
		if ref == nil {
			return nil, sdkerrors.ErrUnauthorized.Wrap("audit_task ref is required")
		}
		taskKey := collections.Join(ref.EpochId, ref.TaskId)
		task, err := k.AuditTasks.Get(ctx, taskKey)
		if err != nil {
			if errors.Is(err, collections.ErrNotFound) {
				return nil, sdkerrors.ErrUnauthorized.Wrap("audit task not found")
			}
			return nil, err
		}
		if task.DealId != msg.DealId {
			return nil, sdkerrors.ErrUnauthorized.Wrap("audit task deal_id mismatch")
		}
		if strings.TrimSpace(task.Assignee) == "" || strings.TrimSpace(task.Assignee) != creator {
			return nil, sdkerrors.ErrUnauthorized.Wrap("audit task not assigned to creator")
		}
		if strings.TrimSpace(task.Provider) != strings.TrimSpace(msg.Provider) {
			return nil, sdkerrors.ErrUnauthorized.Wrap("audit task provider mismatch")
		}
		if len(task.ManifestRoot) != 48 || !bytesEqual(task.ManifestRoot, msg.ManifestRoot) {
			return nil, sdkerrors.ErrUnauthorized.Wrap("audit task manifest_root mismatch")
		}
		if task.StartMduIndex != msg.StartMduIndex ||
			task.StartBlobIndex != msg.StartBlobIndex ||
			task.BlobCount != msg.BlobCount {
			return nil, sdkerrors.ErrUnauthorized.Wrap("audit task range mismatch")
		}
		taskExpiresAt := task.ExpiresAt
		if taskExpiresAt == 0 {
			taskExpiresAt = deal.EndBlock
		}
		if taskExpiresAt != expiresAt {
			return nil, sdkerrors.ErrUnauthorized.Wrap("audit task expires_at mismatch")
		}
		consumeAuditTask = true
		consumeAuditTaskKey = taskKey

	default:
		return nil, sdkerrors.ErrInvalidRequest.Wrap("unsupported protocol session purpose")
	}

	ownerAddr, err := sdk.AccAddressFromBech32(creator)
	if err != nil {
		return nil, sdkerrors.ErrInvalidAddress.Wrap("invalid creator address")
	}
	providerAddr, err := sdk.AccAddressFromBech32(strings.TrimSpace(msg.Provider))
	if err != nil {
		return nil, sdkerrors.ErrInvalidAddress.Wrap("invalid provider address")
	}

	// --- Fee computation + funding from protocol budget module account ---
	params := k.GetParams(ctx)
	baseFee := params.BaseRetrievalFee
	variableFee := math.ZeroInt()
	if params.RetrievalPricePerBlob.IsValid() && params.RetrievalPricePerBlob.Amount.IsPositive() {
		variableFee = params.RetrievalPricePerBlob.Amount.Mul(math.NewIntFromUint64(msg.BlobCount))
	}
	totalFee := variableFee.Add(baseFee.Amount)
	if msg.MaxTotalFee.IsPositive() && totalFee.GT(msg.MaxTotalFee) {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("total fee exceeds max_total_fee")
	}

	if totalFee.IsPositive() {
		coins := sdk.NewCoins(sdk.NewCoin(sdk.DefaultBondDenom, totalFee))
		if err := k.BankKeeper.SendCoinsFromModuleToModule(ctx, types.ProtocolBudgetModuleName, types.ModuleName, coins); err != nil {
			return nil, fmt.Errorf("failed to fund protocol session fees: %w", err)
		}
		if baseFee.Amount.IsPositive() {
			if err := k.BankKeeper.BurnCoins(ctx, types.ModuleName, sdk.NewCoins(baseFee)); err != nil {
				return nil, fmt.Errorf("failed to burn base retrieval fee: %w", err)
			}
		}
	}

	nonceKey := collections.Join(collections.Join(creator, msg.DealId), strings.TrimSpace(msg.Provider))
	lastNonce, err := k.RetrievalSessionNonces.Get(ctx, nonceKey)
	if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return nil, err
	}
	if msg.Nonce <= lastNonce {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("nonce replay rejected")
	}

	sessionID, err := types.HashRetrievalSessionID(
		ownerAddr.Bytes(),
		msg.DealId,
		providerAddr.Bytes(),
		msg.ManifestRoot,
		msg.StartMduIndex,
		msg.StartBlobIndex,
		msg.BlobCount,
		msg.Nonce,
		expiresAt,
	)
	if err != nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("failed to compute session_id: %s", err)
	}

	payerAddr := authtypes.NewModuleAddress(types.ProtocolBudgetModuleName)
	session := types.RetrievalSession{
		SessionId:      sessionID,
		DealId:         msg.DealId,
		Owner:          creator,
		Provider:       strings.TrimSpace(msg.Provider),
		ManifestRoot:   msg.ManifestRoot,
		StartMduIndex:  msg.StartMduIndex,
		StartBlobIndex: msg.StartBlobIndex,
		BlobCount:      msg.BlobCount,
		TotalBytes:     totalBytes,
		Nonce:          msg.Nonce,
		ExpiresAt:      expiresAt,
		OpenedHeight:   ctx.BlockHeight(),
		UpdatedHeight:  ctx.BlockHeight(),
		Status:         types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_OPEN,
		LockedFee:      variableFee,
		Purpose:        msg.Purpose,
		Funding:        types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_PROTOCOL,
		Payer:          payerAddr.String(),
	}

	if err := k.RetrievalSessions.Set(ctx, sessionID, session); err != nil {
		return nil, fmt.Errorf("failed to store retrieval session: %w", err)
	}
	if err := k.RetrievalSessionsByOwner.Set(ctx, collections.Join(creator, sessionID), uint64(ctx.BlockHeight())); err != nil {
		return nil, fmt.Errorf("failed to index retrieval session by owner: %w", err)
	}
	if err := k.RetrievalSessionsByProvider.Set(ctx, collections.Join(strings.TrimSpace(msg.Provider), sessionID), uint64(ctx.BlockHeight())); err != nil {
		return nil, fmt.Errorf("failed to index retrieval session by provider: %w", err)
	}
	if err := k.RetrievalSessionNonces.Set(ctx, nonceKey, msg.Nonce); err != nil {
		return nil, fmt.Errorf("failed to update retrieval session nonce: %w", err)
	}
	if consumeAuditTask {
		// Consume tasks on successful open so they cannot be reused with a new nonce.
		_ = k.AuditTasks.Remove(ctx, consumeAuditTaskKey)
	}

	if err := k.recordRetrievalDemand(ctx, msg.BlobCount); err != nil {
		return nil, err
	}

	return &types.MsgOpenProtocolRetrievalSessionResponse{SessionId: sessionID}, nil
}

func (k msgServer) verifyAndConsumeVoucher(ctx sdk.Context, deal *types.Deal, open *types.MsgOpenRetrievalSessionSponsored, v *types.VoucherAuth) error {
	if deal == nil || open == nil || v == nil {
		return sdkerrors.ErrInvalidRequest.Wrap("invalid voucher request")
	}
	if v.DealId != open.DealId {
		return sdkerrors.ErrUnauthorized.Wrap("voucher deal_id mismatch")
	}
	if len(v.ManifestRoot) != 48 || !bytesEqual(v.ManifestRoot, open.ManifestRoot) {
		return sdkerrors.ErrUnauthorized.Wrap("voucher manifest_root mismatch")
	}
	if strings.TrimSpace(v.Provider) != "" && strings.TrimSpace(v.Provider) != strings.TrimSpace(open.Provider) {
		return sdkerrors.ErrUnauthorized.Wrap("voucher provider mismatch")
	}
	if v.StartMduIndex != open.StartMduIndex ||
		v.StartBlobIndex != open.StartBlobIndex ||
		v.BlobCount != open.BlobCount {
		return sdkerrors.ErrUnauthorized.Wrap("voucher range mismatch")
	}

	effectiveExpiresAt := open.ExpiresAt
	if effectiveExpiresAt == 0 {
		effectiveExpiresAt = deal.EndBlock
	}
	if v.ExpiresAt != effectiveExpiresAt {
		return sdkerrors.ErrUnauthorized.Wrap("voucher expires_at mismatch")
	}

	if strings.TrimSpace(v.Redeemer) != "" && strings.TrimSpace(v.Redeemer) != strings.TrimSpace(open.Creator) {
		return sdkerrors.ErrUnauthorized.Wrap("voucher redeemer mismatch")
	}
	if len(v.Signature) != 65 {
		return sdkerrors.ErrUnauthorized.Wrap("invalid voucher signature length")
	}

	h := uint64(ctx.BlockHeight())
	if v.ExpiresAt < h {
		return sdkerrors.ErrUnauthorized.Wrap("voucher expired")
	}
	if v.ExpiresAt > deal.EndBlock {
		return sdkerrors.ErrUnauthorized.Wrap("voucher outlives deal term")
	}

	params := k.GetParams(ctx)
	if params.VoucherMaxTtlBlocks != 0 {
		ttl := v.ExpiresAt - h
		if ttl > params.VoucherMaxTtlBlocks {
			return sdkerrors.ErrUnauthorized.Wrap("voucher ttl exceeds max")
		}
	}

	usedKey := collections.Join(v.DealId, v.Nonce)
	used, err := k.VoucherUsedNonces.Get(ctx, usedKey)
	if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return err
	}
	if used {
		return sdkerrors.ErrUnauthorized.Wrap("voucher nonce replay rejected")
	}

	signerStr := strings.TrimSpace(deal.RetrievalPolicy.VoucherSigner)
	if signerStr == "" {
		signerStr = deal.Owner
	}
	signerAcc, err := sdk.AccAddressFromBech32(signerStr)
	if err != nil {
		return sdkerrors.ErrInvalidAddress.Wrap("invalid voucher signer")
	}

	chainID := big.NewInt(0).SetUint64(params.Eip712ChainId)
	domainSep := types.HashDomainSeparator(chainID)
	structHash, err := types.HashRetrievalVoucher(v)
	if err != nil {
		return sdkerrors.ErrInvalidRequest.Wrap(err.Error())
	}
	digest := types.ComputeEIP712Digest(domainSep, structHash)
	evmAddr, err := recoverEvmAddressFromDigest(digest, v.Signature)
	if err != nil {
		return sdkerrors.ErrUnauthorized.Wrapf("failed to recover voucher signer: %s", err)
	}
	if !bytes.Equal(evmAddr.Bytes(), signerAcc.Bytes()) {
		return sdkerrors.ErrUnauthorized.Wrap("voucher signature does not match signer")
	}

	if err := k.VoucherUsedNonces.Set(ctx, usedKey, true); err != nil {
		return fmt.Errorf("failed to store voucher nonce: %w", err)
	}
	return nil
}

func (k msgServer) ConfirmRetrievalSession(goCtx context.Context, msg *types.MsgConfirmRetrievalSession) (*types.MsgConfirmRetrievalSessionResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)
	if msg == nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("invalid request")
	}
	if len(msg.SessionId) != 32 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("session_id must be 32 bytes")
	}

	session, err := k.RetrievalSessions.Get(ctx, msg.SessionId)
	if err != nil {
		return nil, sdkerrors.ErrNotFound.Wrap("retrieval session not found")
	}
	if msg.Creator != session.Owner {
		return nil, sdkerrors.ErrUnauthorized.Wrap("only session owner may confirm completion")
	}

	if isSessionExpired(ctx, &session) {
		session.Status = types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_EXPIRED
		session.UpdatedHeight = ctx.BlockHeight()
		_ = k.RetrievalSessions.Set(ctx, msg.SessionId, session)
		return nil, sdkerrors.ErrInvalidRequest.Wrap("retrieval session expired")
	}
	if session.Status == types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_COMPLETED {
		return &types.MsgConfirmRetrievalSessionResponse{Success: true}, nil
	}

	switch session.Status {
	case types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_OPEN:
		session.Status = types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_USER_CONFIRMED
	case types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_PROOF_SUBMITTED:
		session.Status = types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_COMPLETED
	default:
		// Allow idempotent confirmations.
	}
	session.UpdatedHeight = ctx.BlockHeight()

	if session.Status == types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_COMPLETED {
		if err := k.settleRetrievalSession(ctx, &session); err != nil {
			return nil, err
		}
	}

	if err := k.RetrievalSessions.Set(ctx, msg.SessionId, session); err != nil {
		return nil, err
	}

	if session.Status == types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_COMPLETED {
		if err := k.IncrementHeat(ctx, session.DealId, session.TotalBytes, false); err != nil {
			ctx.Logger().Error("failed to increment heat on session completion", "error", err)
		}
	}

	return &types.MsgConfirmRetrievalSessionResponse{Success: true}, nil
}

func (k msgServer) CancelRetrievalSession(goCtx context.Context, msg *types.MsgCancelRetrievalSession) (*types.MsgCancelRetrievalSessionResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)
	if msg == nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("invalid request")
	}
	if len(msg.SessionId) != 32 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("session_id must be 32 bytes")
	}

	session, err := k.RetrievalSessions.Get(ctx, msg.SessionId)
	if err != nil {
		return nil, sdkerrors.ErrNotFound.Wrap("retrieval session not found")
	}
	if msg.Creator != session.Owner {
		return nil, sdkerrors.ErrUnauthorized.Wrap("only session owner may cancel")
	}

	if session.Status == types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_COMPLETED ||
		session.Status == types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_CANCELED {
		return &types.MsgCancelRetrievalSessionResponse{Success: true}, nil
	}

	if !isSessionExpired(ctx, &session) {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("retrieval session not expired")
	}

	// Non-response evidence: if the session expired without a provider-submitted proof,
	// record a lightweight evidence marker and degrade provider health.
	// This is intentionally conservative: sessions that reached PROOF_SUBMITTED are not
	// treated as non-response (even if the user never confirmed).
	if session.Status == types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_OPEN {
		if err := k.recordEvidenceSummary(ctx, session.DealId, session.Provider, "retrieval_non_response", session.SessionId, msg.Creator, false); err != nil {
			ctx.Logger().Error("failed to record non-response evidence", "error", err, "deal", session.DealId, "provider", session.Provider)
		}
		if err := k.IncrementHeat(ctx, session.DealId, 0, true); err != nil {
			ctx.Logger().Error("failed to increment heat for non-response evidence", "error", err, "deal", session.DealId, "provider", session.Provider)
		}
		k.trackProviderHealth(ctx, session.DealId, session.Provider, false)
	}

	if session.LockedFee.IsPositive() {
		funding := session.Funding
		if funding == types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_UNSPECIFIED {
			// Backwards-compatible default: older sessions were deal-escrow funded.
			funding = types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_DEAL_ESCROW
		}

		switch funding {
		case types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_DEAL_ESCROW:
			// Owner-paid sessions refund back into deal escrow accounting (coins already live in module account).
			deal, err := k.Deals.Get(ctx, session.DealId)
			if err != nil {
				return nil, sdkerrors.ErrNotFound.Wrapf("deal %d not found", session.DealId)
			}
			deal.EscrowBalance = deal.EscrowBalance.Add(session.LockedFee)
			if err := k.Deals.Set(ctx, session.DealId, deal); err != nil {
				return nil, fmt.Errorf("failed to refund locked retrieval fees: %w", err)
			}
			session.LockedFee = math.ZeroInt()

		case types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_REQUESTER,
			types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_PROTOCOL:
			// Sponsored/protocol sessions refund back to the recorded payer.
			payer := strings.TrimSpace(session.Payer)
			if payer == "" {
				payer = strings.TrimSpace(session.Owner)
			}
			payerAddr, err := sdk.AccAddressFromBech32(payer)
			if err != nil {
				return nil, sdkerrors.ErrInvalidAddress.Wrap("invalid payer address")
			}
			refund := sdk.NewCoins(sdk.NewCoin(sdk.DefaultBondDenom, session.LockedFee))
			if err := k.BankKeeper.SendCoinsFromModuleToAccount(ctx, types.ModuleName, payerAddr, refund); err != nil {
				return nil, fmt.Errorf("failed to refund locked retrieval fees to payer: %w", err)
			}
			session.LockedFee = math.ZeroInt()

		default:
			return nil, sdkerrors.ErrInvalidRequest.Wrap("invalid retrieval session funding")
		}
	}

	session.Status = types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_CANCELED
	session.UpdatedHeight = ctx.BlockHeight()
	if err := k.RetrievalSessions.Set(ctx, msg.SessionId, session); err != nil {
		return nil, err
	}

	return &types.MsgCancelRetrievalSessionResponse{Success: true}, nil
}

func (k msgServer) SubmitRetrievalSessionProof(goCtx context.Context, msg *types.MsgSubmitRetrievalSessionProof) (*types.MsgSubmitRetrievalSessionProofResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)
	if msg == nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("invalid request")
	}
	if len(msg.SessionId) != 32 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("session_id must be 32 bytes")
	}
	if len(msg.Proofs) == 0 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("proofs are required")
	}

	session, err := k.RetrievalSessions.Get(ctx, msg.SessionId)
	if err != nil {
		return nil, sdkerrors.ErrNotFound.Wrap("retrieval session not found")
	}
	creator, err := requireCanonicalProviderCreator(msg.Creator)
	if err != nil {
		return nil, err
	}
	// Deputy/P2P flows: allow any registered provider to submit a valid session proof.
	if _, err := k.Providers.Get(ctx, creator); err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return nil, sdkerrors.ErrUnauthorized.Wrapf("provider %s is not registered", creator)
		}
		return nil, err
	}

	if isSessionExpired(ctx, &session) {
		session.Status = types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_EXPIRED
		session.UpdatedHeight = ctx.BlockHeight()
		_ = k.RetrievalSessions.Set(ctx, msg.SessionId, session)
		return nil, sdkerrors.ErrInvalidRequest.Wrap("retrieval session expired")
	}
	if session.Status == types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_COMPLETED {
		return &types.MsgSubmitRetrievalSessionProofResponse{Success: true}, nil
	}

	// Pin the first provider to submit the session proofs. This is the provider that
	// will be paid when the session is completed/confirmed.
	if session.Status == types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_OPEN ||
		session.Status == types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_USER_CONFIRMED {
		existing, err := k.RetrievalSessionProofProvider.Get(ctx, msg.SessionId)
		if err != nil && !errors.Is(err, collections.ErrNotFound) {
			return nil, err
		}
		if errors.Is(err, collections.ErrNotFound) || strings.TrimSpace(existing) == "" {
			if err := k.RetrievalSessionProofProvider.Set(ctx, msg.SessionId, creator); err != nil {
				return nil, err
			}
		} else if strings.TrimSpace(existing) != creator {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("session proofs already submitted by a different provider")
		}
	}

	deal, err := k.Deals.Get(ctx, session.DealId)
	if err != nil {
		return nil, sdkerrors.ErrNotFound.Wrapf("deal with ID %d not found", session.DealId)
	}
	if len(deal.ManifestRoot) != 48 || !bytesEqual(deal.ManifestRoot, session.ManifestRoot) {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("deal manifest_root changed since session open")
	}
	if uint64(len(msg.Proofs)) != session.BlobCount {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("proof count mismatch for session blob_count")
	}

	stripe, err := stripeParamsForDeal(deal)
	if err != nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid service hint: %s", err.Error())
	}
	startGlobal := session.StartMduIndex*stripe.leafCount + uint64(session.StartBlobIndex)

	activeProviderForMode2Slot := func(slot uint32) (string, bool) {
		if deal.RedundancyMode == 2 && len(deal.Mode2Slots) > 0 && int(slot) < len(deal.Mode2Slots) {
			entry := deal.Mode2Slots[slot]
			if entry == nil {
				return "", false
			}
			p := strings.TrimSpace(entry.Provider)
			if p == "" {
				return "", false
			}
			return p, true
		}
		if int(slot) < len(deal.Providers) {
			p := strings.TrimSpace(deal.Providers[slot])
			if p == "" {
				return "", false
			}
			return p, true
		}
		return "", false
	}

	verifyChainedProof := func(chainedProof *types.ChainedProof) (bool, error) {
		if chainedProof == nil {
			return false, nil
		}
		if len(chainedProof.ManifestOpening) != 48 || len(chainedProof.MduRootFr) != 32 ||
			len(chainedProof.BlobCommitment) != 48 || len(chainedProof.MerklePath) == 0 ||
			len(chainedProof.ZValue) != 32 || len(chainedProof.YValue) != 32 || len(chainedProof.KzgOpeningProof) != 48 {
			return false, nil
		}
		if len(deal.ManifestRoot) != 48 {
			return false, nil
		}

		flattenedMerkle := make([]byte, 0, len(chainedProof.MerklePath)*32)
		for _, node := range chainedProof.MerklePath {
			if len(node) != 32 {
				return false, nil
			}
			flattenedMerkle = append(flattenedMerkle, node...)
		}

		v, err := crypto_ffi.VerifyChainedProof(
			deal.ManifestRoot,
			chainedProof.MduIndex,
			chainedProof.ManifestOpening,
			chainedProof.MduRootFr,
			chainedProof.BlobCommitment,
			uint64(chainedProof.BlobIndex),
			stripe.leafCount,
			flattenedMerkle,
			chainedProof.ZValue,
			chainedProof.YValue,
			chainedProof.KzgOpeningProof,
		)
		if err != nil {
			return false, err
		}
		return v, nil
	}

	for i := uint64(0); i < session.BlobCount; i++ {
		p := msg.Proofs[int(i)]

		expectedGlobal := startGlobal + i
		expectedMdu := expectedGlobal / stripe.leafCount
		expectedBlob := expectedGlobal % stripe.leafCount

		if p.MduIndex != expectedMdu || uint64(p.BlobIndex) != expectedBlob {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("proof mdu/blob index mismatch for session")
		}

		ok, err := verifyChainedProof(&p)
		if err != nil {
			return nil, sdkerrors.ErrUnauthorized.Wrapf("triple proof verification error: %s", err)
		}
		if !ok {
			return nil, sdkerrors.ErrUnauthorized.Wrap("invalid liveness proof")
		}
	}

	// Count retrieval proofs as liveness credits for unified quota accounting.
	epochID := k.currentEpoch(ctx)
	if epochID != 0 {
		for _, p := range msg.Proofs {
			if stripe.mode == 2 {
				slotU64, serr := leafSlotIndex(uint64(p.BlobIndex), stripe.rows)
				if serr != nil {
					return nil, sdkerrors.ErrInvalidRequest.Wrap(serr.Error())
				}
				if slotU64 > uint64(^uint32(0)) {
					return nil, sdkerrors.ErrInvalidRequest.Wrap("slot index overflow")
				}
				slot := uint32(slotU64)
				if active, ok := activeProviderForMode2Slot(slot); ok && active == creator {
					keyEpoch := mode2EpochKey(deal.Id, slot, epochID)
					prev, err := k.Mode2EpochSlotServed.Get(ctx, keyEpoch)
					if err != nil && !errors.Is(err, collections.ErrNotFound) {
						return nil, err
					}
					if err := k.Mode2EpochSlotServed.Set(ctx, keyEpoch, prev+1); err != nil {
						return nil, err
					}
				}
			}
			if err := k.recordCreditForProof(ctx, epochID, deal, stripe, creator, p.MduIndex, p.BlobIndex); err != nil {
				return nil, err
			}
		}
	}

	switch session.Status {
	case types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_OPEN:
		session.Status = types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_PROOF_SUBMITTED
	case types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_USER_CONFIRMED:
		session.Status = types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_COMPLETED
	default:
		// Allow idempotent proofs.
	}
	session.UpdatedHeight = ctx.BlockHeight()

	if session.Status == types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_COMPLETED {
		if err := k.settleRetrievalSession(ctx, &session); err != nil {
			return nil, err
		}
	}

	if err := k.RetrievalSessions.Set(ctx, msg.SessionId, session); err != nil {
		return nil, err
	}

	if session.Status == types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_COMPLETED {
		if err := k.IncrementHeat(ctx, session.DealId, session.TotalBytes, false); err != nil {
			ctx.Logger().Error("failed to increment heat on session completion", "error", err)
		}
	}

	return &types.MsgSubmitRetrievalSessionProofResponse{Success: true}, nil
}

// recoverEvmAddressFromDigest recovers the EVM address from a signature over a digest.
func recoverEvmAddressFromDigest(digest []byte, sig []byte) (gethCommon.Address, error) {
	var zero gethCommon.Address
	if len(sig) != 65 {
		return zero, fmt.Errorf("invalid signature length: %d", len(sig))
	}

	sigCopy := make([]byte, len(sig))
	copy(sigCopy, sig)
	// Normalise V into {0,1} as expected by go-ethereum.
	if sigCopy[64] >= 27 {
		sigCopy[64] -= 27
	}

	pubKey, err := gethCrypto.SigToPub(digest, sigCopy)
	if err != nil {
		return zero, err
	}
	return gethCrypto.PubkeyToAddress(*pubKey), nil
}

func isSessionExpired(ctx sdk.Context, session *types.RetrievalSession) bool {
	if session == nil {
		return true
	}
	if session.ExpiresAt == 0 {
		return false
	}
	return uint64(ctx.BlockHeight()) > session.ExpiresAt
}

func (k msgServer) settleRetrievalSession(ctx sdk.Context, session *types.RetrievalSession) error {
	if session == nil || !session.LockedFee.IsPositive() {
		return nil
	}

	params := k.GetParams(ctx)
	burnBps := params.RetrievalBurnBps
	variable := session.LockedFee

	burn := math.ZeroInt()
	if burnBps > 0 {
		bps := math.NewIntFromUint64(burnBps)
		bpsDiv := math.NewInt(10000)
		bpsCeil := math.NewInt(9999)
		burn = variable.Mul(bps).Add(bpsCeil).Quo(bpsDiv)
		if burn.GT(variable) {
			burn = variable
		}
	}

	providerCut := variable.Sub(burn)
	if providerCut.IsNegative() {
		return fmt.Errorf("retrieval payout underflow")
	}

	if burn.IsPositive() {
		burnCoins := sdk.NewCoins(sdk.NewCoin(sdk.DefaultBondDenom, burn))
		if err := k.BankKeeper.BurnCoins(ctx, types.ModuleName, burnCoins); err != nil {
			return fmt.Errorf("failed to burn retrieval fees: %w", err)
		}
	}

	if providerCut.IsPositive() {
		payTo := strings.TrimSpace(session.Provider)
		if sessionID := session.SessionId; len(sessionID) == 32 {
			if proofProvider, err := k.RetrievalSessionProofProvider.Get(ctx, sessionID); err == nil && strings.TrimSpace(proofProvider) != "" {
				payTo = strings.TrimSpace(proofProvider)
			}
		}

		providerAddr, err := sdk.AccAddressFromBech32(payTo)
		if err != nil {
			return sdkerrors.ErrInvalidAddress.Wrap("invalid provider address")
		}
		coins := sdk.NewCoins(sdk.NewCoin(sdk.DefaultBondDenom, providerCut))
		if err := k.BankKeeper.SendCoinsFromModuleToAccount(ctx, types.ModuleName, providerAddr, coins); err != nil {
			return fmt.Errorf("failed to pay retrieval fees: %w", err)
		}
	}

	session.LockedFee = math.ZeroInt()
	if sessionID := session.SessionId; len(sessionID) == 32 {
		_ = k.RetrievalSessionProofProvider.Remove(ctx, sessionID)
	}
	return nil
}

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func addUint64(a, b uint64) (uint64, bool) {
	out := a + b
	return out, out < a
}

func mulUint64(a, b uint64) (uint64, bool) {
	if a == 0 || b == 0 {
		return 0, false
	}
	out := a * b
	return out, out/b != a
}

func (k Keeper) recordEvidenceSummary(ctx sdk.Context, dealID uint64, provider string, kind string, sessionID []byte, reporter string, ok bool) error {
	proofID, err := k.ProofCount.Next(ctx)
	if err != nil {
		return fmt.Errorf("failed to get next proof id: %w", err)
	}

	sessionHex := ""
	if len(sessionID) > 0 {
		sessionHex = hex.EncodeToString(sessionID)
	}

	commitment := fmt.Sprintf("evidence:%s deal=%d provider=%s session=%s reporter=%s", kind, dealID, provider, sessionHex, reporter)
	summary := types.Proof{
		Id:          proofID,
		Creator:     provider,
		Commitment:  commitment,
		Valid:       ok,
		BlockHeight: ctx.BlockHeight(),
	}

	if err := k.Proofs.Set(ctx, proofID, summary); err != nil {
		return fmt.Errorf("failed to store evidence summary: %w", err)
	}
	if shouldCountEvidenceAsFailedChallenge(kind, ok) {
		if err := k.IncrementHeat(ctx, dealID, 0, true); err != nil {
			ctx.Logger().Error("failed to increment heat for evidence summary", "deal", dealID, "kind", kind, "error", err)
		}
	}

	return nil
}

func shouldCountEvidenceAsFailedChallenge(kind string, ok bool) bool {
	if ok {
		return false
	}
	switch strings.TrimSpace(strings.ToLower(kind)) {
	case "deputy_served",
		"deputy_miss_repair_started",
		"quota_miss_repair_started",
		"provider_degraded_repair_started",
		"system_proof_invalid",
		"system_proof_rejected",
		"system_proof_wrong_challenge",
		"system_proof_wrong_provider":
		return true
	default:
		return false
	}
}

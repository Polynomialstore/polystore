package keeper

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"strings"
	"unicode"

	"cosmossdk.io/collections"
	"cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	gethCommon "github.com/ethereum/go-ethereum/common"
	gethCrypto "github.com/ethereum/go-ethereum/crypto"
	ma "github.com/multiformats/go-multiaddr"
	"nilchain/x/crypto_ffi"
	"nilchain/x/nilchain/types"
)

type msgServer struct {
	Keeper
}

// NewMsgServerImpl returns an implementation of the MsgServer interface
// for the provided Keeper.
func NewMsgServerImpl(keeper Keeper) types.MsgServer {
	return &msgServer{Keeper: keeper}
}

// Ensure msgServer implements the types.MsgServer interface
var _ types.MsgServer = msgServer{}

// CreateDealFromEvm handles MsgCreateDealFromEvm to create a new storage deal
// from an EVM-signed intent bridged into nilchaind.
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
	serviceHint := rawHint
	requestedReplicas := uint64(types.DealBaseReplication)

	if rawHint != "" {
		base := rawHint
		if idx := strings.Index(rawHint, ":"); idx != -1 {
			base = strings.TrimSpace(rawHint[:idx])
			extras := strings.Split(rawHint[idx+1:], ":")
			for _, token := range extras {
				token = strings.TrimSpace(token)
				if token == "" {
					continue
				}
				parts := strings.SplitN(token, "=", 2)
				if len(parts) != 2 {
					continue
				}
				key := strings.ToLower(strings.TrimSpace(parts[0]))
				val := strings.TrimSpace(parts[1])
				switch key {
				case "replicas":
					if val == "" {
						continue
					}
					n, err := strconv.ParseUint(val, 10, 64)
					if err != nil || n == 0 {
						return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid replicas value in service hint: %s", val)
					}
					if n > uint64(types.DealBaseReplication) {
						n = uint64(types.DealBaseReplication)
					}
					requestedReplicas = n
				}
			}
		}
		if base != "" {
			serviceHint = base
		}
	}

	if serviceHint != "Hot" && serviceHint != "Cold" && serviceHint != "General" && serviceHint != "" {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid service hint: %s", serviceHint)
	}

	dealID, err := k.DealCount.Next(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get next deal ID: %w", err)
	}

	blockHash := ctx.BlockHeader().LastBlockId.Hash
	assignedProviders, err := k.AssignProviders(ctx, dealID, blockHash, serviceHint, requestedReplicas)
	if err != nil {
		return nil, fmt.Errorf("failed to assign providers: %w", err)
	}

	escrowCoins := sdk.NewCoins(sdk.NewCoin("stake", intent.InitialEscrow))
	if err := k.BankKeeper.SendCoinsFromAccountToModule(ctx, ownerAcc, types.ModuleName, escrowCoins); err != nil {
		return nil, err
	}

	currentReplication := uint64(len(assignedProviders))

	deal := types.Deal{
		Id:                 dealID,
		ManifestRoot:       nil, // Empty initially
		Size_:              0,   // Empty initially
		Owner:              ownerAddrStr,
		EscrowBalance:      intent.InitialEscrow,
		StartBlock:         uint64(ctx.BlockHeight()),
		EndBlock:           uint64(ctx.BlockHeight()) + intent.DurationBlocks,
		Providers:          assignedProviders,
		RedundancyMode:     1,
		CurrentReplication: currentReplication,
		ServiceHint:        serviceHint,
		MaxMonthlySpend:    intent.MaxMonthlySpend,
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

	creatorAddr, err := sdk.AccAddressFromBech32(msg.Creator)
	if err != nil {
		return nil, sdkerrors.ErrInvalidAddress.Wrapf("invalid creator address: %s", err)
	}

	if msg.Capabilities != "Archive" && msg.Capabilities != "General" && msg.Capabilities != "Edge" {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid capabilities: %s", msg.Capabilities)
	}

	if len(msg.Endpoints) == 0 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("endpoints is required (at least one Multiaddr)")
	}
	if len(msg.Endpoints) > 8 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("too many endpoints (max 8)")
	}
	endpoints := make([]string, 0, len(msg.Endpoints))
	seenEndpoints := make(map[string]struct{}, len(msg.Endpoints))
	hasHTTP := false
	for _, raw := range msg.Endpoints {
		ep := strings.TrimSpace(raw)
		if ep == "" {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("endpoint must be non-empty")
		}
		if len(ep) > 256 {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("endpoint too long")
		}
		if !strings.HasPrefix(ep, "/") {
			return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid endpoint multiaddr: %q", ep)
		}
		if strings.IndexFunc(ep, func(r rune) bool { return unicode.IsSpace(r) || r < 0x20 }) != -1 {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("endpoint contains whitespace/control characters")
		}
		parsed, err := ma.NewMultiaddr(ep)
		if err != nil {
			return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid endpoint multiaddr: %q", ep)
		}
		for _, proto := range parsed.Protocols() {
			if proto.Code == ma.P_HTTP || proto.Code == ma.P_HTTPS {
				hasHTTP = true
			}
		}
		canonical := parsed.String()
		if _, ok := seenEndpoints[canonical]; ok {
			continue
		}
		seenEndpoints[canonical] = struct{}{}
		endpoints = append(endpoints, canonical)
	}
	if !hasHTTP {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("at least one HTTP or HTTPS endpoint is required")
	}

	_, err = k.Providers.Get(ctx, msg.Creator)
	if err == nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("provider %s already registered", msg.Creator)
	}
	if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return nil, err
	}

	// Create new Provider object
	provider := types.Provider{
		Address:         creatorAddr.String(),
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

// CreateDeal handles MsgCreateDeal to create a new storage deal.
func (k msgServer) CreateDeal(goCtx context.Context, msg *types.MsgCreateDeal) (*types.MsgCreateDealResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	creatorAddr, err := sdk.AccAddressFromBech32(msg.Creator)
	if err != nil {
		return nil, sdkerrors.ErrInvalidAddress.Wrapf("invalid creator address: %s", err)
	}

	params := k.GetParams(ctx)
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
	//   "<Hint>[:owner=<nilAddress>][:replicas=<N>]"
	rawHint := strings.TrimSpace(msg.ServiceHint)
	serviceHint := rawHint
	ownerAddrStr := msg.Creator
	requestedReplicas := uint64(types.DealBaseReplication)

	if rawHint != "" {
		base := rawHint
		if idx := strings.Index(rawHint, ":"); idx != -1 {
			base = strings.TrimSpace(rawHint[:idx])
			extras := strings.Split(rawHint[idx+1:], ":")
			for _, token := range extras {
				token = strings.TrimSpace(token)
				if token == "" {
					continue
				}
				parts := strings.SplitN(token, "=", 2)
				if len(parts) != 2 {
					continue
				}
				key := strings.ToLower(strings.TrimSpace(parts[0]))
				val := strings.TrimSpace(parts[1])
				switch key {
				case "owner":
					if val == "" {
						continue
					}
					if _, err := sdk.AccAddressFromBech32(val); err != nil {
						return nil, sdkerrors.ErrInvalidAddress.Wrapf("invalid owner address in service hint: %s", val)
					}
					ownerAddrStr = val
				case "replicas":
					if val == "" {
						continue
					}
					n, err := strconv.ParseUint(val, 10, 64)
					if err != nil || n == 0 {
						return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid replicas value in service hint: %s", val)
					}
					if n > uint64(types.DealBaseReplication) {
						n = uint64(types.DealBaseReplication)
					}
					requestedReplicas = n
				}
			}
		}
		if base != "" {
			serviceHint = base
		}
	}

	blockHash := ctx.BlockHeader().LastBlockId.Hash
	assignedProviders, err := k.AssignProviders(ctx, dealID, blockHash, serviceHint, requestedReplicas)
	if err != nil {
		return nil, fmt.Errorf("failed to assign providers: %w", err)
	}

	if msg.DurationBlocks == 0 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("Deal duration cannot be zero")
	}
	if serviceHint != "Hot" && serviceHint != "Cold" && serviceHint != "General" && serviceHint != "" {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid service hint: %s", serviceHint)
	}

	initialEscrowAmount := msg.InitialEscrowAmount
	if initialEscrowAmount.IsNil() || initialEscrowAmount.IsNegative() {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid initial escrow amount: %s", msg.InitialEscrowAmount)
	}
	maxMonthlySpend := msg.MaxMonthlySpend
	if maxMonthlySpend.IsNil() || maxMonthlySpend.IsNegative() {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid max monthly spend: %s", msg.MaxMonthlySpend)
	}

	// For the local devnet, we denominate escrow in the staking token ("stake").
	escrowCoin := sdk.NewCoins(sdk.NewCoin("stake", initialEscrowAmount))
	if err := k.BankKeeper.SendCoinsFromAccountToModule(ctx, creatorAddr, types.ModuleName, escrowCoin); err != nil {
		return nil, err
	}

	currentReplication := uint64(len(assignedProviders))

	deal := types.Deal{
		Id:                 dealID,
		ManifestRoot:       nil, // Empty
		Size_:              0,   // Empty
		Owner:              ownerAddrStr,
		EscrowBalance:      initialEscrowAmount,
		StartBlock:         uint64(ctx.BlockHeight()),
		EndBlock:           uint64(ctx.BlockHeight()) + msg.DurationBlocks,
		Providers:          assignedProviders,
		RedundancyMode:     1,
		CurrentReplication: currentReplication,
		ServiceHint:        serviceHint,
		MaxMonthlySpend:    maxMonthlySpend,
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

	params := k.GetParams(ctx)

	// --- TERM DEPOSIT (Storage Lock-in) ---
	if msg.Size_ > deal.Size_ {
		deltaSize := msg.Size_ - deal.Size_
		duration := deal.EndBlock - deal.StartBlock

		price := params.StoragePrice
		if price.IsPositive() {
			costDec := price.MulInt64(int64(deltaSize)).MulInt64(int64(duration))
			cost := costDec.Ceil().TruncateInt()

			if cost.IsPositive() {
				coins := sdk.NewCoins(sdk.NewCoin("unil", cost))
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

	// Atomic Update
	manifestRoot, err := hex.DecodeString(strings.TrimPrefix(msg.Cid, "0x"))
	if err != nil || len(manifestRoot) != 48 {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid manifest root (must be 48-byte hex): %s", msg.Cid)
	}

	deal.ManifestRoot = manifestRoot
	deal.Size_ = msg.Size_

	if err := k.Deals.Set(ctx, msg.DealId, deal); err != nil {
		return nil, fmt.Errorf("failed to update deal: %w", err)
	}

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			"update_deal_content", // Use string literal for new event type
			sdk.NewAttribute(types.AttributeKeyDealID, fmt.Sprintf("%d", deal.Id)),
			sdk.NewAttribute(types.AttributeKeyCID, msg.Cid),
			sdk.NewAttribute(types.AttributeKeySize, fmt.Sprintf("%d", deal.Size_)),
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

	// --- TERM DEPOSIT (Storage Lock-in) ---
	// Cost = (NewSize - OldSize) * Duration * Price
	// Only charge for size increase.
	if intent.SizeBytes > deal.Size_ {
		deltaSize := intent.SizeBytes - deal.Size_
		duration := deal.EndBlock - deal.StartBlock

		// price is Dec per byte per block
		price := params.StoragePrice
		if price.IsPositive() {
			costDec := price.MulInt64(int64(deltaSize)).MulInt64(int64(duration))
			cost := costDec.Ceil().TruncateInt()

			if cost.IsPositive() {
				// We assume base denom is "unil". This should ideally be a param, but hardcoded for now matches DefaultParams.
				coins := sdk.NewCoins(sdk.NewCoin("unil", cost))
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

	deal.ManifestRoot = manifestRoot
	deal.Size_ = intent.SizeBytes

	if err := k.Deals.Set(ctx, intent.DealId, deal); err != nil {
		return nil, fmt.Errorf("failed to update deal: %w", err)
	}

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			"update_deal_content",
			sdk.NewAttribute(types.AttributeKeyDealID, fmt.Sprintf("%d", deal.Id)),
			sdk.NewAttribute(types.AttributeKeyCID, intent.Cid),
			sdk.NewAttribute(types.AttributeKeySize, fmt.Sprintf("%d", deal.Size_)),
		),
	)

	return &types.MsgUpdateDealContentFromEvmResponse{Success: true}, nil
}

// ProveLiveness handles MsgProveLiveness to verify KZG proofs and process rewards.
func (k msgServer) ProveLiveness(goCtx context.Context, msg *types.MsgProveLiveness) (*types.MsgProveLivenessResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	deal, err := k.Deals.Get(ctx, msg.DealId)
	if err != nil {
		return nil, sdkerrors.ErrNotFound.Wrapf("deal with ID %d not found", msg.DealId)
	}

	isAssignedProvider := false
	for _, p := range deal.Providers {
		if p == msg.Creator {
			isAssignedProvider = true
			break
		}
	}
	if !isAssignedProvider {
		return nil, sdkerrors.ErrUnauthorized.Wrapf("provider %s is not assigned to deal %d", msg.Creator, msg.DealId)
	}

	verifyChainedProof := func(chainedProof *types.ChainedProof, logInput bool) (bool, error) {
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

	hChallenge := int64(deal.StartBlock)

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
		provider, errGet := k.Providers.Get(ctx, msg.Creator)
		if errGet == nil {
			provider.ReputationScore += 1
			if errSet := k.Providers.Set(ctx, msg.Creator, provider); errSet != nil {
				ctx.Logger().Error("Failed to update provider reputation", "error", errSet)
			}
		}
	}

	params := k.GetParams(ctx)

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
		if receipt.Provider != msg.Creator {
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
		ok, err := verifyChainedProof(&receipt.ProofDetails, false)
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

		return nil
	}

	switch pt := msg.ProofType.(type) {
	case *types.MsgProveLiveness_SystemProof:
		ok, err := verifyChainedProof(pt.SystemProof, true)
		if err != nil {
			ctx.Logger().Error("Triple Proof Verification Error", "err", err)
			ok = false
		}
		if !ok {
			// Track health for system proofs that fail verification.
			k.trackProviderHealth(ctx, msg.DealId, msg.Creator, false)
			return &types.MsgProveLivenessResponse{Success: false, Tier: 3 /* Fail */, RewardAmount: "0"}, nil
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
		if receipt.Provider != msg.Creator {
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
			ok, err := verifyChainedProof(&chunk.ProofDetails, false)
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
		currentRewards, err := k.ProviderRewards.Get(ctx, msg.Creator)
		if err != nil {
			if !errors.Is(err, collections.ErrNotFound) {
				return nil, err
			}
			currentRewards = math.ZeroInt()
		}

		newRewards := currentRewards.Add(totalReward)
		if err := k.ProviderRewards.Set(ctx, msg.Creator, newRewards); err != nil {
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
		// The actual tokens are in the 'nilchain' module account.
		// So we effectively "moved" claim from Deal to ProviderReward.
		// For Storage: We will mint when withdrawing.
	}

	if err := k.Deals.Set(ctx, msg.DealId, deal); err != nil {
		return nil, fmt.Errorf("failed to update deal state: %w", err)
	}

	if err := k.DealProviderStatus.Set(ctx, collections.Join(msg.DealId, msg.Creator), uint64(ctx.BlockHeight())); err != nil {
		return nil, fmt.Errorf("failed to update proof status: %w", err)
	}

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			types.TypeMsgProveLiveness,
			sdk.NewAttribute(types.AttributeKeyProvider, msg.Creator),
			sdk.NewAttribute(types.AttributeKeyDealID, fmt.Sprintf("%d", msg.DealId)),
			sdk.NewAttribute(types.AttributeKeySuccess, "true"),
			sdk.NewAttribute(types.AttributeKeyTier, tierName),
			sdk.NewAttribute(types.AttributeKeyRewardAmount, totalReward.String()),
		),
	)

	// Record successful proof for liveness/performance observability.
	if err := k.recordProofSummary(ctx, msg, deal, tierName, true); err != nil {
		ctx.Logger().Error("failed to record proof summary", "error", err)
	}

	// Update minimal health stub: successful proof resets failure counters for
	// this (deal, provider) pair and logs health as "OK" for devnet.
	k.trackProviderHealth(ctx, msg.DealId, msg.Creator, true)

	return &types.MsgProveLivenessResponse{Success: true, Tier: tier, RewardAmount: totalReward.String()}, nil
}

// recordProofSummary stores a lightweight Proof summary in state so that the
// web UI can render recent liveness/performance events via the existing
// ListProofs query.
func (k msgServer) recordProofSummary(ctx sdk.Context, msg *types.MsgProveLiveness, deal types.Deal, tierName string, ok bool) error {
	proofID, err := k.ProofCount.Next(ctx)
	if err != nil {
		return fmt.Errorf("failed to get next proof id: %w", err)
	}

	summary := types.Proof{
		Id:          proofID,
		Creator:     msg.Creator,
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
	}
}

// SignalSaturation handles MsgSignalSaturation to trigger pre-emptive scaling.
func (k msgServer) SignalSaturation(goCtx context.Context, msg *types.MsgSignalSaturation) (*types.MsgSignalSaturationResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	deal, err := k.Deals.Get(ctx, msg.DealId)
	if err != nil {
		return nil, sdkerrors.ErrNotFound.Wrapf("deal with ID %d not found", msg.DealId)
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

	// --- BUDGET CHECK ---
	// Cost = (CurrentReplication + 12) * BaseStripeCost
	params := k.GetParams(ctx)
	currentReplication := deal.CurrentReplication
	newReplication := currentReplication + types.DealBaseReplication
	estimatedCost := math.NewInt(int64(newReplication)).Mul(math.NewInt(int64(params.BaseStripeCost)))

	if estimatedCost.GT(deal.MaxMonthlySpend) {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("scaling denied: new cost %s exceeds max monthly spend %s", estimatedCost, deal.MaxMonthlySpend)
	}

	blockHash := ctx.BlockHeader().LastBlockId.Hash
	derivedID := deal.Id + (deal.CurrentReplication * 1000)

	newProviders, err := k.AssignProviders(ctx, derivedID, blockHash, "Hot", types.DealBaseReplication)
	if err != nil {
		return nil, fmt.Errorf("failed to assign new hot stripe: %w", err)
	}

	deal.Providers = append(deal.Providers, newProviders...)
	deal.CurrentReplication += types.DealBaseReplication

	if err := k.Deals.Set(ctx, deal.Id, deal); err != nil {
		return nil, fmt.Errorf("failed to update deal with new stripe: %w", err)
	}

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			types.TypeMsgSignalSaturation,
			sdk.NewAttribute(types.AttributeKeyDealID, fmt.Sprintf("%d", deal.Id)),
			sdk.NewAttribute("new_stripe_index", fmt.Sprintf("%d", (deal.CurrentReplication/types.DealBaseReplication))),
			sdk.NewAttribute("new_providers", fmt.Sprintf("%v", newProviders)),
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

	amount := msg.Amount
	if amount.IsNil() || amount.IsNegative() {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("invalid amount")
	}

	coins := sdk.NewCoins(sdk.NewCoin("stake", amount))
	if err := k.BankKeeper.SendCoinsFromAccountToModule(ctx, senderAddr, types.ModuleName, coins); err != nil {
		return nil, err
	}

	deal.EscrowBalance = deal.EscrowBalance.Add(amount)
	if err := k.Deals.Set(ctx, msg.DealId, deal); err != nil {
		return nil, err
	}

	return &types.MsgAddCreditResponse{NewBalance: deal.EscrowBalance}, nil
}

// WithdrawRewards allows a Storage Provider to withdraw accumulated rewards.
func (k msgServer) WithdrawRewards(goCtx context.Context, msg *types.MsgWithdrawRewards) (*types.MsgWithdrawRewardsResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	providerAddr, err := sdk.AccAddressFromBech32(msg.Creator)
	if err != nil {
		return nil, sdkerrors.ErrInvalidAddress.Wrapf("invalid provider address: %s", err)
	}

	rewards, err := k.ProviderRewards.Get(ctx, msg.Creator)
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
	// `deal.EscrowBalance` was reduced. But the coins are still in `nilchain` module account.
	// So `nilchain` module account holds:
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

	coins := sdk.NewCoins(sdk.NewCoin("stake", rewards))
	if err := k.BankKeeper.MintCoins(ctx, types.ModuleName, coins); err != nil {
		return nil, err
	}
	if err := k.BankKeeper.SendCoinsFromModuleToAccount(ctx, types.ModuleName, providerAddr, coins); err != nil {
		return nil, err
	}

	// Reset rewards
	if err := k.ProviderRewards.Set(ctx, msg.Creator, math.ZeroInt()); err != nil {
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
	if len(deal.ManifestRoot) != 48 || !bytesEqual(deal.ManifestRoot, msg.ManifestRoot) {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("manifest_root does not match current deal state")
	}

	isAssignedProvider := false
	for _, p := range deal.Providers {
		if p == msg.Provider {
			isAssignedProvider = true
			break
		}
	}
	if !isAssignedProvider {
		return nil, sdkerrors.ErrUnauthorized.Wrapf("provider %s is not assigned to deal %d", msg.Provider, msg.DealId)
	}

	if msg.StartBlobIndex >= uint32(types.BlobsPerMdu) {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("start_blob_index out of range")
	}
	startGlobal := msg.StartMduIndex*types.BlobsPerMdu + uint64(msg.StartBlobIndex)
	endGlobal, overflow := addUint64(startGlobal, msg.BlobCount)
	if overflow {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("blob range overflow")
	}
	if deal.TotalMdus != 0 {
		if msg.StartMduIndex >= deal.TotalMdus {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("start_mdu_index out of range")
		}
		maxGlobal := deal.TotalMdus * types.BlobsPerMdu
		if endGlobal > maxGlobal {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("blob range exceeds deal content")
		}
	}

	totalBytes, overflow := mulUint64(msg.BlobCount, types.BlobSizeBytes)
	if overflow {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("total_bytes overflow")
	}

	ownerAddr, err := sdk.AccAddressFromBech32(msg.Creator)
	if err != nil {
		return nil, sdkerrors.ErrInvalidAddress.Wrap("invalid creator address")
	}
	providerAddr, err := sdk.AccAddressFromBech32(msg.Provider)
	if err != nil {
		return nil, sdkerrors.ErrInvalidAddress.Wrap("invalid provider address")
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
		msg.ExpiresAt,
	)
	if err != nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("failed to compute session_id: %s", err)
	}

	session := types.RetrievalSession{
		SessionId:       sessionID,
		DealId:          msg.DealId,
		Owner:           msg.Creator,
		Provider:        msg.Provider,
		ManifestRoot:    msg.ManifestRoot,
		StartMduIndex:   msg.StartMduIndex,
		StartBlobIndex:  msg.StartBlobIndex,
		BlobCount:       msg.BlobCount,
		TotalBytes:      totalBytes,
		Nonce:           msg.Nonce,
		ExpiresAt:       msg.ExpiresAt,
		OpenedHeight:    ctx.BlockHeight(),
		UpdatedHeight:   ctx.BlockHeight(),
		Status:          types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_OPEN,
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

	return &types.MsgOpenRetrievalSessionResponse{SessionId: sessionID}, nil
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
	if msg.Creator != session.Provider {
		return nil, sdkerrors.ErrUnauthorized.Wrap("only session provider may submit proofs")
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

	startGlobal := session.StartMduIndex*types.BlobsPerMdu + uint64(session.StartBlobIndex)

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
		expectedMdu := expectedGlobal / types.BlobsPerMdu
		expectedBlob := expectedGlobal % types.BlobsPerMdu

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

	switch session.Status {
	case types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_OPEN:
		session.Status = types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_PROOF_SUBMITTED
	case types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_USER_CONFIRMED:
		session.Status = types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_COMPLETED
	default:
		// Allow idempotent proofs.
	}
	session.UpdatedHeight = ctx.BlockHeight()

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

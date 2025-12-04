package keeper

import (
	"context"
	"encoding/hex"
	"fmt"
	"os" // Needed for KZG_TRUSTED_SETUP env var

	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"
	"nilchain/x/crypto_ffi" // FFI for KZG
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


// RegisterProvider handles MsgRegisterProvider to create a new Storage Provider.
func (k msgServer) RegisterProvider(goCtx context.Context, msg *types.MsgRegisterProvider) (*types.MsgRegisterProviderResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	creatorAddr, err := sdk.AccAddressFromBech32(msg.Creator)
	if err != nil {
		return nil, sdkerrors.ErrInvalidAddress.Wrapf("invalid creator address: %s", err)
	}

	// Basic validation for capabilities
	if msg.Capabilities != "Archive" && msg.Capabilities != "General" && msg.Capabilities != "Edge" {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid capabilities: %s", msg.Capabilities)
	}

	// Check if provider already exists
	_, err = k.Providers.Get(ctx, msg.Creator)
	if err == nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("provider %s already registered", msg.Creator)
	}
	// If the error is not 'not found', then it's a real error
	if err != nil && !sdkerrors.ErrNotFound.Is(err) {
		return nil, err
	}

	// Create new Provider object
	provider := types.Provider{
		Address: creatorAddr.String(),
		TotalStorage: msg.TotalStorage,
		UsedStorage: 0, // Initially 0
		Capabilities: msg.Capabilities,
		Status: "Active", // Initially active
	}

	// Save provider to store
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

	// 1. Generate new Deal ID
	dealID, err := k.DealCount.Next(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get next deal ID: %w", err)
	}

	// 2. Assign Providers
	blockHash := ctx.BlockHeader().LastBlockId.GetHash() // Use previous block hash for deterministic assignment
	assignedProviders, err := k.AssignProviders(ctx, dealID, blockHash, msg.ServiceHint)
	if err != nil {
		return nil, fmt.Errorf("failed to assign providers: %w", err)
	}

	// 3. Validate Inputs
	if len(msg.Cid) == 0 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("CID cannot be empty")
	}
	if msg.Size == 0 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("Deal size cannot be zero")
	}
	if msg.DurationBlocks == 0 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("Deal duration cannot be zero")
	}
	if msg.ServiceHint != "Hot" && msg.ServiceHint != "Cold" && msg.ServiceHint != "General" && msg.ServiceHint != "" {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid service hint: %s", msg.ServiceHint)
	}

	initialEscrowAmount, ok := sdk.NewIntFromString(msg.InitialEscrowAmount)
	if !ok || initialEscrowAmount.IsNil() || initialEscrowAmount.IsNegative() {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid initial escrow amount: %s", msg.InitialEscrowAmount)
	}
	maxMonthlySpend, ok := sdk.NewIntFromString(msg.MaxMonthlySpend)
	if !ok || maxMonthlySpend.IsNil() || maxMonthlySpend.IsNegative() {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid max monthly spend: %s", msg.MaxMonthlySpend)
	}
	
	// 4. Deduct Escrow
	escrowCoin := sdk.NewCoins(sdk.NewCoin("token", initialEscrowAmount)) // Assuming "token" is the native currency
	if err := k.BankKeeper.SendCoinsFromAccountToModule(ctx, creatorAddr, types.ModuleName, escrowCoin); err != nil {
		return nil, err
	}

	// 5. Create Deal object
	deal := types.Deal{
		Id:                 dealID,
		Cid:                msg.Cid,
		Size:               msg.Size,
		Owner:              msg.Creator,
		EscrowBalance:      initialEscrowAmount,
		StartBlock:         ctx.BlockHeight(),
		EndBlock:           ctx.BlockHeight() + int64(msg.DurationBlocks),
		Providers:          assignedProviders,
		RedundancyMode:     1, // Default RS(12,8)
		CurrentReplication: types.DealBaseReplication,
		ServiceHint:        msg.ServiceHint,
		MaxMonthlySpend:    maxMonthlySpend,
	}

	// 6. Save Deal state
	if err := k.Deals.Set(ctx, dealID, deal); err != nil {
		return nil, fmt.Errorf("failed to set deal: %w", err)
	}

	// 7. Emit Event
	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			types.TypeMsgCreateDeal,
			sdk.NewAttribute(types.AttributeKeyDealID, fmt.Sprintf("%d", deal.Id)),
			sdk.NewAttribute(types.AttributeKeyOwner, deal.Owner),
			sdk.NewAttribute(types.AttributeKeyCID, deal.Cid),
			sdk.NewAttribute(types.AttributeKeySize, fmt.Sprintf("%d", deal.Size)),
			sdk.NewAttribute(types.AttributeKeyHint, deal.ServiceHint),
			sdk.NewAttribute(types.AttributeKeyAssignedProviders, fmt.Sprintf("%v", deal.Providers)),
		),
	)

	return &types.MsgCreateDealResponse{
		DealId:            deal.Id,
		AssignedProviders: deal.Providers,
	}, nil
}

// ProveLiveness handles MsgProveLiveness to verify KZG proofs and process rewards.
package keeper

import (
	"context"
	"encoding/hex"
	"fmt"
	"os" // Needed for KZG_TRUSTED_SETUP env var

	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"
	"nilchain/x/crypto_ffi" // FFI for KZG
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


// RegisterProvider handles MsgRegisterProvider to create a new Storage Provider.
func (k msgServer) RegisterProvider(goCtx context.Context, msg *types.MsgRegisterProvider) (*types.MsgRegisterProviderResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	creatorAddr, err := sdk.AccAddressFromBech32(msg.Creator)
	if err != nil {
		return nil, sdkerrors.ErrInvalidAddress.Wrapf("invalid creator address: %s", err)
	}

	// Basic validation for capabilities
	if msg.Capabilities != "Archive" && msg.Capabilities != "General" && msg.Capabilities != "Edge" {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid capabilities: %s", msg.Capabilities)
	}

	// Check if provider already exists
	_, err = k.Providers.Get(ctx, msg.Creator)
	if err == nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("provider %s already registered", msg.Creator)
	}
	// If the error is not 'not found', then it's a real error
	if err != nil && !sdkerrors.ErrNotFound.Is(err) {
		return nil, err
	}

	// Create new Provider object
	provider := types.Provider{
		Address: creatorAddr.String(),
		TotalStorage: msg.TotalStorage,
		UsedStorage: 0, // Initially 0
		Capabilities: msg.Capabilities,
		Status: "Active", // Initially active
	}

	// Save provider to store
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

	// 1. Generate new Deal ID
	dealID, err := k.DealCount.Next(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get next deal ID: %w", err)
	}

	// 2. Assign Providers
	blockHash := ctx.BlockHeader().LastBlockId.GetHash() // Use previous block hash for deterministic assignment
	assignedProviders, err := k.AssignProviders(ctx, dealID, blockHash, msg.ServiceHint)
	if err != nil {
		return nil, fmt.Errorf("failed to assign providers: %w", err)
	}

	// 3. Validate Inputs
	if len(msg.Cid) == 0 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("CID cannot be empty")
	}
	if msg.Size == 0 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("Deal size cannot be zero")
	}
	if msg.DurationBlocks == 0 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("Deal duration cannot be zero")
	}
	if msg.ServiceHint != "Hot" && msg.ServiceHint != "Cold" && msg.ServiceHint != "General" && msg.ServiceHint != "" {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid service hint: %s", msg.ServiceHint)
	}

	initialEscrowAmount, ok := sdk.NewIntFromString(msg.InitialEscrowAmount)
	if !ok || initialEscrowAmount.IsNil() || initialEscrowAmount.IsNegative() {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid initial escrow amount: %s", msg.InitialEscrowAmount)
	}
	maxMonthlySpend, ok := sdk.NewIntFromString(msg.MaxMonthlySpend)
	if !ok || maxMonthlySpend.IsNil() || maxMonthlySpend.IsNegative() {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid max monthly spend: %s", msg.MaxMonthlySpend)
	}
	
	// 4. Deduct Escrow
	escrowCoin := sdk.NewCoins(sdk.NewCoin("token", initialEscrowAmount)) // Assuming "token" is the native currency
	if err := k.BankKeeper.SendCoinsFromAccountToModule(ctx, creatorAddr, types.ModuleName, escrowCoin); err != nil {
		return nil, err
	}

	// 5. Create Deal object
	deal := types.Deal{
		Id:                 dealID,
		Cid:                msg.Cid,
		Size:               msg.Size,
		Owner:              msg.Creator,
		EscrowBalance:      initialEscrowAmount,
		StartBlock:         ctx.BlockHeight(),
		EndBlock:           ctx.BlockHeight() + int64(msg.DurationBlocks),
		Providers:          assignedProviders,
		RedundancyMode:     1, // Default RS(12,8)
		CurrentReplication: types.DealBaseReplication,
		ServiceHint:        msg.ServiceHint,
		MaxMonthlySpend:    maxMonthlySpend,
	}

	// 6. Save Deal state
	if err := k.Deals.Set(ctx, dealID, deal); err != nil {
		return nil, fmt.Errorf("failed to set deal: %w", err)
	}

	// 7. Emit Event
	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			types.TypeMsgCreateDeal,
			sdk.NewAttribute(types.AttributeKeyDealID, fmt.Sprintf("%d", deal.Id)),
			sdk.NewAttribute(types.AttributeKeyOwner, deal.Owner),
			sdk.NewAttribute(types.AttributeKeyCID, deal.Cid),
			sdk.NewAttribute(types.AttributeKeySize, fmt.Sprintf("%d", deal.Size)),
			sdk.NewAttribute(types.AttributeKeyHint, deal.ServiceHint),
			sdk.NewAttribute(types.AttributeKeyAssignedProviders, fmt.Sprintf("%v", deal.Providers)),
		),
	)

	return &types.MsgCreateDealResponse{
		DealId:            deal.Id,
		AssignedProviders: deal.Providers,
	}, nil
}

// ProveLiveness handles MsgProveLiveness to verify KZG proofs and process rewards.
func (k msgServer) ProveLiveness(goCtx context.Context, msg *types.MsgProveLiveness) (*types.MsgProveLivenessResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	creatorAddr, err := sdk.AccAddressFromBech32(msg.Creator)
	if err != nil {
		return nil, sdkerrors.ErrInvalidAddress.Wrapf("invalid creator address: %s", err)
	}

	// 1. Retrieve the Deal
	deal, err := k.Deals.Get(ctx, msg.DealId)
	if err != nil {
		return nil, sdkerrors.ErrNotFound.Wrapf("deal with ID %d not found", msg.DealId)
	}

	// Check if the message creator is one of the assigned providers for this deal
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

	// 2. Challenge Derivation (Mock: Use previous block hash for Z and current block height for challenge start)
	// TODO: Integrate with actual Epoch Beacon module for truly random, unpredictable Z and epoch_start_block
	hChallenge := deal.StartBlock // Placeholder: assuming challenge starts at deal.StartBlock or epoch start
	beacon := ctx.BlockHeader().LastBlockId.GetHash()
	
	// Determine the KZGProof being submitted
	var kzgProof types.KzgProof
	var isUserReceipt bool
	switch pt := msg.ProofType.(type) {
	case *types.MsgProveLiveness_SystemProof:
		kzgProof = *pt.SystemProof
		isUserReceipt = false
	case *types.MsgProveLiveness_UserReceipt:
		kzgProof = *pt.UserReceipt.ProofDetails
		isUserReceipt = true
		// TODO: Also verify user_receipt.UserSignature here using a crypto library for Ed25519
		// For now, assume valid if present
	default:
		return nil, sdkerrors.ErrInvalidRequest.Wrap("invalid proof type")
	}

	// 3. Verify KZG Proof via FFI
	tsPath := os.Getenv("KZG_TRUSTED_SETUP")
	if tsPath == "" {
		tsPath = "trusted_setup.txt" // Default fallback
	}
	// TODO: Initialize KZG context once per module, not per call
	if err := crypto_ffi.Init(tsPath); err != nil {
		ctx.Logger().Error("KZG Init failed", "error", err)
		return nil, fmt.Errorf("kzg initialization error: %w", err)
	}
	
	valid, err := crypto_ffi.VerifyMduProof(
		kzgProof.MduMerkleRoot,
		kzgProof.ChallengedKzgCommitment,
		kzgProof.ChallengedKzgCommitmentMerklePath,
		kzgProof.ChallengedKzgCommitmentIndex,
		kzgProof.ZValue,
		kzgProof.YValue,
		kzgProof.KzgOpeningProof,
	)

	if err != nil {
		ctx.Logger().Error("MDU KZG Verification Error", "error", err)
		return nil, fmt.Errorf("verification error: %w", err)
	}

	if !valid {
		ctx.Logger().Info("KZG Proof INVALID: Slashing Sender")
        // TODO: Implement Tiered Slashing based on spec
		// For now, a failed proof incurs a fixed slash
        slashAmt := sdk.NewCoins(sdk.NewInt64Coin("token", 10000000)) // Placeholder 10 NIL
        if err := k.BankKeeper.SendCoinsFromAccountToModule(ctx, creatorAddr, types.ModuleName, slashAmt); err == nil {
            if err := k.BankKeeper.BurnCoins(ctx, types.ModuleName, slashAmt); err != nil {
                ctx.Logger().Error("Failed to burn slashed coins", "error", err)
            }
        }
		return &types.MsgProveLivenessResponse{Success: false, Tier: 3 /* Fail */, RewardAmount: "0"}, nil
	}

    // 4. Calculate Tier based on block height latency
	hProof := ctx.BlockHeight()
	latency := hProof - hChallenge // Latency in blocks (Block difference from challenge start to proof inclusion)

	var tier uint32
	var rewardMultiplier sdk.Dec
	tierName := "Fail"

	if latency <= 1 {
		tier = 0 // Platinum
		rewardMultiplier = sdk.NewDecWithPrec(100, 2) // 1.00
		tierName = "Platinum"
	} else if latency <= 5 {
		tier = 1 // Gold
		rewardMultiplier = sdk.NewDecWithPrec(80, 2) // 0.80
		tierName = "Gold"
	} else if latency <= 10 {
		tier = 2 // Silver
		rewardMultiplier = sdk.NewDecWithPrec(50, 2) // 0.50
		tierName = "Silver"
	} else {
		tier = 3 // Fail
		rewardMultiplier = sdk.NewDecWithPrec(0, 2) // 0.00
		tierName = "Fail"
		// Slashing already handled above for !valid proofs.
		// For valid but too slow proofs, no reward, potentially still a small slash based on spec.
	}

	// 5. Distribute Rewards
	var storageReward sdk.Int
	var bandwidthPayment sdk.Int
	
	// Basic reward calculation (Needs refinement based on deal size, duration, etc.)
	baseReward := sdk.NewInt(1000000) // Placeholder 1 NIL per proof

	// Storage Reward (applied to all valid proofs)
	storageReward = sdk.NewDecFromInt(baseReward).Mul(rewardMultiplier).TruncateInt()

	// Bandwidth Payment (only for UserReceipts, and needs to come from Deal.Escrow)
	if isUserReceipt {
		// TODO: Calculate bandwidth payment based on bytes_served and current market price
		// For now, a placeholder for bandwidth payment from deal escrow
		bandwidthPayment = sdk.NewInt(500000) // Placeholder 0.5 NIL
		
		// Deduct from Deal.EscrowBalance
		newEscrowBalance := deal.EscrowBalance.Sub(bandwidthPayment)
		if newEscrowBalance.IsNegative() {
			return nil, sdkerrors.ErrInsufficientFunds.Wrapf("deal %d escrow exhausted", msg.DealId)
		}
		deal.EscrowBalance = newEscrowBalance
	} else {
		bandwidthPayment = sdk.NewInt(0)
	}

	totalReward := storageReward.Add(bandwidthPayment)

	// Transfer rewards
	if totalReward.IsPositive() {
		rewardCoins := sdk.NewCoins(sdk.NewCoin("token", totalReward))
		if err := k.BankKeeper.MintCoins(ctx, types.ModuleName, rewardCoins); err != nil {
			return nil, fmt.Errorf("failed to mint reward coins: %w", err)
		}
		if err := k.BankKeeper.SendCoinsFromModuleToAccount(ctx, creatorAddr, rewardCoins); err != nil {
			return nil, fmt.Errorf("failed to send reward coins: %w", err)
		}
	}
	
	// Update Deal State with new escrow balance (if bandwidth was paid) and current_replication if needed
	if err := k.Deals.Set(ctx, msg.DealId, deal); err != nil {
		return nil, fmt.Errorf("failed to update deal state: %w", err)
	}

	// 6. Emit Event
	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			types.TypeMsgProveLiveness,
			sdk.NewAttribute(types.AttributeKeyProvider, msg.Creator),
			sdk.NewAttribute(types.AttributeKeyDealID, fmt.Sprintf("%d", msg.DealId)),
			sdk.NewAttribute(types.AttributeKeySuccess, "true"), // Proof was cryptographically valid
			sdk.NewAttribute(types.AttributeKeyTier, tierName),
			sdk.NewAttribute(types.AttributeKeyRewardAmount, totalReward.String()),
		),
	)

	return &types.MsgProveLivenessResponse{Success: true, Tier: tier, RewardAmount: totalReward.String()}, nil
}

// SignalSaturation handles MsgSignalSaturation to trigger pre-emptive scaling.
func (k msgServer) SignalSaturation(goCtx context.Context, msg *types.MsgSignalSaturation) (*types.MsgSignalSaturationResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)
	_ = ctx // TODO: implement saturation signaling logic

	// Placeholder logic for now
	return &types.MsgSignalSaturationResponse{
		Success: true,
		Message: "Saturation signal received, scaling initiated (placeholder)",
		NewProviders: []string{"cosmos1newprovider1", "cosmos1newprovider2"},
	}, nil
}

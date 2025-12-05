package keeper

import (
	"context"
	"errors" // ADDED
	"fmt"
	"os" // Needed for KZG_TRUSTED_SETUP env var

	"cosmossdk.io/collections" // ADDED
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"
	"cosmossdk.io/math"
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
	if err != nil && !errors.Is(err, collections.ErrNotFound) {
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
	blockHash := ctx.BlockHeader().LastBlockId.Hash // Use previous block hash for deterministic assignment
	assignedProviders, err := k.AssignProviders(ctx, dealID, blockHash, msg.ServiceHint, types.DealBaseReplication)
	if err != nil {
		return nil, fmt.Errorf("failed to assign providers: %w", err)
	}

	// 3. Validate Inputs
	if len(msg.Cid) == 0 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("CID cannot be empty")
	}
	if msg.Size_ == 0 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("Deal size cannot be zero")
	}
	if msg.DurationBlocks == 0 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("Deal duration cannot be zero")
	}
	if msg.ServiceHint != "Hot" && msg.ServiceHint != "Cold" && msg.ServiceHint != "General" && msg.ServiceHint != "" {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid service hint: %s", msg.ServiceHint)
	}

	initialEscrowAmount := msg.InitialEscrowAmount
	if initialEscrowAmount.IsNil() || initialEscrowAmount.IsNegative() {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("invalid initial escrow amount: %s", msg.InitialEscrowAmount)
	}
	maxMonthlySpend := msg.MaxMonthlySpend
	if maxMonthlySpend.IsNil() || maxMonthlySpend.IsNegative() {
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
		Size_:              msg.Size_,
		Owner:              msg.Creator,
		EscrowBalance:      initialEscrowAmount,
		StartBlock:         uint64(ctx.BlockHeight()),
		EndBlock:           uint64(ctx.BlockHeight()) + msg.DurationBlocks,
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
			sdk.NewAttribute(types.AttributeKeySize, fmt.Sprintf("%d", deal.Size_)),
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
	hChallenge := int64(deal.StartBlock) // Placeholder: assuming challenge starts at deal.StartBlock or epoch start
	beacon := ctx.BlockHeader().LastBlockId.Hash
	_ = beacon // Use beacon for randomization later
	
	// Determine the KZGProof being submitted
	var kzgProof types.KzgProof
	var isUserReceipt bool
	switch pt := msg.ProofType.(type) {
	case *types.MsgProveLiveness_SystemProof:
		kzgProof = *pt.SystemProof
		isUserReceipt = false
	case *types.MsgProveLiveness_UserReceipt:
		kzgProof = pt.UserReceipt.ProofDetails
		isUserReceipt = true
		// TODO: Also verify user_receipt.UserSignature here using a crypto library for Ed25519
		// For now, assume valid if present
	default:
		return nil, sdkerrors.ErrInvalidRequest.Wrap("invalid proof type")
	}

	// Flatten merkle path
	flattenedMerklePath := make([]byte, 0, len(kzgProof.ChallengedKzgCommitmentMerklePath)*32)
	for _, node := range kzgProof.ChallengedKzgCommitmentMerklePath {
		flattenedMerklePath = append(flattenedMerklePath, node...)
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
		flattenedMerklePath,
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
        // Slashing Logic:
        // 1. Attempt to slash fixed amount (e.g., 10 NIL)
        slashAmt := sdk.NewCoins(sdk.NewInt64Coin("token", 10000000)) 
        err := k.BankKeeper.SendCoinsFromAccountToModule(ctx, creatorAddr, types.ModuleName, slashAmt)
        
        if err != nil {
            // 2. If slash fails (insufficient funds), Jail the provider
            ctx.Logger().Info("Slashing failed (insufficient funds), Jailing provider", "provider", msg.Creator)
            
            provider, errGet := k.Providers.Get(ctx, msg.Creator)
            if errGet == nil {
                provider.Status = "Jailed"
                if errSet := k.Providers.Set(ctx, msg.Creator, provider); errSet != nil {
                     ctx.Logger().Error("Failed to update provider status to Jailed", "error", errSet)
                }
            }
        } else {
            // 3. If slash succeeds, burn the tokens
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
	var rewardMultiplier math.LegacyDec
	tierName := "Fail"

	if latency <= 1 {
		tier = 0 // Platinum
		rewardMultiplier = math.LegacyNewDecWithPrec(100, 2) // 1.00
		tierName = "Platinum"
	} else if latency <= 5 {
		tier = 1 // Gold
		rewardMultiplier = math.LegacyNewDecWithPrec(80, 2) // 0.80
		tierName = "Gold"
	} else if latency <= 10 {
		tier = 2 // Silver
		rewardMultiplier = math.LegacyNewDecWithPrec(50, 2) // 0.50
		tierName = "Silver"
	} else {
		tier = 3 // Fail
		rewardMultiplier = math.LegacyNewDecWithPrec(0, 2) // 0.00
		tierName = "Fail"
		// Slashing already handled above for !valid proofs.
		// For valid but too slow proofs, no reward, potentially still a small slash based on spec.
	}

	// 5. Distribute Rewards
	var storageReward math.Int
	var bandwidthPayment math.Int
	
	// Basic reward calculation (Needs refinement based on deal size, duration, etc.)
	baseReward := math.NewInt(1000000) // Placeholder 1 NIL per proof

	// Storage Reward (applied to all valid proofs)
	storageReward = math.LegacyNewDecFromInt(baseReward).Mul(rewardMultiplier).TruncateInt()

	// Bandwidth Payment (only for UserReceipts, and needs to come from Deal.Escrow)
	if isUserReceipt {
        // Verify User Signature
        receipt := msg.GetProofType().(*types.MsgProveLiveness_UserReceipt).UserReceipt
        
        // Reconstruct signed data: DealID (8) + EpochID (8) + Provider (len) + BytesServed (8)
        // Using simple BigEndian encoding
        // Note: In production, use a structured serialization like Protobuf or specific byte layout
        buf := make([]byte, 0)
        buf = append(buf, sdk.Uint64ToBigEndian(receipt.DealId)...)
        buf = append(buf, sdk.Uint64ToBigEndian(receipt.EpochId)...)
        buf = append(buf, []byte(receipt.Provider)...)
        buf = append(buf, sdk.Uint64ToBigEndian(receipt.BytesServed)...)
        
        // Get Deal Owner PubKey
        ownerAddr, err := sdk.AccAddressFromBech32(deal.Owner)
        if err != nil {
             return nil, fmt.Errorf("invalid owner address: %w", err)
        }
        
        ownerAccount := k.AccountKeeper.GetAccount(ctx, ownerAddr)
        if ownerAccount == nil {
             return nil, fmt.Errorf("deal owner account not found")
        }
        
        pubKey := ownerAccount.GetPubKey()
        if pubKey == nil {
             return nil, fmt.Errorf("deal owner has no public key (account might be new/unpublished)")
        }
        
        if !pubKey.VerifySignature(buf, receipt.UserSignature) {
             return nil, sdkerrors.ErrUnauthorized.Wrap("invalid retrieval receipt signature")
        }

		// TODO: Calculate bandwidth payment based on bytes_served and current market price
		// For now, a placeholder for bandwidth payment from deal escrow
		bandwidthPayment = math.NewInt(500000) // Placeholder 0.5 NIL
		
		// Deduct from Deal.EscrowBalance
		newEscrowBalance := deal.EscrowBalance.Sub(bandwidthPayment)
		if newEscrowBalance.IsNegative() {
			return nil, sdkerrors.ErrInsufficientFunds.Wrapf("deal %d escrow exhausted", msg.DealId)
		}
		deal.EscrowBalance = newEscrowBalance
	} else {
		bandwidthPayment = math.NewInt(0)
	}

	totalReward := storageReward.Add(bandwidthPayment)

	// Transfer rewards
	if totalReward.IsPositive() {
		rewardCoins := sdk.NewCoins(sdk.NewCoin("token", totalReward))
		if err := k.BankKeeper.MintCoins(ctx, types.ModuleName, rewardCoins); err != nil {
			return nil, fmt.Errorf("failed to mint reward coins: %w", err)
		}
		if err := k.BankKeeper.SendCoinsFromModuleToAccount(ctx, types.ModuleName, creatorAddr, rewardCoins); err != nil {
			return nil, fmt.Errorf("failed to send reward coins: %w", err)
		}
	}
	
	// Update Deal State with new escrow balance (if bandwidth was paid) and current_replication if needed
	if err := k.Deals.Set(ctx, msg.DealId, deal); err != nil {
		return nil, fmt.Errorf("failed to update deal state: %w", err)
	}

	// Update LastProofHeight
	if err := k.DealProviderStatus.Set(ctx, collections.Join(msg.DealId, msg.Creator), uint64(ctx.BlockHeight())); err != nil {
		return nil, fmt.Errorf("failed to update proof status: %w", err)
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
	
    // 1. Retrieve Deal
    deal, err := k.Deals.Get(ctx, msg.DealId)
    if err != nil {
        return nil, sdkerrors.ErrNotFound.Wrapf("deal with ID %d not found", msg.DealId)
    }

    // 2. Authorization Check: Only an assigned provider can signal saturation
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

    // 3. Budget Check (Elasticity Logic)
    // Calculate cost of current replication vs max monthly spend
    // Simplified model: Each stripe (12 providers) costs X.
    // Current cost = (CurrentReplication / 12) * BaseStripeCost
    // If (CurrentReplication + 12) exceeds budget, deny.
    // Assuming 1 token per block per stripe for now (placeholder).
    
    // For Phase 3, we trust the signal if budget allows.
    // We assume 'MaxMonthlySpend' is a token amount.
    // Let's convert max spend to a "max replication factor" for simplicity, 
    // or just check if we haven't hit a hard cap (e.g. 5 stripes).
    
    currentStripes := deal.CurrentReplication / types.DealBaseReplication
    if currentStripes >= 5 {
         return nil, sdkerrors.ErrInvalidRequest.Wrapf("deal %d has reached maximum elasticity (5 stripes)", msg.DealId)
    }
    
    // 4. Assign New "Hot" Stripe
    blockHash := ctx.BlockHeader().LastBlockId.Hash
    // Use a derived ID for seeding to get different providers: DealID + StripeIndex
    derivedID := deal.Id + (deal.CurrentReplication * 1000) 
    
    newProviders, err := k.AssignProviders(ctx, derivedID, blockHash, "Hot", types.DealBaseReplication)
    if err != nil {
        return nil, fmt.Errorf("failed to assign new hot stripe: %w", err)
    }

    // 5. Update Deal State
    deal.Providers = append(deal.Providers, newProviders...)
    deal.CurrentReplication += types.DealBaseReplication
    
    if err := k.Deals.Set(ctx, deal.Id, deal); err != nil {
        return nil, fmt.Errorf("failed to update deal with new stripe: %w", err)
    }

    // 6. Emit Event
    ctx.EventManager().EmitEvent(
        sdk.NewEvent(
            types.TypeMsgSignalSaturation,
            sdk.NewAttribute(types.AttributeKeyDealID, fmt.Sprintf("%d", deal.Id)),
            sdk.NewAttribute("new_stripe_index", fmt.Sprintf("%d", currentStripes + 1)),
            sdk.NewAttribute("new_providers", fmt.Sprintf("%v", newProviders)),
        ),
    )

	return &types.MsgSignalSaturationResponse{
		Success: true,
		Message: fmt.Sprintf("Saturation processed. New stripe added (index %d).", currentStripes + 1),
		NewProviders: newProviders,
	}, nil
}
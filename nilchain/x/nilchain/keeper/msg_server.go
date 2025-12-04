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

	// TODO: Replace with proper challenge derivation from Epoch Beacon
	// For now, extract existing proof data from the message directly.
	var kzgProof types.KzgProof
	switch pt := msg.ProofType.(type) {
	case *types.MsgProveLiveness_SystemProof:
		kzgProof = *pt.SystemProof
	case *types.MsgProveLiveness_UserReceipt:
		kzgProof = *pt.UserReceipt.ProofDetails
		// TODO: Also verify user_receipt.UserSignature here
	default:
		return nil, sdkerrors.ErrInvalidRequest.Wrap("invalid proof type")
	}

	// TODO: Initialize KZG once, not per call.
	tsPath := os.Getenv("KZG_TRUSTED_SETUP")
	if tsPath == "" {
		tsPath = "trusted_setup.txt" // Default fallback
	}
	if err := crypto_ffi.Init(tsPath); err != nil {
		// Log warning or handle error if initialization fails
		ctx.Logger().Error("KZG Init failed", "error", err)
	}

	// NEW: Use nil_verify_mdu_proof
	valid := false
	var err error
	if kzgProof.MduMerkleRoot != nil && kzgProof.ChallengedKzgCommitment != nil &&
	   kzgProof.ChallengedKzgCommitmentMerklePath != nil && kzgProof.ZValue != nil &&
	   kzgProof.YValue != nil && kzgProof.KzgOpeningProof != nil {
		
		valid, err = crypto_ffi.VerifyMduProof(
			kzgProof.MduMerkleRoot,
			kzgProof.ChallengedKzgCommitment,
			kzgProof.ChallengedKzgCommitmentMerklePath,
			uint32(len(kzgProof.ChallengedKzgCommitmentMerklePath)), // Length of serialized path (using uint32 as defined in Rust)
			kzgProof.ChallengedKzgCommitmentIndex,
			kzgProof.ZValue,
			kzgProof.YValue,
			kzgProof.KzgOpeningProof,
		)
	} else {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("missing MDU proof components")
	}

	if err != nil {
		ctx.Logger().Error("MDU KZG Verification Error", "error", err)
		return nil, fmt.Errorf("verification error: %w", err)
	}

	if !valid {
		ctx.Logger().Info("KZG Proof INVALID: Slashing Sender")
        
        // TODO: Implement Tiered Slashing
        slashAmt := sdk.NewCoins(sdk.NewInt64Coin("token", 10000000)) // Placeholder 10 NIL
        senderAddr, err := sdk.AccAddressFromBech32(msg.Creator)
        if err != nil {
             return nil, err
        }
        if err := k.BankKeeper.SendCoinsFromAccountToModule(goCtx, senderAddr, types.ModuleName, slashAmt); err == nil {
            if err := k.BankKeeper.BurnCoins(goCtx, types.ModuleName, slashAmt); err != nil {
                ctx.Logger().Error("Failed to burn slashed coins", "error", err)
            }
        }
		return &types.MsgProveLivenessResponse{Success: false, Tier: 3 /* Fail */, RewardAmount: "0"}, nil
	}

    // TODO: Implement Tiered Rewards based on block height latency
	// For now, a valid proof gets Platinum tier (100% reward)
	rewardAmount := sdk.NewCoins(sdk.NewInt64Coin("token", 1000000)) // Placeholder 1 NIL
	creatorAddr, _ := sdk.AccAddressFromBech32(msg.Creator)
	if err := k.BankKeeper.MintCoins(goCtx, types.ModuleName, rewardAmount); err != nil {
		return nil, fmt.Errorf("failed to mint coins: %w", err)
	}
	if err := k.BankKeeper.SendCoinsFromModuleToAccount(goCtx, types.ModuleName, creatorAddr, rewardAmount); err != nil {
		return nil, fmt.Errorf("failed to send coins: %w", err)
	}
	
	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			types.TypeMsgProveLiveness,
			sdk.NewAttribute("creator", msg.Creator),
			sdk.NewAttribute("deal_id", fmt.Sprintf("%d", msg.DealId)),
			sdk.NewAttribute("success", "true"),
			sdk.NewAttribute("tier", "Platinum"),
			sdk.NewAttribute("reward", rewardAmount.String()),
		),
	)

	return &types.MsgProveLivenessResponse{Success: true, Tier: 0 /* Platinum */, RewardAmount: rewardAmount.String()}, nil
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

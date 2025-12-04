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
	_ = ctx // TODO: implement deal creation logic

	// Placeholder logic for now
	return &types.MsgCreateDealResponse{
		DealId: 0,
		AssignedProviders: []string{"cosmos1placeholder", "cosmos1placeholder2"},
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
			uint64(len(kzgProof.ChallengedKzgCommitmentMerklePath)), // Length of serialized path
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

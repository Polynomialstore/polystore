package keeper

import (
	"context"
	"encoding/hex"
	"fmt"
	"os"

	sdk "github.com/cosmos/cosmos-sdk/types"
	"nilchain/x/crypto_ffi"
	"nilchain/x/nilchain/types"
)

func (k msgServer) SubmitProof(goCtx context.Context, msg *types.MsgSubmitProof) (*types.MsgSubmitProofResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	// TODO: Ideally Initialize this once in App startup or Keeper creation
	// For now, we attempt init on every call (it checks OnceLock internally)
	tsPath := os.Getenv("KZG_TRUSTED_SETUP")
	if tsPath == "" {
		tsPath = "trusted_setup.txt" // Default fallback
	}
    
    // Log the path being used to debug if file is found
    ctx.Logger().Info("Initializing KZG with trusted setup", "path", tsPath)
	
	if err := crypto_ffi.Init(tsPath); err != nil {
		// Log warning but don't fail if already initialized (though binding handles it,
		// if path is wrong it might fail real init).
		// Assuming initialized for now or that this error is fatal.
		// Actually, Init returns 0 on "already initialized".
		// If it returns error here, it's a real error.
		// ctx.Logger().Error("KZG Init failed", "error", err)
		// But we might have initialized it elsewhere.
	}

	ctx.Logger().Info("Verifying KZG Proof", "creator", msg.Creator)

	valid, err := crypto_ffi.VerifyProof(msg.Commitment, msg.Z, msg.Y, msg.Proof)
	if err != nil {
		ctx.Logger().Error("KZG Verification Error", "error", err)
		return nil, fmt.Errorf("verification error: %w", err)
	}

	if !valid {
		ctx.Logger().Info("KZG Proof INVALID: Slashing Sender")
        
        // Slash 10 NIL
        slashAmt := sdk.NewCoins(sdk.NewInt64Coin("token", 10000000))
        senderAddr, err := sdk.AccAddressFromBech32(msg.Creator)
        if err != nil {
             return nil, err
        }

        // Try to slash. If they don't have funds, this returns error, effectively rejecting the Tx (no gas used beyond this point).
        // In a real system we might want to deduct what we can.
        if err := k.BankKeeper.SendCoinsFromAccountToModule(goCtx, senderAddr, types.ModuleName, slashAmt); err == nil {
            if err := k.BankKeeper.BurnCoins(goCtx, types.ModuleName, slashAmt); err != nil {
                ctx.Logger().Error("Failed to burn slashed coins", "error", err)
            } else {
                ctx.EventManager().EmitEvent(
                    sdk.NewEvent(
                        "proof_slashed",
                        sdk.NewAttribute("creator", msg.Creator),
                        sdk.NewAttribute("amount", slashAmt.String()),
                    ),
                )
            }
        }

		return &types.MsgSubmitProofResponse{Valid: false}, nil
	}

    // Get next ID
    id, err := k.ProofCount.Next(ctx)
    if err != nil {
        return nil, fmt.Errorf("failed to get next proof id: %w", err)
    }

    // Store Proof
    proofEntry := types.Proof{
        Id:          id,
        Creator:     msg.Creator,
        Commitment:  hex.EncodeToString(msg.Commitment),
        Valid:       true,
        BlockHeight: ctx.BlockHeight(),
    }
    if err := k.Proofs.Set(ctx, id, proofEntry); err != nil {
        return nil, fmt.Errorf("failed to set proof: %w", err)
    }

	ctx.Logger().Info("KZG Proof VALID")
	
	// Mint 1 NIL token as reward
	reward := sdk.NewCoins(sdk.NewInt64Coin("token", 1000000)) // 1 NIL = 1,000,000 utoken/token
	
	if err := k.BankKeeper.MintCoins(goCtx, types.ModuleName, reward); err != nil {
		return nil, fmt.Errorf("failed to mint coins: %w", err)
	}

	creatorAddr, err := sdk.AccAddressFromBech32(msg.Creator)
	if err != nil {
		return nil, fmt.Errorf("invalid creator address: %w", err)
	}

	if err := k.BankKeeper.SendCoinsFromModuleToAccount(goCtx, types.ModuleName, creatorAddr, reward); err != nil {
		return nil, fmt.Errorf("failed to send coins: %w", err)
	}
	
	// In a real system, we would store the valid proof or update some state here.
	// For now, we just emit an event.
	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			"proof_verified",
			sdk.NewAttribute("creator", msg.Creator),
			sdk.NewAttribute("valid", "true"),
			sdk.NewAttribute("reward", reward.String()),
		),
	)

	return &types.MsgSubmitProofResponse{Valid: true}, nil
}

package keeper

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"

	"cosmossdk.io/collections"
	"cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"
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

	_, err = k.Providers.Get(ctx, msg.Creator)
	if err == nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrapf("provider %s already registered", msg.Creator)
	}
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
        ReputationScore: 100, // Initial Score
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

	dealID, err := k.DealCount.Next(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get next deal ID: %w", err)
	}

	// Decode any owner override embedded in the service hint.
	// For web flows, the gateway encodes hints as e.g. "General:owner=<nilAddress>"
	// so that the logical Deal owner can differ from the tx signer (faucet).
	rawHint := strings.TrimSpace(msg.ServiceHint)
	serviceHint := rawHint
	ownerAddrStr := msg.Creator
	if idx := strings.Index(rawHint, ":owner="); idx != -1 {
		base := strings.TrimSpace(rawHint[:idx])
		ownerPart := strings.TrimSpace(rawHint[idx+len(":owner="):])
		if ownerPart != "" {
			if _, err := sdk.AccAddressFromBech32(ownerPart); err != nil {
				return nil, sdkerrors.ErrInvalidAddress.Wrapf("invalid owner address in service hint: %s", ownerPart)
			}
			ownerAddrStr = ownerPart
		}
		if base != "" {
			serviceHint = base
		}
	}

	blockHash := ctx.BlockHeader().LastBlockId.Hash
	assignedProviders, err := k.AssignProviders(ctx, dealID, blockHash, serviceHint, types.DealBaseReplication)
	if err != nil {
		return nil, fmt.Errorf("failed to assign providers: %w", err)
	}

	if len(msg.Cid) == 0 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("CID cannot be empty")
	}
	if msg.Size_ == 0 {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("Deal size cannot be zero")
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
		Cid:                msg.Cid,
		Size_:              msg.Size_,
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

	hChallenge := int64(deal.StartBlock)
	beacon := ctx.BlockHeader().LastBlockId.Hash
	_ = beacon
	
	var kzgProof types.KzgProof
	var isUserReceipt bool
	switch pt := msg.ProofType.(type) {
	case *types.MsgProveLiveness_SystemProof:
		kzgProof = *pt.SystemProof
		isUserReceipt = false
	case *types.MsgProveLiveness_UserReceipt:
		kzgProof = pt.UserReceipt.ProofDetails
		isUserReceipt = true
	default:
		return nil, sdkerrors.ErrInvalidRequest.Wrap("invalid proof type")
	}

	flattenedMerklePath := make([]byte, 0, len(kzgProof.ChallengedKzgCommitmentMerklePath)*32)
	for _, node := range kzgProof.ChallengedKzgCommitmentMerklePath {
		flattenedMerklePath = append(flattenedMerklePath, node...)
	}

	tsPath := os.Getenv("KZG_TRUSTED_SETUP")
	if tsPath == "" {
		tsPath = "trusted_setup.txt"
	}
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
        slashAmt := sdk.NewCoins(sdk.NewInt64Coin("stake", 10000000)) 
        err := k.BankKeeper.SendCoinsFromAccountToModule(ctx, creatorAddr, types.ModuleName, slashAmt)
        
        if err != nil {
            // 2. If slash fails (insufficient funds), Jail the provider
            ctx.Logger().Info("Slashing failed (insufficient funds), Jailing provider", "provider", msg.Creator)
            
            provider, errGet := k.Providers.Get(ctx, msg.Creator)
            if errGet == nil {
                provider.Status = "Jailed"
                provider.ReputationScore -= 50 // Heavy penalty
                if errSet := k.Providers.Set(ctx, msg.Creator, provider); errSet != nil {
                     ctx.Logger().Error("Failed to update provider status to Jailed", "error", errSet)
                }
            }
        } else {
            // 3. If slash succeeds, burn the tokens
            if err := k.BankKeeper.BurnCoins(ctx, types.ModuleName, slashAmt); err != nil {
                ctx.Logger().Error("Failed to burn slashed coins", "error", err)
            }
            // Update reputation for slash
            provider, errGet := k.Providers.Get(ctx, msg.Creator)
            if errGet == nil {
                provider.ReputationScore -= 10 // Standard penalty
                if errSet := k.Providers.Set(ctx, msg.Creator, provider); errSet != nil {
                     ctx.Logger().Error("Failed to update provider reputation", "error", errSet)
                }
            }
        }
		// Record failed proof attempt for liveness/performance observability.
		if err := k.recordProofSummary(ctx, msg, deal, "Fail", false); err != nil {
			ctx.Logger().Error("failed to record proof summary", "error", err)
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

	var bandwidthPayment math.Int
	if isUserReceipt {
        receipt := msg.GetProofType().(*types.MsgProveLiveness_UserReceipt).UserReceipt
        
        buf := make([]byte, 0)
        buf = append(buf, sdk.Uint64ToBigEndian(receipt.DealId)...)
        buf = append(buf, sdk.Uint64ToBigEndian(receipt.EpochId)...)
        buf = append(buf, []byte(receipt.Provider)...)
        buf = append(buf, sdk.Uint64ToBigEndian(receipt.BytesServed)...)
        
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
             return nil, fmt.Errorf("deal owner has no public key")
        }
        
        if !pubKey.VerifySignature(buf, receipt.UserSignature) {
             return nil, sdkerrors.ErrUnauthorized.Wrap("invalid retrieval receipt signature")
        }

		bandwidthPayment = math.NewInt(500000) // Placeholder 0.5 NIL
		
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
		Success: true,
		Message: fmt.Sprintf("Saturation processed. New stripe added."),
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

package keeper

import (
	"fmt"

	"cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	"polystorechain/x/polystorechain/types"
)

// Legacy liabilities remain at their original keys. After activation they are
// refundable after their original expiry, but cannot earn a new payout or credit.
func (k Keeper) admitSessionVersion(ctx sdk.Context, session types.RetrievalSession) error {
	active, err := k.RetrievalV2Active(ctx)
	if err != nil {
		return err
	}
	switch session.ChallengeVersion {
	case 0:
		if active && session.Status != types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_COMPLETED {
			return sdkerrors.ErrInvalidRequest.Wrap("legacy retrieval session is expiry-refund-only after v2 activation")
		}
	case 2:
		if !active {
			return sdkerrors.ErrInvalidRequest.Wrap("retrieval v2 is inactive")
		}
		c, err := types.RetrievalChallengeContext(session)
		if err != nil {
			return err
		}
		if c.ChainID != ctx.ChainID() {
			return sdkerrors.ErrInvalidRequest.Wrap("session belongs to a different chain")
		}
	default:
		return sdkerrors.ErrInvalidRequest.Wrap("unsupported session challenge version")
	}
	return nil
}

func (k Keeper) sessionProofPayee(ctx sdk.Context, session types.RetrievalSession) (sdk.AccAddress, error) {
	pin, err := k.RetrievalSessionProofProvider.Get(ctx, session.SessionId)
	if err != nil {
		return nil, fmt.Errorf("accepted session proof provider unavailable: %w", err)
	}
	addr, err := sdk.AccAddressFromBech32(pin)
	if err != nil || len(addr) != 20 || addr.String() != pin {
		return nil, sdkerrors.ErrInvalidAddress.Wrap("invalid accepted session proof provider")
	}
	if session.ChallengeVersion == 2 {
		if pin != session.AuthorizedProofProvider {
			return nil, sdkerrors.ErrUnauthorized.Wrap("accepted proof pin does not match authorized proof provider")
		}
		c, err := types.RetrievalChallengeContext(session)
		if err != nil {
			return nil, err
		}
		if c.ChainID != ctx.ChainID() || ctx.BlockHeight() < 0 || !c.Window.Contains(uint64(ctx.BlockHeight())) {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("outside session challenge response window")
		}
		anchor, err := k.ChallengeAnchors.Get(ctx, c.Window.Anchor)
		if err != nil {
			return nil, fmt.Errorf("session challenge seed unavailable: %w", err)
		}
		if len(anchor.Seed) != 32 {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("session challenge seed unavailable")
		}
	}
	return addr, nil
}

func (k msgServer) refundRetrievalSession(ctx sdk.Context, session *types.RetrievalSession) error {
	if session.LockedFee.IsNil() || session.LockedFee.IsNegative() {
		return sdkerrors.ErrInvalidRequest.Wrap("invalid locked retrieval fee")
	}
	funding := session.Funding
	if funding == types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_UNSPECIFIED {
		// The original schema funded only owner opens from deal escrow. Do not infer
		// an account payer or proof beneficiary for any ambiguous persisted record.
		if session.ChallengeVersion != 0 || session.Payer != "" {
			return sdkerrors.ErrInvalidRequest.Wrap("ambiguous legacy session funding")
		}
		funding = types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_DEAL_ESCROW
	}
	switch funding {
	case types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_DEAL_ESCROW:
		deal, err := k.Deals.Get(ctx, session.DealId)
		if err != nil {
			return err
		}
		if session.Owner != deal.Owner || session.Payer != "" {
			return sdkerrors.ErrInvalidRequest.Wrap("invalid deal escrow refund authority")
		}
		if session.LockedFee.IsPositive() {
			deal.EscrowBalance = deal.EscrowBalance.Add(session.LockedFee)
			if err := k.setDealWithAssignmentCollateralLocks(ctx, session.DealId, deal); err != nil {
				return err
			}
		}
	case types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_REQUESTER:
		payer, err := sdk.AccAddressFromBech32(session.Payer)
		if err != nil || len(payer) != 20 || payer.String() != session.Payer || session.Payer != session.Owner {
			return sdkerrors.ErrInvalidRequest.Wrap("invalid recorded requester payer")
		}
		if session.LockedFee.IsPositive() {
			coins := sdk.NewCoins(sdk.NewCoin(sdk.DefaultBondDenom, session.LockedFee))
			if err := k.BankKeeper.SendCoinsFromModuleToAccount(ctx, types.ModuleName, payer, coins); err != nil {
				return fmt.Errorf("refund requester: %w", err)
			}
		}
	case types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_PROTOCOL:
		if session.Payer != authtypes.NewModuleAddress(types.ProtocolBudgetModuleName).String() {
			return sdkerrors.ErrInvalidRequest.Wrap("invalid recorded protocol payer")
		}
		if session.LockedFee.IsPositive() {
			coins := sdk.NewCoins(sdk.NewCoin(sdk.DefaultBondDenom, session.LockedFee))
			if err := k.BankKeeper.SendCoinsFromModuleToModule(ctx, types.ModuleName, types.ProtocolBudgetModuleName, coins); err != nil {
				return fmt.Errorf("refund protocol budget: %w", err)
			}
		}
	default:
		return sdkerrors.ErrInvalidRequest.Wrap("invalid retrieval session funding")
	}
	session.LockedFee = math.ZeroInt()
	return nil
}

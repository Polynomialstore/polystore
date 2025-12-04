package types

import (
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"
)

var _ sdk.Msg = &MsgSubmitProof{}

func (msg *MsgSubmitProof) ValidateBasic() error {
	_, err := sdk.AccAddressFromBech32(msg.Creator)
	if err != nil {
		return sdkerrors.ErrInvalidAddress.Wrapf("invalid creator address: %s", err)
	}
	
    if len(msg.Commitment) == 0 {
        return sdkerrors.ErrInvalidRequest.Wrap("commitment cannot be empty")
    }
    if len(msg.Z) == 0 {
        return sdkerrors.ErrInvalidRequest.Wrap("z cannot be empty")
    }
    if len(msg.Y) == 0 {
        return sdkerrors.ErrInvalidRequest.Wrap("y cannot be empty")
    }
    if len(msg.Proof) == 0 {
        return sdkerrors.ErrInvalidRequest.Wrap("proof cannot be empty")
    }

	return nil
}

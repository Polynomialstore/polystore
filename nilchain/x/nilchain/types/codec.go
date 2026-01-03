package types

import (
	codectypes "github.com/cosmos/cosmos-sdk/codec/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/cosmos-sdk/types/msgservice"
)

func RegisterInterfaces(registrar codectypes.InterfaceRegistry) {
	registrar.RegisterImplementations((*sdk.Msg)(nil),
		&MsgUpdateParams{},
		&MsgRegisterProvider{},
		&MsgCreateDeal{},
		&MsgUpdateDealContent{},
		&MsgCreateDealFromEvm{},
		&MsgUpdateDealContentFromEvm{},
		&MsgOpenRetrievalSession{},
		&MsgConfirmRetrievalSession{},
		&MsgCancelRetrievalSession{},
		&MsgSubmitRetrievalSessionProof{},
		&MsgProveLiveness{},
		&MsgSignalSaturation{},
		&MsgStartSlotRepair{},
		&MsgCompleteSlotRepair{},
		&MsgAddCredit{},
		&MsgWithdrawRewards{},
	)
	msgservice.RegisterMsgServiceDesc(registrar, &_Msg_serviceDesc)
}

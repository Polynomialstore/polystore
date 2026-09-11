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
		&MsgAddProviderBond{},
		&MsgWithdrawProviderBond{},
		&MsgClaimProviderBondWithdrawal{},
		&MsgBindProviderStake{},
		&MsgUnbindProviderStake{},
		&MsgSetProviderDraining{},
		&MsgUpdateProviderEndpoints{},
		&MsgRequestProviderLink{},
		&MsgApproveProviderLink{},
		&MsgCancelProviderLink{},
		&MsgUnpairProvider{},
		&MsgCreateDeal{},
		&MsgUpdateDealContent{},
		&MsgProposeDealGenerationV3{},
		&MsgAcceptDealGenerationV3{},
		&MsgFinalizeDealGenerationV3{},
		&MsgBumpDealSetupSlot{},
		&MsgCreateDealFromEvm{},
		&MsgUpdateDealContentFromEvm{},
		&MsgOpenRetrievalSession{},
		&MsgConfirmRetrievalSession{},
		&MsgCancelRetrievalSession{},
		&MsgSubmitRetrievalSessionProof{},
		&MsgOpenRetrievalSessionV3{},
		&MsgOpenRetrievalSessionV3Sponsored{},
		&MsgSubmitRetrievalSessionProofV3{},
		&MsgSubmitRetrievalSessionProofBatchV3{},
		&MsgAcknowledgeRetrievalObligationV3{},
		&MsgRefundRetrievalSessionV3{},
		&MsgProveLiveness{},
		&MsgSignalSaturation{},
		&MsgStartSlotRepair{},
		&MsgCompleteSlotRepair{},
		&MsgAddCredit{},
		&MsgExtendDeal{},
		&MsgWithdrawRewards{},
	)
	msgservice.RegisterMsgServiceDesc(registrar, &_Msg_serviceDesc)
}
